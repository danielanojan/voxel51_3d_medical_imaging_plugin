"""
NIfTI → FiftyOne grouped IMAGE dataset builder.

Dataset structure (minimal MongoDB, maximum scale):
  - One sample document per patient × view (zero frame documents)
  - Each sample stores: num_slices, slices_dir, masks_dir, segmentation summary
  - Panel reads PNG slices directly from disk using those paths
  - Grid thumbnail = middle slice PNG

For each patient folder:
  - Reads <id><modality_suffix>  → extracts grayscale PNG slices per view
  - Reads <id><seg_suffix>       → extracts combined mask PNGs (non-empty only)

Usage:
    python build_nifti_dataset.py \\
        --data_root  /path/to/nifti/dataset \\
        --output_root /path/to/output/slices \\
        --dataset_name my-nifti-dataset

    # BraTS 2023 example:
    # Note: use = for suffixes that start with a dash (argparse limitation)
    python build_nifti_dataset.py \\
        --data_root  /data/ASNR-MICCAI-BraTS2023-GLI-Challenge-TrainingData \\
        --output_root /data/brats_slices \\
        --dataset_name brats2023 \\
        --patient_dir_glob "BraTS-*" \\
        --modality_suffix="-t1c.nii.gz" \\
        --seg_suffix="-seg.nii.gz"

    # Generic NIfTI dataset (no segmentation):
    python build_nifti_dataset.py \\
        --data_root  /data/my_nifti_scans \\
        --output_root /data/my_nifti_slices \\
        --dataset_name my-scans \\
        --patient_dir_glob "*" \\
        --modality_suffix .nii.gz \\
        --no_seg

All other options (mask_targets, views, modality, etc.) can be edited in the
CONFIG dict below or overridden via --config_json for scripted pipelines.
"""

import argparse
import json
import os
import glob
import numpy as np
from PIL import Image
import nibabel as nib
import fiftyone as fo


# ─────────────────────────────────────────────────────────────────────────────
# CONFIG  —  edit these defaults or override via CLI args
# ─────────────────────────────────────────────────────────────────────────────

CONFIG = {
    # --data_root   : root folder containing one sub-folder per patient
    "data_root": None,

    # --output_root : where extracted PNG slices are written
    "output_root": None,

    # --dataset_name : FiftyOne dataset name (overwritten on each run)
    "dataset_name": "nifti-dataset",

    # --patient_dir_glob : glob pattern for patient sub-folders
    #   "BraTS-*"  → matches BraTS 2023 naming
    #   "*"        → any sub-folder
    "patient_dir_glob": "*",

    # --modality_suffix : NIfTI file suffix  (<patient_id><suffix>)
    "modality_suffix": ".nii.gz",

    # --seg_suffix : segmentation NIfTI suffix; set "" or use --no_seg to skip
    "seg_suffix": "",

    # Mask class labels: str(pixel_value) → display label
    # 0 is always background and is not listed here
    # BraTS example: {"1": "NCR", "2": "ED", "3": "ET"}
    "mask_targets": {},

    # Which anatomical views to extract
    "views": ["axial", "coronal", "sagittal"],

    # Metadata stored on each sample
    "modality": "MRI",
    "dataset_source": "nifti",

    # Percentile window for MRI normalisation
    "norm_percentile_low":  1,
    "norm_percentile_high": 99,
}


# ─────────────────────────────────────────────────────────────────────────────
# NIfTI loading & normalisation
# ─────────────────────────────────────────────────────────────────────────────

def load_volume(path: str) -> np.ndarray:
    return nib.load(path).get_fdata(dtype=np.float32)


def normalise_volume(vol: np.ndarray, p_low: float, p_high: float) -> np.ndarray:
    lo = np.percentile(vol, p_low)
    hi = np.percentile(vol, p_high)
    vol = np.clip(vol, lo, hi)
    if hi > lo:
        vol = (vol - lo) / (hi - lo) * 255.0
    return vol.astype(np.uint8)


# ─────────────────────────────────────────────────────────────────────────────
# Slice helpers
# ─────────────────────────────────────────────────────────────────────────────

def extract_slice(vol: np.ndarray, view: str, idx: int) -> np.ndarray:
    if view == "axial":
        sl = vol[:, :, idx]
    elif view == "coronal":
        sl = vol[:, idx, :]
    elif view == "sagittal":
        sl = vol[idx, :, :]
    else:
        raise ValueError(f"Unknown view: {view}")
    return np.rot90(sl)


def num_slices(vol: np.ndarray, view: str) -> int:
    return {"axial": vol.shape[2], "coronal": vol.shape[1],
            "sagittal": vol.shape[0]}[view]


