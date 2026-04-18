"""
NIfTI → FiftyOne grouped IMAGE dataset builder for BraTS 2023.

Dataset structure (minimal MongoDB, maximum scale):
  - ~3K sample documents in MongoDB  (1 per patient × view)
  - ZERO frame documents in MongoDB
    - Each sample stores: num_slices, axial_num_slices, coronal_num_slices,
        sagittal_num_slices, slices_dir, masks_dir, segmentation summary fields
  - Panel uses num_slices + dir paths to address any frame directly from disk
  - Grid thumbnail = middle slice PNG

For each patient:
  - Reads {id}-t1c.nii.gz  → extracts PNG slices per view
  - Reads {id}-seg.nii.gz  → extracts combined mask PNGs (only non-empty frames)
    - Stores slices_dir / masks_dir / per-view slice counts on the FiftyOne sample

Generalisation:
  - Edit CONFIG to point at a different NIfTI dataset
  - Change modality_suffix / seg_suffix patterns
  - Change mask_targets to match your class labels

Usage:
    source ~/fiftyone_env/bin/activate
    pip install nibabel pillow fiftyone
    python build_nifti_dataset.py
"""

import os
import glob
import numpy as np
from PIL import Image
import nibabel as nib
import fiftyone as fo


# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────

CONFIG = {
    # Root folder with one sub-folder per patient
    "data_root": (
        "/Users/Daniel/voxel51/brats_data"
        "/ASNR-MICCAI-BraTS2023-GLI-Challenge-TrainingData"
    ),

    # Output folder for extracted PNG slices and combined mask PNGs
    "output_root": "/Users/Daniel/voxel51/brats_native",

    # FiftyOne dataset name (overwritten on each run)
    "dataset_name": "brats-native",

    # Which views to extract
    "views": ["axial", "coronal", "sagittal"],

    # Modality NIfTI file suffix
    "modality_suffix": "-t1c.nii.gz",

    # Segmentation NIfTI file suffix
    "seg_suffix": "-seg.nii.gz",

    # Mask class labels (NIfTI seg pixel value → display label)
    # 0 is always background and is not listed here
    "mask_targets": {"1": "NCR", "2": "ED", "3": "ET"},

    # Modality / source labels stored on each sample
    "modality": "T1C",
    "dataset_source": "brats2023",

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

def process_patient(patient_dir: str, cfg: dict) -> dict:
    """
    Extract PNG slices and combined mask PNGs for one patient.

    Returns:
        {
                    "slice_counts": {
                        "axial": int,
                        "coronal": int,
                        "sagittal": int,
                    },
          view: {
            "slices_dir": str,   # path to slice PNGs
            "masks_dir":  str,   # path to mask PNGs (only non-empty frames written)
            "num_slices": int,
                        "summary": {
                            "has_seg": bool,
                            "has_ncr": bool,
                            "has_ed": bool,
                            "has_et": bool,
                            "masked_slice_count": int,
                            "ncr_slice_count": int,
                            "ed_slice_count": int,
                            "et_slice_count": int,
                        },
            "thumbnail":  str,   # middle slice PNG path (used as fo.Sample filepath)
          }
        }
    """
    patient_id = os.path.basename(patient_dir)
    out_root   = os.path.join(cfg["output_root"], patient_id)

    t1c_path = os.path.join(patient_dir, patient_id + cfg["modality_suffix"])
    seg_path  = os.path.join(patient_dir, patient_id + cfg["seg_suffix"])

    if not os.path.exists(t1c_path):
        print(f"    SKIP: missing {t1c_path}")
        return {}

    mri_vol = normalise_volume(
        load_volume(t1c_path),
        cfg["norm_percentile_low"],
        cfg["norm_percentile_high"],
    )
    seg_vol = load_volume(seg_path).astype(np.uint8) if os.path.exists(seg_path) else None

    result = {
        "slice_counts": {
            view: num_slices(mri_vol, view)
            for view in cfg["views"]
        }
    }
    for view in cfg["views"]:
        n          = result["slice_counts"][view]
        slices_dir = os.path.join(out_root, view, "slices")
        masks_dir  = os.path.join(out_root, view, "masks")
        os.makedirs(slices_dir, exist_ok=True)
        os.makedirs(masks_dir,  exist_ok=True)
        summary = {
            "has_seg": False,
            "has_ncr": False,
            "has_ed": False,
            "has_et": False,
            "masked_slice_count": 0,
            "ncr_slice_count": 0,
            "ed_slice_count": 0,
            "et_slice_count": 0,
        }

        # Extract all slice PNGs
        for idx in range(n):
            slice_path = os.path.join(slices_dir, f"frame_{idx:04d}.png")
            if not os.path.exists(slice_path):
                Image.fromarray(extract_slice(mri_vol, view, idx), mode="L").save(slice_path)

        # Extract non-empty combined mask PNGs
        if seg_vol is not None:
            for idx in range(n):
                seg_sl = extract_slice(seg_vol, view, idx)
                if not seg_sl.any():
                    continue

                summary["has_seg"] = True
                summary["masked_slice_count"] += 1
                if (seg_sl == 1).any():
                    summary["has_ncr"] = True
                    summary["ncr_slice_count"] += 1
                if (seg_sl == 2).any():
                    summary["has_ed"] = True
                    summary["ed_slice_count"] += 1
                if (seg_sl == 3).any():
                    summary["has_et"] = True
                    summary["et_slice_count"] += 1

                mask_path = os.path.join(masks_dir, f"frame_{idx:04d}_mask.png")
                if not os.path.exists(mask_path):
                    Image.fromarray(seg_sl, mode="L").save(mask_path)

        # Middle slice as grid thumbnail
        mid = n // 2
        thumbnail = os.path.join(slices_dir, f"frame_{mid:04d}.png")

        result[view] = {
            "slices_dir": slices_dir,
            "masks_dir":  masks_dir,
            "num_slices": n,
            "summary": summary,
            "thumbnail":  thumbnail,
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

    patient_dirs = sorted(
        d for d in glob.glob(os.path.join(data_root, "BraTS-*"))
        if os.path.isdir(d)
    )
    print(f"Found {len(patient_dirs)} patients")

    for patient_dir in patient_dirs:
        patient_id = os.path.basename(patient_dir)
        print(f"  {patient_id} ...", end=" ", flush=True)

        view_data = process_patient(patient_dir, cfg)
        if not view_data:
            print("SKIP")
            continue

        slice_counts = view_data["slice_counts"]
        group   = fo.Group()
        samples = []

        for view, data in view_data.items():
            if view == "slice_counts":
                continue

            sample = fo.Sample(
                filepath=data["thumbnail"],        # middle slice → grid tile
                group=group.element(view),
                patient_id=patient_id,
                view=view,
                modality=cfg["modality"],
                dataset_source=cfg["dataset_source"],
                num_slices=data["num_slices"],     # panel uses this for slider range
                axial_num_slices=slice_counts.get("axial", 0),
                coronal_num_slices=slice_counts.get("coronal", 0),
                sagittal_num_slices=slice_counts.get("sagittal", 0),
                slices_dir=data["slices_dir"],     # panel reads frame_NNNN.png from here
                masks_dir=data["masks_dir"],       # panel reads frame_NNNN_mask.png from here
                mask_targets=cfg["mask_targets"],  # class labels for overlay colours
                has_seg=data["summary"]["has_seg"],
                has_ncr=data["summary"]["has_ncr"],
                has_ed=data["summary"]["has_ed"],
                has_et=data["summary"]["has_et"],
                masked_slice_count=data["summary"]["masked_slice_count"],
                ncr_slice_count=data["summary"]["ncr_slice_count"],
                ed_slice_count=data["summary"]["ed_slice_count"],
                et_slice_count=data["summary"]["et_slice_count"],
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
    print(f"  Total sample docs   : {len(dataset) * n_views}  (patients × {n_views} views, zero frame docs)")
    has_frames = "frames" in dataset.get_field_schema()
    print(f"  Has frames field    : {has_frames}  (should be False)")
    return dataset


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    os.makedirs(CONFIG["output_root"], exist_ok=True)
    dataset = build_dataset(CONFIG)

    first = dataset.first()
    print(f"\nFirst sample: {first.patient_id} | view={first.view}")
    print(f"  filepath (thumbnail): {first.filepath}")
    print(f"  num_slices: {first.num_slices}")
    print(f"  axial_num_slices: {first.axial_num_slices}")
    print(f"  coronal_num_slices: {first.coronal_num_slices}")
    print(f"  sagittal_num_slices: {first.sagittal_num_slices}")
    print(f"  has_seg: {first.has_seg}")
    print(f"  has_ncr: {first.has_ncr}")
    print(f"  has_ed: {first.has_ed}")
    print(f"  has_et: {first.has_et}")
    print(f"  masked_slice_count: {first.masked_slice_count}")
    print(f"  ncr_slice_count: {first.ncr_slice_count}")
    print(f"  ed_slice_count: {first.ed_slice_count}")
    print(f"  et_slice_count: {first.et_slice_count}")
    print(f"  slices_dir: {first.slices_dir}")
    print(f"  masks_dir:  {first.masks_dir}")
    print(f"  mask_targets: {first.mask_targets}")
