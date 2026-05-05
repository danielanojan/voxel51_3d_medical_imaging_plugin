"""
NIfTI Slice Viewer — Python backend

Operators:
  get_slice_viewer_config  → dataset config (views, mask classes, field names)
  list_slice_samples       → samples in current view/filter
  load_slice               → single composited slice as base64 JPEG
  load_slice_batch         → batch of slices (one per sample, same frame)

Config is read from dataset.info["slice_viewer"]; falls back to BraTS defaults
so existing datasets work without modification.

Example custom config:
  dataset.info["slice_viewer"] = {
      "slices_dir_field": "slices_dir",
      "masks_dir_field":  "masks_dir",
      "num_slices_field": "num_slices",
      "mask_classes": [
          {"name": "tumor", "value": 1, "color": [255, 0, 0]},
      ],
  }
  dataset.save()
"""

import base64
import io
import os
import threading
from functools import lru_cache

import numpy as np
from PIL import Image

import fiftyone.operators as foo
import fiftyone.operators.types as types
import fiftyone.server.view as fosv


OVERLAY_ALPHA = 0.55
ENCODE_MAX_DIM = 240

_DEFAULT_CONFIG = {
    "slices_dir_field": "slices_dir",
    "masks_dir_field":  "masks_dir",
    "num_slices_field": "num_slices",
    "mask_classes": [
        {"name": "ncr", "value": 1, "color": [255,  68,  68]},
        {"name": "ed",  "value": 2, "color": [255, 165,   0]},
        {"name": "et",  "value": 3, "color": [255,   0, 255]},
    ],
}

_FALLBACK_COLORS = [
    [255,  68,  68], [255, 165,   0], [255,   0, 255],
    [  0, 200, 255], [  0, 255, 128], [255, 255,   0],
]


def _get_plugin_config(dataset):
    info = getattr(dataset, "info", None) or {}
    cfg = dict(_DEFAULT_CONFIG)
    cfg.update(info.get("slice_viewer", {}))
    # ensure every mask class has a color (dataset.info may omit it)
    for i, cls in enumerate(cfg.get("mask_classes", [])):
        if "color" not in cls:
            cls["color"] = _FALLBACK_COLORS[i % len(_FALLBACK_COLORS)]
    return cfg


# ── File reading (cached) ──────────────────────────────────────────────────────
# maxsize=2048: covers ~8 patients × 256 slices for smooth scrubbing

@lru_cache(maxsize=2048)
def _read_slice_png(path):
    if not os.path.exists(path):
        return None
    return np.asarray(Image.open(path).convert("L"), dtype=np.uint8)


@lru_cache(maxsize=2048)
def _read_mask_png(path):
    if not os.path.exists(path):
        return None
    return np.asarray(Image.open(path).convert("L"), dtype=np.uint8)


# ── Compositing ────────────────────────────────────────────────────────────────
# Layers 1 & 2 cache the raw disk reads. Everything above that (stack, overlay,
# encode) is ~4ms total and not worth the memory cost of caching intermediates.

def _render_slice(slices_dir, masks_dir, frame_idx, mask_config):
    slice_path = os.path.join(slices_dir, f"frame_{frame_idx:04d}.png")
    base_gray = _read_slice_png(slice_path)
    if base_gray is None:
        return None

    out = np.stack([base_gray] * 3, axis=-1).astype(np.float32)

    mask_path = os.path.join(masks_dir, f"frame_{frame_idx:04d}_mask.png")
    mask = _read_mask_png(mask_path)
    if mask is not None:
        for _name, pixel_value, r, g, b, enabled in mask_config:
            if not enabled:
                continue
            on = mask == pixel_value
            if not on.any():
                continue
            out[on] = (1.0 - OVERLAY_ALPHA) * out[on] + OVERLAY_ALPHA * np.array([r, g, b], dtype=np.float32)

    img = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")
    w, h = img.size
    if max(w, h) > ENCODE_MAX_DIM:
        scale = ENCODE_MAX_DIM / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88, optimize=True)
    return f"data:image/jpeg;base64,{base64.b64encode(buf.getvalue()).decode('ascii')}"


