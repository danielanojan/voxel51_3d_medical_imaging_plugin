"""
__init__.py — NIfTI Niivue Plugin

Dataset convention (see README.md):
  nifti_path   — primary NIfTI volume path  (falls back to filepath)
  seg_path     — segmentation NIfTI path    (optional)
  mask_targets — {str(label_int): name}     (optional)
"""

import os
import threading
import urllib.parse
import fiftyone as fo
import fiftyone.operators as foo
import fiftyone.operators.types as types

FLASK_PORT    = 5152
_flask_thread = None
_NIFTI_EXTS   = (".nii.gz", ".nii")


def _start_flask():
    from flask import Flask, request, send_file
    import logging

    app = Flask(__name__)
    logging.getLogger("werkzeug").setLevel(logging.ERROR)

    @app.route("/nifti")
    def serve_nifti():
        path = request.args.get("path", "")
        if not path or not os.path.exists(path):
            return f"Not found: {path}", 404
        resp = send_file(path, mimetype="application/octet-stream",
                         as_attachment=False,
                         download_name=os.path.basename(path))
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Cache-Control"] = "public, max-age=3600"
        return resp

    @app.route("/health")
    def health():
        return "ok"

    app.run(host="0.0.0.0", port=FLASK_PORT, debug=False,
            use_reloader=False, threaded=True)


def _ensure_flask():
    global _flask_thread
    if _flask_thread and _flask_thread.is_alive():
        return
    _flask_thread = threading.Thread(target=_start_flask, daemon=True)
    _flask_thread.start()


def _nifti_url(filepath: str) -> str:
    if not filepath:
        return ""
    encoded = urllib.parse.quote(filepath, safe="")
    return f"http://localhost:{FLASK_PORT}/nifti?path={encoded}"


def _is_nifti(path) -> bool:
    return isinstance(path, str) and any(path.endswith(e) for e in _NIFTI_EXTS)


def _strip_nifti_ext(name: str) -> str:
    for ext in _NIFTI_EXTS:
        if name.endswith(ext):
            return name[: -len(ext)]
    return name


def _extract_label_nifti(seg_img, label_value: int, out_path: str) -> bool:
    """Extract a single binary label from a loaded seg image and cache it."""
    if os.path.exists(out_path):
        return True
    try:
        import nibabel as nib
        import numpy as np
        vol    = seg_img.get_fdata(dtype=np.float32)
        binary = (vol == label_value).astype(np.uint8)
        nib.save(nib.Nifti1Image(binary, seg_img.affine, seg_img.header), out_path)
        return True
    except Exception as e:
        print(f"[niivue] label {label_value} extract failed: {e}")
        return False


def _get_seg_overlays(seg_path: str, mask_targets: dict) -> list:
    """
    Read seg_path, discover non-zero labels, cache binary NIfTIs per label.
    Returns [{label, url}, ...] — 'All labels' entry first, then per-label.
    """
    if not seg_path or not os.path.exists(seg_path):
        return []
    try:
        import nibabel as nib
        import numpy as np
        seg_img       = nib.load(seg_path)
        seg_data      = seg_img.get_fdata(dtype=np.float32)
        unique_labels = sorted(int(v) for v in np.unique(seg_data) if v != 0)
    except Exception as e:
        print(f"[niivue] failed to read seg: {e}")
        return []

    seg_dir  = os.path.dirname(seg_path)
    seg_stem = _strip_nifti_ext(os.path.basename(seg_path))

    overlays = [{"label": "All labels", "url": _nifti_url(seg_path)}]

    for label_val in unique_labels:
        label_name = (mask_targets or {}).get(str(label_val), f"Label {label_val}")
        out_path   = os.path.join(seg_dir, f"{seg_stem}-label{label_val}.nii.gz")
        if _extract_label_nifti(seg_img, label_val, out_path):
            overlays.append({"label": label_name, "url": _nifti_url(out_path)})

    return overlays


class GetNiftiUrls(foo.Operator):
    @property
    def config(self):
        return foo.OperatorConfig(
            name="get_nifti_urls",
            label="Get NIfTI URLs",
            unlisted=True,
        )

    def resolve_input(self, ctx):
        inputs = types.Object()
        inputs.str("sample_id")
        inputs.str("dataset_name")
        return types.Property(inputs)

    def execute(self, ctx):
        _ensure_flask()

        sample_id    = ctx.params.get("sample_id")
        dataset_name = ctx.params.get("dataset_name")

        try:
            dataset = fo.load_dataset(dataset_name)
            sample  = dataset[sample_id]
        except Exception as e:
            return {"error": str(e)}

        # Resolve CT path: nifti_path → filepath (only if filepath is actually NIfTI)
        ct_path = getattr(sample, "nifti_path", None) or (
            sample.filepath if _is_nifti(sample.filepath) else None
        )
        if not ct_path:
            return {"error": "No NIfTI path found. Set nifti_path on the sample."}

        # Resolve seg path: seg_path field
        seg_path     = getattr(sample, "seg_path", None) or ""
        mask_targets = getattr(sample, "mask_targets", {}) or {}

        segs = _get_seg_overlays(seg_path, mask_targets)

        # Multi-modality support: modality_paths = {name: abs_path, ...}
        modality_paths = getattr(sample, "modality_paths", None) or {}
        modality_urls  = {
            name: _nifti_url(path)
            for name, path in modality_paths.items()
            if path and os.path.exists(path)
        }

        # Default ct_url: first modality if available, otherwise nifti_path
        if modality_urls:
            ct_url = next(iter(modality_urls.values()))
        else:
            ct_url = _nifti_url(ct_path)

        return {
            "ct_url":        ct_url,
            "modality_urls": modality_urls,
            "segs":          segs,
            "sample_label":  getattr(sample, "patient_id", None) or sample_id[:8],
        }


def register(p):
    _ensure_flask()
    p.register(GetNiftiUrls)
