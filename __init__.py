"""
BraTS Slice Viewer — Python backend

Exposes two operators:

  load_brats_slice
    Returns a single composited slice as base64 PNG.
    Params: sample_id (str), frame (int), show_ncr, show_ed, show_et (bool)

  load_brats_slice_batch
    Returns many composited slices in one round-trip (one per sample).
    Params: sample_ids (list[str]), frame (int), show_ncr, show_ed, show_et

The batch operator is what the panel calls on every slider tick: one request,
N images back. This is the key performance lever — if we issued one operator
call per tile per slider tick, scrubbing would stutter badly.

Slices are read from sample["slices_dir"] and masks from sample["masks_dir"]
(both set by the build_nifti_dataset.py pipeline).
"""

import base64
import io
import os
from copy import copy
from functools import lru_cache

import numpy as np
from PIL import Image

import fiftyone as fo
import fiftyone.operators as foo
import fiftyone.operators.types as types
import fiftyone.server.view as fosv


# ─────────────────────────────────────────────
# Overlay colors (RGB)
# ─────────────────────────────────────────────

MASK_COLORS = {
    "ncr": (255,  68,  68),    # red
    "ed":  (255, 165,   0),    # orange
    "et":  (255,   0, 255),    # magenta
}
MASK_VALUES = {
    "ncr": 1,
    "ed": 2,
    "et": 3,
}
OVERLAY_ALPHA = 0.55   # blend strength for tumor overlays


# ─────────────────────────────────────────────
# File reading (cached)
# ─────────────────────────────────────────────

@lru_cache(maxsize=2048)
def _read_slice_png(path):
    """Load a grayscale slice PNG as an (H, W) uint8 numpy array."""
    if not os.path.exists(path):
        return None
    img = Image.open(path).convert("L")
    return np.asarray(img, dtype=np.uint8)


@lru_cache(maxsize=4096)
def _read_mask_png(path):
    """Load a mask PNG as an (H, W) uint8 numpy array (0 = background)."""
    if not os.path.exists(path):
        return None
    img = Image.open(path).convert("L")
    return np.asarray(img, dtype=np.uint8)


# ─────────────────────────────────────────────
# Compositing
# ─────────────────────────────────────────────

def _composite_slice(slices_dir, masks_dir, frame_idx,
                     show_ncr, show_ed, show_et):
    """
    Load frame_{frame_idx:04d}.png from slices_dir and alpha-blend any
    requested masks over it. Return PIL.Image in RGB, or None if missing.
    """
    slice_path = os.path.join(slices_dir, f"frame_{frame_idx:04d}.png")
    base_gray = _read_slice_png(slice_path)
    if base_gray is None:
        return None

    # Promote grayscale → RGB float for compositing
    base_rgb = np.stack([base_gray] * 3, axis=-1).astype(np.float32)

    mask_path = os.path.join(masks_dir, f"frame_{frame_idx:04d}_mask.png")
    mask = _read_mask_png(mask_path)
    if mask is None:
        return Image.fromarray(np.clip(base_rgb, 0, 255).astype(np.uint8), "RGB")

    wanted = {"ncr": show_ncr, "ed": show_ed, "et": show_et}
    for class_name, enabled in wanted.items():
        if not enabled:
            continue
        on = mask == MASK_VALUES[class_name]
        if not on.any():
            continue

        color = np.array(MASK_COLORS[class_name], dtype=np.float32)
        # Alpha blend: out = (1-a) * base + a * color, only where mask is on
        base_rgb[on] = (
            (1.0 - OVERLAY_ALPHA) * base_rgb[on] + OVERLAY_ALPHA * color
        )

    return Image.fromarray(np.clip(base_rgb, 0, 255).astype(np.uint8), "RGB")


# Max dimension (px) to encode. Tiles are displayed at ≤420px;
# sending full 240px source images is fine — 2× display size gives
# crisp retina rendering while keeping payload small.
# Reduce to 180 for fastest loads at the cost of slight softness when zoomed in.
ENCODE_MAX_DIM = 240


def _image_to_data_url(img):
    """PIL.Image → 'data:image/jpeg;base64,...' string.

    JPEG instead of PNG: ~5× smaller payload (3–8 KB vs 15–40 KB per tile).
    Quality 88 preserves all clinically visible detail at tile sizes.
    Resize to ENCODE_MAX_DIM before encoding — tiles ≤240px display pixels
    perfectly and the payload shrinks proportionally to the area reduction.
    """
    w, h = img.size
    if max(w, h) > ENCODE_MAX_DIM:
        scale = ENCODE_MAX_DIM / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88, optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


