"""
Standalone smoke test for the BraTS Slice Viewer backend.

Runs the compositing logic directly (without going through FiftyOne's
operator system) and writes PNGs to disk so you can eyeball the results.

Run this BEFORE trying to install the plugin — if this works, the data
pipeline is correct and any subsequent issue is a plugin-registration /
JS problem, not a compositing problem.

Usage:
    # From anywhere — just point DATASET_NAME at your BraTS dataset
    python test_backend.py
"""

import base64
import os
import sys

import fiftyone as fo

# Make the plugin module importable without installing it
PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, PLUGIN_DIR)

# We can't import the whole __init__.py because `register()` expects a
# FiftyOne plugin context — so pull the helpers directly.
import importlib.util

spec = importlib.util.spec_from_file_location(
    "brats_backend", os.path.join(PLUGIN_DIR, "__init__.py")
)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────
DATASET_NAME = "brats-t1c-slice-videos"
OUT_DIR      = "./backend_smoke_test"
FRAMES       = [20, 60, 100]       # test a few frames
# ─────────────────────────────────────────────


def decode_data_url(data_url, out_path):
    """Strip the data URL prefix and write binary PNG to out_path."""
    assert data_url.startswith("data:image/png;base64,"), "not a PNG data URL"
    b64 = data_url.split(",", 1)[1]
    with open(out_path, "wb") as f:
        f.write(base64.b64decode(b64))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    dataset = fo.load_dataset(DATASET_NAME)
    print(f"Loaded dataset: {dataset.name}  ({len(dataset)} samples)")

    # Pick one sample per view to exercise all three axes
    samples_by_view = {}
    for view_name in ("axial", "coronal", "sagittal"):
        match = dataset.match({"view": view_name}).limit(1)
        sample = match.first()
        if sample is None:
            print(f"  ⚠ no sample for view={view_name}")
            continue
        samples_by_view[view_name] = sample

    if not samples_by_view:
        print("❌ No samples found — is the dataset populated?")
        return

    for view_name, sample in samples_by_view.items():
        print(f"\n=== view: {view_name}  patient: {sample.patient_id} ===")
        print(f"  slices_dir : {sample.slices_dir}")
        print(f"  masks_dir  : {sample.masks_dir}")
        print(f"  num_slices : {sample.num_slices}")

        for frame in FRAMES:
            # Test each combination of mask toggles so you can eyeball overlays
            for flags_label, flags in [
                ("base",      dict(show_ncr=False, show_ed=False,
                                   show_et=False)),
                ("all_masks", dict(show_ncr=True,  show_ed=True,
                                   show_et=True)),
                ("only_ed",   dict(show_ncr=False, show_ed=True,
                                   show_et=False)),
            ]:
                img = backend._composite_slice(
                    sample.slices_dir,
                    sample.masks_dir,
                    frame,
                    **flags,
                )
                if img is None:
                    print(f"    frame {frame} {flags_label}: missing")
                    continue

                data_url = backend._image_to_data_url(img)
                out_path = os.path.join(
                    OUT_DIR,
                    f"{view_name}_{sample.patient_id}_f{frame:03d}_"
                    f"{flags_label}.png"
                )
                decode_data_url(data_url, out_path)
                kb = os.path.getsize(out_path) / 1024
                print(f"    frame {frame:3d} {flags_label:9s}: "
                      f"{img.width}x{img.height}  {kb:6.1f} KB  "
                      f"→ {out_path}")

    print(f"\n✅ Wrote test PNGs to {OUT_DIR}/")
    print("   Open them and verify tumor overlays look correct.")


if __name__ == "__main__":
    main()