# ─────────────────────────────────────────────────────────────────────────────
# Per-patient processing
# ─────────────────────────────────────────────────────────────────────────────

def _make_summary(mask_targets: dict) -> dict:
    """Build a zeroed summary dict derived from mask_targets config."""
    summary = {"has_seg": False, "masked_slice_count": 0}
    for label in mask_targets.values():
        key = label.lower()
        summary[f"has_{key}"] = False
        summary[f"{key}_slice_count"] = 0
    return summary


def process_patient(patient_dir: str, cfg: dict) -> dict:
    patient_id   = os.path.basename(patient_dir)
    out_root     = os.path.join(cfg["output_root"], patient_id)
    mask_targets = cfg["mask_targets"]

    t1c_path  = os.path.join(patient_dir, patient_id + cfg["modality_suffix"])
    seg_suffix = cfg.get("seg_suffix") or ""
    seg_path   = os.path.join(patient_dir, patient_id + seg_suffix) if seg_suffix else None

    if not os.path.exists(t1c_path):
        print(f"    SKIP: missing {t1c_path}")
        return {}

    mri_vol = normalise_volume(
        load_volume(t1c_path),
        cfg["norm_percentile_low"],
        cfg["norm_percentile_high"],
    )
    seg_vol = (
        load_volume(seg_path).astype(np.uint8)
        if (seg_path and os.path.exists(seg_path))
        else None
    )

    result = {
        "slice_counts": {v: num_slices(mri_vol, v) for v in cfg["views"]}
    }

    val_to_key = {int(v): lbl.lower() for v, lbl in mask_targets.items()}

    for view in cfg["views"]:
        n          = result["slice_counts"][view]
        slices_dir = os.path.join(out_root, view, "slices")
        masks_dir  = os.path.join(out_root, view, "masks")
        os.makedirs(slices_dir, exist_ok=True)
        os.makedirs(masks_dir,  exist_ok=True)

        summary = _make_summary(mask_targets)

        for idx in range(n):
            slice_path = os.path.join(slices_dir, f"frame_{idx:04d}.png")
            if not os.path.exists(slice_path):
                Image.fromarray(extract_slice(mri_vol, view, idx), mode="L").save(slice_path)

        if seg_vol is not None:
            for idx in range(n):
                seg_sl = extract_slice(seg_vol, view, idx)
                if not seg_sl.any():
                    continue
                summary["has_seg"] = True
                summary["masked_slice_count"] += 1
                for pixel_val, key in val_to_key.items():
                    if (seg_sl == pixel_val).any():
                        summary[f"has_{key}"] = True
                        summary[f"{key}_slice_count"] += 1
                mask_path = os.path.join(masks_dir, f"frame_{idx:04d}_mask.png")
                if not os.path.exists(mask_path):
                    Image.fromarray(seg_sl, mode="L").save(mask_path)

        mid = n // 2
        result[view] = {
            "slices_dir": slices_dir,
            "masks_dir":  masks_dir,
            "num_slices": n,
            "summary":    summary,
            "thumbnail":  os.path.join(slices_dir, f"frame_{mid:04d}.png"),
        }

    result["nifti_paths"] = {
        "modality": t1c_path if os.path.exists(t1c_path) else None,
        "seg":      seg_path  if (seg_path and os.path.exists(seg_path)) else None,
    }
    return result


# ─────────────────────────────────────────────────────────────────────────────
# Dataset builder
# ─────────────────────────────────────────────────────────────────────────────

