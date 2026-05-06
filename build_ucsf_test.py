"""
build_ucsf_test.py — 1-patient test dataset for UCSF-PDGM-0004.

Works with the flat folder layout on Desktop:
    ~/Desktop/UCSF-PDGM-0004_nifti/
        UCSF-PDGM-0004_T1c_bias.nii.gz
        UCSF-PDGM-0004_tumor_segmentation.nii.gz
        ...

Creates a persistent FiftyOne grouped dataset "ucsf-pdgm-test" with:
  - axial / coronal / sagittal PNG slices  → for nifti-slice-viewer
  - modality_paths  {T1c, T1, T2, FLAIR, ADC, DWI, SWI, FA}  → for nifti-3d-viewer dropdown
  - seg_path + mask_targets               → for 3D seg overlays

Usage:
    cd ~/voxel51/voxel51_3d_medical_imaging_plugin
    source ~/fiftyone_env/bin/activate
    python build_ucsf_test.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import numpy as np
from PIL import Image
import fiftyone as fo
import build_nifti_dataset as b

# ── Config ────────────────────────────────────────────────────────────────────

PATIENT_DIR  = os.path.expanduser("~/Desktop/UCSF-PDGM-0004_nifti")
PATIENT_ID   = "UCSF-PDGM-0004"
OUTPUT_ROOT  = os.path.expanduser("~/Desktop/UCSF-PDGM-slices")
DATASET_NAME = "ucsf-pdgm-test"
VIEWS        = ["axial", "coronal", "sagittal"]

# BraTS-convention tumour labels (UCSF-PDGM uses the same scheme)
MASK_TARGETS = {"1": "NCR", "2": "ED", "4": "ET"}

# ── Modality patterns for 3D viewer dropdown ──────────────────────────────────

MODALITY_PATTERNS = [
    ("T1c",   "_T1c_bias.nii.gz"),
    ("T1",    "_T1_bias.nii.gz"),
    ("T2",    "_T2_bias.nii.gz"),
    ("FLAIR", "_FLAIR_bias.nii.gz"),
    ("ADC",   "_ADC.nii.gz"),
    ("DWI",   "_DWI_bias.nii.gz"),
    ("SWI",   "_SWI_bias.nii.gz"),
    ("FA",    "_DTI_eddy_FA.nii.gz"),
]


def _build_modality_paths() -> dict:
    paths = {}
    for name, suffix in MODALITY_PATTERNS:
        p = os.path.join(PATIENT_DIR, PATIENT_ID + suffix)
        if os.path.exists(p):
            paths[name] = p
    return paths


# ── Resolve primary modality + seg paths ──────────────────────────────────────

t1c_path = os.path.join(PATIENT_DIR, PATIENT_ID + "_T1c_bias.nii.gz")
seg_path = os.path.join(PATIENT_DIR, PATIENT_ID + "_tumor_segmentation.nii.gz")

if not os.path.exists(t1c_path):
    sys.exit(f"ERROR: primary modality not found: {t1c_path}")

os.makedirs(OUTPUT_ROOT, exist_ok=True)

print(f"Patient  : {PATIENT_ID}")
print(f"Source   : {PATIENT_DIR}")
print(f"Output   : {OUTPUT_ROOT}")
print(f"Has seg  : {os.path.exists(seg_path)}")

# ── Load volumes ──────────────────────────────────────────────────────────────

print("\nLoading volumes …")
mri_vol = b.normalise_volume(
    b.load_volume(t1c_path),
    p_low=1, p_high=99,
)
seg_vol = (
    b.load_volume(seg_path).astype(np.uint8)
    if os.path.exists(seg_path)
    else None
)

# ── Extract slices per view ───────────────────────────────────────────────────

out_root     = os.path.join(OUTPUT_ROOT, PATIENT_ID)
val_to_key   = {int(v): lbl.lower() for v, lbl in MASK_TARGETS.items()}
slice_counts = {v: b.num_slices(mri_vol, v) for v in VIEWS}
view_data    = {"slice_counts": slice_counts}

for view in VIEWS:
    n          = slice_counts[view]
    slices_dir = os.path.join(out_root, view, "slices")
    masks_dir  = os.path.join(out_root, view, "masks")
    os.makedirs(slices_dir, exist_ok=True)
    os.makedirs(masks_dir,  exist_ok=True)

    summary = b._make_summary(MASK_TARGETS)

    for idx in range(n):
        p = os.path.join(slices_dir, f"frame_{idx:04d}.png")
        if not os.path.exists(p):
            Image.fromarray(b.extract_slice(mri_vol, view, idx), mode="L").save(p)

    if seg_vol is not None:
        for idx in range(n):
            seg_sl = b.extract_slice(seg_vol, view, idx)
            if not seg_sl.any():
                continue
            summary["has_seg"] = True
            summary["masked_slice_count"] += 1
            for pixel_val, key in val_to_key.items():
                if (seg_sl == pixel_val).any():
                    summary[f"has_{key}"] = True
                    summary[f"{key}_slice_count"] += 1
            mp = os.path.join(masks_dir, f"frame_{idx:04d}_mask.png")
            if not os.path.exists(mp):
                Image.fromarray(seg_sl, mode="L").save(mp)

    mid = n // 2
    view_data[view] = {
        "slices_dir": slices_dir,
        "masks_dir":  masks_dir,
        "num_slices": n,
        "summary":    summary,
        "thumbnail":  os.path.join(slices_dir, f"frame_{mid:04d}.png"),
    }
    print(f"  {view}: {n} slices, has_seg={summary['has_seg']}, "
          f"masked={summary['masked_slice_count']}")

# ── Build FiftyOne dataset ────────────────────────────────────────────────────

print(f"\nBuilding FiftyOne dataset '{DATASET_NAME}' …")

if fo.dataset_exists(DATASET_NAME):
    fo.delete_dataset(DATASET_NAME)

dataset = fo.Dataset(DATASET_NAME)
dataset.add_group_field("group", default=VIEWS[0])
dataset.persistent = True

dataset.info["slice_viewer"] = {
    "mask_classes": [
        {"name": lbl.lower(), "value": int(val)}
        for val, lbl in MASK_TARGETS.items()
    ]
}

modality_paths = _build_modality_paths()
print(f"  Modalities: {list(modality_paths.keys())}")

group   = fo.Group()
samples = []
s       = slice_counts

for view in VIEWS:
    data   = view_data[view]
    sample = fo.Sample(
        filepath=data["thumbnail"],
        group=group.element(view),
        patient_id=PATIENT_ID,
        view=view,
        modality="T1c",
        dataset_source="ucsf-pdgm",
        num_slices=data["num_slices"],
        axial_num_slices=s["axial"],
        coronal_num_slices=s["coronal"],
        sagittal_num_slices=s["sagittal"],
        slices_dir=data["slices_dir"],
        masks_dir=data["masks_dir"],
        mask_targets=MASK_TARGETS,
        nifti_path=t1c_path,
        seg_path=seg_path if os.path.exists(seg_path) else None,
        modality_paths=modality_paths,
        **data["summary"],
    )
    samples.append(sample)

dataset.add_samples(samples)
dataset.save()

# ── Summary ───────────────────────────────────────────────────────────────────

first = dataset.first()
print(f"\nDone. Dataset '{DATASET_NAME}':")
print(f"  Groups        : {len(dataset)}")
print(f"  patient_id    : {first.patient_id}")
print(f"  has_seg       : {first.has_seg}")
print(f"  num_slices    : {first.num_slices}")
print(f"  modalities    : {list(modality_paths.keys())}")
print(f"  slices_dir    : {first.slices_dir}")
print(f"\nLaunch:")
print(f"  python -c \"import fiftyone as fo; fo.launch_app(fo.load_dataset('{DATASET_NAME}'))\"")
