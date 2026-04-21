"""
Generalizable FiftyOne grouped-video dataset builder for volumetric medical imaging.

Disk layout expected (BraTS):
  {data_root}/{patient_id}/
    {modality}_{view}.mp4          ← video for each view
    slices/{view}/frame_NNNN.png   ← grayscale slices (used to derive num_slices)
    masks/{view}/frame_NNNN_{cls}.png  ← sparse per-class masks

Output: combined mask PNGs written alongside originals as frame_NNNN_combined.png
        FiftyOne grouped-video dataset saved under `dataset_name`

Usage:
    python build_native_dataset.py

Config:
    Edit the CONFIG block below to adapt to a different dataset.
"""

import os
import glob
import numpy as np
from PIL import Image
import fiftyone as fo


# ─────────────────────────────────────────────────────────────────────────────
# CONFIG — edit this block to generalise to other datasets
# ─────────────────────────────────────────────────────────────────────────────

CONFIG = {
    # Root folder containing one sub-folder per patient
    "data_root": "/path/to/your/nifti/dataset",

    # Dataset name in FiftyOne (will be overwritten if it already exists)
    "dataset_name": "brats-native",

    # Which views to include (must match sub-folder names)
    "views": ["axial", "coronal", "sagittal"],

    # Default view shown in the grid
    "default_view": "axial",

    # Video filename pattern: use {view} as placeholder
    "video_pattern": "t1c_{view}.mp4",

    # Modality label stored on each sample
    "modality": "T1C",

    # Dataset source label (useful when mixing multiple datasets)
    "dataset_source": "brats2023",

    # Mask class definitions: name → (pixel_value_in_combined_mask, display_label)
    # Pixel value 0 is always background.
    "mask_classes": {
        "ncr": (1, "NCR"),   # Necrotic core
        "ed":  (2, "ED"),    # Edema
        "et":  (3, "ET"),    # Enhancing tumour
    },

    # Mask filename pattern per frame per class.
    # Use {frame_idx} (zero-padded to 4 digits) and {cls} as placeholders.
    "mask_file_pattern": "frame_{frame_idx:04d}_{cls}.png",

    # Slice filename pattern (used to enumerate frame count)
    "slice_file_pattern": "frame_{frame_idx:04d}.png",
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Combine per-class mask PNGs into a single mask PNG
# ─────────────────────────────────────────────────────────────────────────────

def combine_masks_for_patient(patient_dir: str, cfg: dict) -> dict:
    """
    For each view, for each frame, combine sparse per-class mask PNGs into
    a single combined PNG (pixel value = class ID, 0 = background).

    Returns a dict: {view: {frame_idx: combined_mask_path}}
    Only frames that have at least one class mask are included.
    Frames with no mask at all are NOT written (fo.Segmentation will be None).
    """
    combined = {}
    masks_root = os.path.join(patient_dir, "masks")

    for view in cfg["views"]:
        masks_dir = os.path.join(masks_root, view)
        if not os.path.isdir(masks_dir):
            continue

        # Discover all frame indices that have at least one class mask
        frame_indices = set()
        for cls in cfg["mask_classes"]:
            pattern = os.path.join(
                masks_dir,
                cfg["mask_file_pattern"].replace("{cls}", cls).replace(
                    "{frame_idx:04d}", "*"
                ),
            )
            for path in glob.glob(pattern):
                basename = os.path.basename(path)
                # extract frame index from filename
                try:
                    idx = int(basename.split("_")[1])
                    frame_indices.add(idx)
                except (IndexError, ValueError):
                    pass

        combined[view] = {}
        for frame_idx in sorted(frame_indices):
            combined_path = os.path.join(
                masks_dir, f"frame_{frame_idx:04d}_combined.png"
            )

            # Skip if already built
            if os.path.exists(combined_path):
                combined[view][frame_idx] = combined_path
                continue

            # Build combined mask
            combined_arr = None
            for cls, (pixel_val, _) in cfg["mask_classes"].items():
                cls_path = os.path.join(
                    masks_dir,
                    cfg["mask_file_pattern"]
                    .replace("{cls}", cls)
                    .replace("{frame_idx:04d}", f"{frame_idx:04d}"),
                )
                if not os.path.exists(cls_path):
                    continue
                cls_mask = np.asarray(
                    Image.open(cls_path).convert("L"), dtype=np.uint8
                )
                if combined_arr is None:
                    combined_arr = np.zeros_like(cls_mask, dtype=np.uint8)
                # Class masks use pixel > 0 as "on"; assign pixel_val
                combined_arr[cls_mask > 0] = pixel_val

            if combined_arr is not None:
                Image.fromarray(combined_arr).save(combined_path)
                combined[view][frame_idx] = combined_path

    return combined


# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Count slices from the slices directory
# ─────────────────────────────────────────────────────────────────────────────

def count_slices(patient_dir: str, view: str) -> int:
    slices_dir = os.path.join(patient_dir, "slices", view)
    if not os.path.isdir(slices_dir):
        return 0
    return len(glob.glob(os.path.join(slices_dir, "frame_*.png")))


# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Build (or rebuild) the FiftyOne dataset
# ─────────────────────────────────────────────────────────────────────────────

def build_dataset(cfg: dict) -> fo.Dataset:
    data_root = cfg["data_root"]
    dataset_name = cfg["dataset_name"]

    # Build mask_targets from config — used by FiftyOne's native renderer
    mask_targets = {v: label for _, (v, label) in cfg["mask_classes"].items()}

    # Delete existing dataset if present
    if fo.dataset_exists(dataset_name):
        fo.delete_dataset(dataset_name)

    dataset = fo.Dataset(dataset_name)
    dataset.add_group_field("group", default=cfg["default_view"])
    dataset.persistent = True

    patient_dirs = sorted(
        d for d in glob.glob(os.path.join(data_root, "*")) if os.path.isdir(d)
    )

    print(f"Found {len(patient_dirs)} patients in {data_root}")

    for patient_dir in patient_dirs:
        patient_id = os.path.basename(patient_dir)
        print(f"  Processing {patient_id} ...")

        # Step 1: build combined masks
        combined_masks = combine_masks_for_patient(patient_dir, cfg)

        group = fo.Group()
        samples_to_add = []

        for view in cfg["views"]:
            video_path = os.path.join(
                patient_dir,
                cfg["video_pattern"].replace("{view}", view),
            )
            if not os.path.exists(video_path):
                print(f"    WARNING: missing video {video_path}, skipping")
                continue

            num_slices = count_slices(patient_dir, view)

            sample = fo.Sample(
                filepath=video_path,
                group=group.element(view),
                patient_id=patient_id,
                view=view,
                modality=cfg["modality"],
                dataset_source=cfg["dataset_source"],
                num_slices=num_slices,
            )

            # Attach frame-level segmentations
            frame_masks = combined_masks.get(view, {})
            for frame_idx, mask_path in frame_masks.items():
                # FiftyOne frames are 1-indexed
                sample.frames[frame_idx + 1]["seg"] = fo.Segmentation(
                    mask_path=mask_path,
                    mask_targets=mask_targets,
                )

            samples_to_add.append(sample)

        if samples_to_add:
            dataset.add_samples(samples_to_add)

    # Add indexes for fast filtering
    dataset.create_index("patient_id")
    dataset.create_index("dataset_source")
    dataset.save()

    print(f"\nDataset '{dataset_name}' built: {len(dataset)} samples")
    print(f"  Views per patient: {cfg['views']}")
    print(f"  Mask classes: {list(cfg['mask_classes'].keys())}")
    return dataset


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    dataset = build_dataset(CONFIG)

    # Quick sanity check
    first = dataset.first()
    print(f"\nFirst sample: {first.patient_id} / {first.view}")
    print(f"  num_slices: {first.num_slices}")
    print(f"  frame count in DB: {len(first.frames)}")
    if first.frames:
        f1 = first.frames[next(iter(first.frames))]
        print(f"  sample frame seg: {f1.get('seg')}")