# ── Prefetch ───────────────────────────────────────────────────────────────────

def _prefetch(dirs_list, frame, radius=3):
    """Warm layers 1 & 2 for adjacent frames in a background thread."""
    def _warm():
        for slices_dir, masks_dir, num_slices in dirs_list:
            lo = max(0, frame - radius)
            hi = min(num_slices - 1, frame + radius) if num_slices else frame + radius
            for f in range(lo, hi + 1):
                _read_slice_png(os.path.join(slices_dir, f"frame_{f:04d}.png"))
                _read_mask_png(os.path.join(masks_dir, f"frame_{f:04d}_mask.png"))
    threading.Thread(target=_warm, daemon=True).start()


# ── Helpers ────────────────────────────────────────────────────────────────────

def _get_sample_dirs(dataset, sample_id, config):
    try:
        sample = dataset[sample_id]
    except Exception:
        return None
    slices_dir = sample.get_field(config["slices_dir_field"])
    masks_dir  = sample.get_field(config["masks_dir_field"])
    num_slices = sample.get_field(config["num_slices_field"])
    if not slices_dir or not masks_dir:
        return None
    return slices_dir, masks_dir, int(num_slices or 0)


def _build_mask_config(mask_classes, mask_flags):
    """Hashable tuple of (name, pixel_value, r, g, b, enabled) per mask class."""
    return tuple(
        (
            cls["name"],
            cls["value"],
            cls["color"][0], cls["color"][1], cls["color"][2],
            bool(mask_flags.get(cls["name"], True)),
        )
        for cls in mask_classes
    )


def _serialize(v):
    if v is None or isinstance(v, (bool, int, float, dict)):
        return v
    if isinstance(v, (list, tuple)):
        return [_serialize(i) for i in v]
    return str(v)


# ── Operator: config ───────────────────────────────────────────────────────────

class GetSliceViewerConfig(foo.Operator):
    @property
    def config(self):
        return foo.OperatorConfig(
            name="get_slice_viewer_config",
            label="Get slice viewer config",
            unlisted=True,
            execute_as_generator=False,
        )

    def resolve_input(self, ctx):
        return types.Property(types.Object())

    def execute(self, ctx):
        cfg = _get_plugin_config(ctx.dataset)
        is_grouped = getattr(ctx.dataset, "media_type", None) == "group"
        views = list(ctx.dataset.group_slices) if is_grouped else []
        return {
            "ok": True,
            "is_grouped": is_grouped,
            "views": views,
            "mask_classes": cfg["mask_classes"],
            "fields": {
                "slices_dir": cfg["slices_dir_field"],
                "masks_dir":  cfg["masks_dir_field"],
                "num_slices": cfg["num_slices_field"],
            },
        }


# ── Operator: list samples ─────────────────────────────────────────────────────

class ListSliceSamples(foo.Operator):
    @property
    def config(self):
        return foo.OperatorConfig(
            name="list_slice_samples",
            label="List slice samples",
            unlisted=True,
            execute_as_generator=False,
        )

    def resolve_input(self, ctx):
        return types.Property(types.Object())

    def execute(self, ctx):
        view_filter = ctx.params.get("view")
        is_grouped  = getattr(ctx.dataset, "media_type", None) == "group"

        if is_grouped and view_filter:
            try:
                # ctx.view already has App sidebar filters applied (scoped to the
                # default group slice). Bridge to the target slice via group IDs so
                # filters propagate correctly across axial/coronal/sagittal.
                group_ids = ctx.view.distinct("group.id")
                sample_collection = (
                    ctx.dataset
                    .select_group_slices([view_filter])
                    .select_groups(group_ids)
                )
            except Exception:
                sample_collection = ctx.dataset.select_group_slices([view_filter])
        else:
            try:
                sample_collection = fosv.get_extended_view(
                    ctx.dataset,
                    filters=ctx.request_params.get("filters"),
                    extended_stages=ctx.request_params.get("extended"),
                )
            except Exception:
                sample_collection = ctx.dataset

        _SKIP = {"_id", "frames", "id", "group"}

        def _sample_to_dict(s):
            group = getattr(s, "group", None)
            d = {"id": str(s.id), "group_id": str(group.id) if group else ""}
            for field in s.field_names:
                if field in _SKIP:
                    continue
                d[field] = _serialize(getattr(s, field, None))
            return d

        return {"ok": True, "samples": [_sample_to_dict(s) for s in sample_collection]}