@lru_cache(maxsize=8192)
def _composite_and_encode(slices_dir, masks_dir, frame_idx,
                          show_ncr, show_ed, show_et):
    """
    Composite + base64-encode a slice.  All arguments are hashable so the
    result is lru_cache-able.  Returns the data-URL string or None.

    Cache size 8192 covers ≈171 patients × 48 frames × 1 mask combo before
    eviction; revisited frames return in microseconds with no numpy work.
    """
    img = _composite_slice(slices_dir, masks_dir, frame_idx,
                           show_ncr, show_ed, show_et)
    if img is None:
        return None
    return _image_to_data_url(img)


# ─────────────────────────────────────────────
# Sample lookup
# ─────────────────────────────────────────────

def _get_sample_dirs(dataset, sample_id):
    """
    Fetch (slices_dir, masks_dir, num_slices) for a sample.
    Returns None if the sample is missing required fields.
    """
    try:
        sample = dataset[sample_id]
    except Exception:
        return None

    slices_dir = sample.get_field("slices_dir")
    masks_dir  = sample.get_field("masks_dir")
    num_slices = sample.get_field("num_slices")

    if not slices_dir or not masks_dir:
        return None
    return slices_dir, masks_dir, int(num_slices or 0)


def _get_matching_patient_ids(ctx):
    """
    Returns patient_ids from ctx.view in their current sort order.
    Preserves both sidebar filters and any active sort (SortBy / SortBySimilarity).
    Returns None if ctx.view is unavailable — treat as "no filter".

    We iterate rather than using distinct() because distinct() runs a MongoDB
    $group aggregation which discards sort order entirely.
    """
    view = getattr(ctx, "view", None)
    if view is None:
        return None
    try:
        seen = set()
        patient_ids = []
        for s in view.select_fields(["patient_id"]):
            pid = getattr(s, "patient_id", None)
            if pid and pid not in seen:
                seen.add(pid)
                patient_ids.append(pid)
        return patient_ids
    except Exception:
        return None


# ─────────────────────────────────────────────
# Operator: single slice
# ─────────────────────────────────────────────

class LoadBratsSlice(foo.Operator):
    @property
    def config(self):
        return foo.OperatorConfig(
            name="load_brats_slice",
            label="Load BraTS slice",
            unlisted=True,       # hidden from operator browser; called by panel
            execute_as_generator=False,
        )

    def resolve_input(self, ctx):
        # No user-facing form; this operator is invoked programmatically
        return types.Property(types.Object())

    def execute(self, ctx):
        params      = ctx.params
        sample_id   = params.get("sample_id")
        frame       = int(params.get("frame", 0))
        show_ncr    = bool(params.get("show_ncr", True))
        show_ed     = bool(params.get("show_ed",  True))
        show_et     = bool(params.get("show_et",  True))

        if sample_id is None:
            return {"ok": False, "error": "sample_id required"}

        dirs = _get_sample_dirs(ctx.dataset, sample_id)
        if dirs is None:
            return {"ok": False, "error": f"sample {sample_id} missing dirs"}

        slices_dir, masks_dir, num_slices = dirs
        frame = max(0, min(frame, num_slices - 1)) if num_slices else frame

        data_url = _composite_and_encode(
            slices_dir, masks_dir, frame,
            show_ncr, show_ed, show_et,
        )
        if data_url is None:
            return {"ok": False, "error": f"frame {frame} missing"}

        return {
            "ok": True,
            "sample_id": sample_id,
            "frame": frame,
            "num_slices": num_slices,
            "image": data_url,
            "show_ncr": show_ncr,
            "show_ed": show_ed,
            "show_et": show_et,
        }


# ─────────────────────────────────────────────
# Operator: batch of slices (one per sample, same frame index)
# ─────────────────────────────────────────────