def build_dataset(cfg: dict) -> fo.Dataset:
    data_root    = cfg["data_root"]
    dataset_name = cfg["dataset_name"]

    if fo.dataset_exists(dataset_name):
        fo.delete_dataset(dataset_name)

    dataset = fo.Dataset(dataset_name)
    dataset.add_group_field("group", default=cfg["views"][0])
    dataset.persistent = True

    dataset.info["slice_viewer"] = {
        "mask_classes": [
            {"name": lbl.lower(), "value": int(val)}
            for val, lbl in cfg["mask_targets"].items()
        ]
    }

    patient_glob = os.path.join(data_root, cfg.get("patient_dir_glob", "*"))
    patient_dirs = sorted(
        d for d in glob.glob(patient_glob)
        if os.path.isdir(d)
    )
    print(f"Found {len(patient_dirs)} patients  (glob: {patient_glob})")

    for patient_dir in patient_dirs:
        patient_id = os.path.basename(patient_dir)
        print(f"  {patient_id} ...", end=" ", flush=True)

        view_data = process_patient(patient_dir, cfg)
        if not view_data:
            print("SKIP")
            continue

        slice_counts = view_data["slice_counts"]
        nifti_paths  = view_data["nifti_paths"]
        group        = fo.Group()
        samples      = []

        for view, data in view_data.items():
            if view in ("slice_counts", "nifti_paths"):
                continue
            sample = fo.Sample(
                filepath=data["thumbnail"],
                group=group.element(view),
                patient_id=patient_id,
                view=view,
                modality=cfg["modality"],
                dataset_source=cfg["dataset_source"],
                num_slices=data["num_slices"],
                axial_num_slices=slice_counts.get("axial", 0),
                coronal_num_slices=slice_counts.get("coronal", 0),
                sagittal_num_slices=slice_counts.get("sagittal", 0),
                slices_dir=data["slices_dir"],
                masks_dir=data["masks_dir"],
                mask_targets=cfg["mask_targets"],
                nifti_path=nifti_paths["modality"],
                seg_path=nifti_paths["seg"],
                **data["summary"],
            )
            samples.append(sample)

        dataset.add_samples(samples)
        print(f"ok ({sum(slice_counts.values())} total slices)")

    dataset.create_index("patient_id")
    dataset.create_index("dataset_source")
    dataset.save()

    n_views = len(cfg["views"])
    print(f"\nDone. Dataset '{dataset_name}':")
    print(f"  Groups (patients)   : {len(dataset)}")
    print(f"  Total sample docs   : {len(dataset) * n_views}  (patients × {n_views} views)")
    print(f"  Has frames field    : {'frames' in dataset.get_field_schema()}  (should be False)")
    return dataset


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def _parse_args():
    p = argparse.ArgumentParser(
        description="Build a FiftyOne grouped dataset from NIfTI files.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--data_root",   required=True,
                   help="Root folder containing one sub-folder per patient.")
    p.add_argument("--output_root", required=True,
                   help="Output folder where PNG slices are written.")
    p.add_argument("--dataset_name", default=CONFIG["dataset_name"],
                   help="FiftyOne dataset name (default: %(default)s).")
    p.add_argument("--patient_dir_glob", default=CONFIG["patient_dir_glob"],
                   help="Glob pattern for patient sub-folders (default: %(default)s). "
                        "Use 'BraTS-*' for BraTS datasets.")
    p.add_argument("--modality_suffix", default=CONFIG["modality_suffix"],
                   help="NIfTI file suffix appended to patient ID (default: %(default)s).")
    p.add_argument("--seg_suffix", default=CONFIG["seg_suffix"],
                   help="Segmentation NIfTI suffix appended to patient ID. "
                        "Leave empty or use --no_seg to skip segmentation.")
    p.add_argument("--no_seg", action="store_true",
                   help="Disable segmentation extraction entirely.")
    p.add_argument("--mask_targets", default=None,
                   help='JSON string mapping pixel value to label name. '
                        'Example: \'{"1":"NCR","2":"ED","3":"ET"}\'')
    p.add_argument("--modality", default=CONFIG["modality"],
                   help="Modality label stored on each sample (default: %(default)s).")
    p.add_argument("--dataset_source", default=CONFIG["dataset_source"],
                   help="Source label stored on each sample (default: %(default)s).")
    p.add_argument("--config_json", default=None,
                   help="Path to a JSON file with full CONFIG overrides.")
    return p.parse_args()


if __name__ == "__main__":
    args = _parse_args()

    cfg = dict(CONFIG)

    # Apply JSON config file first (lowest precedence)
    if args.config_json:
        with open(args.config_json) as f:
            cfg.update(json.load(f))

    # Apply CLI args (highest precedence)
    cfg["data_root"]         = args.data_root
    cfg["output_root"]       = args.output_root
    cfg["dataset_name"]      = args.dataset_name
    cfg["patient_dir_glob"]  = args.patient_dir_glob
    cfg["modality_suffix"]   = args.modality_suffix
    cfg["modality"]          = args.modality
    cfg["dataset_source"]    = args.dataset_source

    if args.no_seg:
        cfg["seg_suffix"] = ""
    elif args.seg_suffix:
        cfg["seg_suffix"] = args.seg_suffix

    if args.mask_targets:
        cfg["mask_targets"] = json.loads(args.mask_targets)

    os.makedirs(cfg["output_root"], exist_ok=True)
    dataset = build_dataset(cfg)

    first = dataset.first()
    print(f"\nFirst sample: {first.patient_id} | view={first.view}")
    print(f"  filepath:           {first.filepath}")
    print(f"  num_slices:         {first.num_slices}")
    print(f"  has_seg:            {first.has_seg}")
    print(f"  slices_dir:         {first.slices_dir}")
    print(f"  mask_targets:       {first.mask_targets}")
    print(f"  slice_viewer cfg:   {dataset.info.get('slice_viewer')}")