# ── Operator: single slice ─────────────────────────────────────────────────────

class LoadSlice(foo.Operator):
    @property
    def config(self):
        return foo.OperatorConfig(
            name="load_slice",
            label="Load slice",
            unlisted=True,
            execute_as_generator=False,
        )

    def resolve_input(self, ctx):
        return types.Property(types.Object())

    def execute(self, ctx):
        params     = ctx.params
        sample_id  = params.get("sample_id")
        frame      = int(params.get("frame", 0))
        mask_flags = params.get("mask_flags", {}) or {}

        if sample_id is None:
            return {"ok": False, "error": "sample_id required"}

        cfg = _get_plugin_config(ctx.dataset)
        dirs = _get_sample_dirs(ctx.dataset, sample_id, cfg)
        if dirs is None:
            return {"ok": False, "error": f"sample {sample_id} missing required dirs"}

        slices_dir, masks_dir, num_slices = dirs
        frame = max(0, min(frame, num_slices - 1)) if num_slices else frame

        mask_config = _build_mask_config(cfg["mask_classes"], mask_flags)
        data_url = _render_slice(slices_dir, masks_dir, frame, mask_config)
        if data_url is None:
            return {"ok": False, "error": f"frame {frame} not found"}

        return {"ok": True, "sample_id": sample_id, "frame": frame,
                "num_slices": num_slices, "image": data_url}


# ── Operator: batch of slices ──────────────────────────────────────────────────

class LoadSliceBatch(foo.Operator):
    @property
    def config(self):
        return foo.OperatorConfig(
            name="load_slice_batch",
            label="Load slice batch",
            unlisted=True,
            execute_as_generator=False,
        )

    def resolve_input(self, ctx):
        return types.Property(types.Object())

    def execute(self, ctx):
        params     = ctx.params
        sample_ids = params.get("sample_ids", []) or []
        frame      = int(params.get("frame", 0))
        mask_flags = params.get("mask_flags", {}) or {}

        cfg = _get_plugin_config(ctx.dataset)
        mask_config = _build_mask_config(cfg["mask_classes"], mask_flags)

        all_dirs = []
        results = []
        for sid in sample_ids:
            dirs = _get_sample_dirs(ctx.dataset, sid, cfg)
            if dirs is None:
                results.append({"sample_id": sid, "ok": False, "error": "missing dirs"})
                continue

            slices_dir, masks_dir, num_slices = dirs
            f = max(0, min(frame, num_slices - 1)) if num_slices else frame
            all_dirs.append((slices_dir, masks_dir, num_slices))

            data_url = _render_slice(slices_dir, masks_dir, f, mask_config)
            if data_url is None:
                results.append({"sample_id": sid, "ok": False, "error": f"frame {f} not found"})
                continue

            results.append({"sample_id": sid, "ok": True, "frame": f,
                            "num_slices": num_slices, "image": data_url})

        if all_dirs:
            _prefetch(all_dirs, frame)

        return {"ok": True, "results": results}


# ── Registration ───────────────────────────────────────────────────────────────

def register(p):
    p.register(GetSliceViewerConfig)
    p.register(ListSliceSamples)
    p.register(LoadSlice)
    p.register(LoadSliceBatch)