class LoadBratsSliceBatch(foo.Operator):
    @property
    def config(self):
        return foo.OperatorConfig(
            name="load_brats_slice_batch",
            label="Load BraTS slice batch",
            unlisted=True,
            execute_as_generator=False,
        )

    def resolve_input(self, ctx):
        return types.Property(types.Object())

    def execute(self, ctx):
        params     = ctx.params
        sample_ids = params.get("sample_ids", []) or []
        frame      = int(params.get("frame", 0))
        show_ncr   = bool(params.get("show_ncr", True))
        show_ed    = bool(params.get("show_ed",  True))
        show_et    = bool(params.get("show_et",  True))

        results = []
        for sid in sample_ids:
            dirs = _get_sample_dirs(ctx.dataset, sid)
            if dirs is None:
                results.append({
                    "sample_id": sid, "ok": False,
                    "error": "missing dirs",
                })
                continue

            slices_dir, masks_dir, num_slices = dirs
            f = max(0, min(frame, num_slices - 1)) if num_slices else frame

            data_url = _composite_and_encode(
                slices_dir, masks_dir, f,
                show_ncr, show_ed, show_et,
            )
            if data_url is None:
                results.append({
                    "sample_id": sid, "ok": False,
                    "error": f"frame {f} missing",
                })
                continue

            results.append({
                "sample_id": sid,
                "ok":         True,
                "frame":      f,
                "num_slices": num_slices,
                "image":      data_url,
                "show_ncr":   show_ncr,
                "show_ed":    show_ed,
                "show_et":    show_et,
            })

        return {"ok": True, "results": results}


# ─────────────────────────────────────────────
# Operator: list samples by view
# ─────────────────────────────────────────────

class ListBratsSamples(foo.Operator):
    @property
    def config(self):
        return foo.OperatorConfig(
            name="list_brats_samples",
            label="List BraTS samples",
            unlisted=True,
            execute_as_generator=False,
        )

    def resolve_input(self, ctx):
        return types.Property(types.Object())

    def execute(self, ctx):
        view_filter = ctx.params.get("view", "axial")

        # Start from the target orientation only, then apply the same sidebar
        # filters and sort (extended stages) that are active in the main view.
        # This mirrors exactly what the native grid does:
        #   base view → apply filters → apply extended stages (sort, selection)
        # ctx.request_params carries "filters" and "extended" sent by the frontend.
        base = ctx.dataset.select_group_slices([view_filter])
        try:
            sample_collection = fosv.get_extended_view(
                base,
                filters=ctx.request_params.get("filters"),
                extended_stages=ctx.request_params.get("extended"),
            )
        except Exception:
            sample_collection = base

        # Only select fields that exist in this dataset's schema
        _schema = set(ctx.dataset.get_field_schema().keys())
        _desired = [
            "patient_id", "view", "tags",
            "filepath", "slices_dir", "masks_dir",
            "num_slices", "modality", "dataset_source",
            "axial_num_slices", "coronal_num_slices", "sagittal_num_slices",
            "has_seg", "has_ncr", "has_ed", "has_et",
            "masked_slice_count", "ncr_slice_count", "ed_slice_count", "et_slice_count",
            "created_at", "last_modified_at",
            "group",
        ]
        _select = [f for f in _desired if f in _schema]
        view = sample_collection.select_fields(_select)

        def _get(s, field, default=None):
            return getattr(s, field, default)

        samples = [
            {
                "id": str(s.id),
                "group_id": str(_get(s, "group", None).id) if _get(s, "group", None) else "",
                "patient_id": _get(s, "patient_id", ""),
                "view": _get(s, "view", ""),
                "filepath": _get(s, "filepath", ""),
                "slices_dir": _get(s, "slices_dir", ""),
                "masks_dir": _get(s, "masks_dir", ""),
                "modality": _get(s, "modality", ""),
                "dataset_source": _get(s, "dataset_source", ""),
                "tags": list(_get(s, "tags", None) or []),
                "created_at": str(_get(s, "created_at", "") or ""),
                "last_modified_at": str(_get(s, "last_modified_at", "") or ""),
                "num_slices": int(_get(s, "num_slices", 0) or 0),
                "axial_num_slices": int(_get(s, "axial_num_slices", 0) or 0),
                "coronal_num_slices": int(_get(s, "coronal_num_slices", 0) or 0),
                "sagittal_num_slices": int(_get(s, "sagittal_num_slices", 0) or 0),
                "has_seg": bool(_get(s, "has_seg", False)),
                "has_ncr": bool(_get(s, "has_ncr", False)),
                "has_ed": bool(_get(s, "has_ed", False)),
                "has_et": bool(_get(s, "has_et", False)),
                "masked_slice_count": int(_get(s, "masked_slice_count", 0) or 0),
                "ncr_slice_count": int(_get(s, "ncr_slice_count", 0) or 0),
                "ed_slice_count": int(_get(s, "ed_slice_count", 0) or 0),
                "et_slice_count": int(_get(s, "et_slice_count", 0) or 0),
            }
            for s in view
        ]
        return {"ok": True, "samples": samples}


# ─────────────────────────────────────────────
# Plugin registration
# ─────────────────────────────────────────────

def register(p):
    p.register(LoadBratsSlice)
    p.register(LoadBratsSliceBatch)
    p.register(ListBratsSamples)
