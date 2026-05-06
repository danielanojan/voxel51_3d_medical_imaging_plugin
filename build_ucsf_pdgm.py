"""
build_ucsf_pdgm.py — FiftyOne dataset builder for the UCSF-PDGM dataset.

Expected data structure (one folder per patient, all NIfTI files inside):

    <data_root>/
        UCSF-PDGM-0004/
            UCSF-PDGM-0004_T1c_bias.nii.gz
            UCSF-PDGM-0004_T1_bias.nii.gz
            UCSF-PDGM-0004_T2_bias.nii.gz
            UCSF-PDGM-0004_FLAIR_bias.nii.gz
            UCSF-PDGM-0004_tumor_segmentation.nii.gz
            ...
        UCSF-PDGM-0541/
            ...

Tumor segmentation labels (BraTS convention):
    1 → NCR  (necrotic core)
    2 → ED   (edema / invasion)
    4 → ET   (enhancing tumour)

Each sample gets a modality_paths field so the NIfTI 3D Viewer can switch
between T1c / T1 / T2 / FLAIR / ADC / DWI without rebuilding the dataset.

Usage:
    python build_ucsf_pdgm.py \\
        --data_root  /path/to/UCSF-PDGM \\
        --output_root /path/to/slices_output

    # Override primary modality (used for slice viewer thumbnails):
    python build_ucsf_pdgm.py \\
        --data_root  /path/to/UCSF-PDGM \\
        --output_root /path/to/slices_output \\
        --modality_suffix _FLAIR_bias.nii.gz \\
        --modality FLAIR

    # Skip segmentation:
    python build_ucsf_pdgm.py \\
        --data_root  /path/to/UCSF-PDGM \\
        --output_root /path/to/slices_output \\
        --no_seg
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from build_nifti_dataset import build_dataset, CONFIG  # noqa: E402

# ── UCSF-PDGM defaults ────────────────────────────────────────────────────────

UCSF_DEFAULTS = {
    "dataset_name":     "ucsf-pdgm",
    "patient_dir_glob": "UCSF-PDGM-*",
    "modality_suffix":  "_T1c_bias.nii.gz",
    "seg_suffix":       "_tumor_segmentation.nii.gz",
    "mask_targets":     {"1": "NCR", "2": "ED", "4": "ET"},
    "modality":         "T1c",
    "dataset_source":   "ucsf-pdgm",
    "views":            ["axial", "coronal", "sagittal"],
    "norm_percentile_low":  1,
    "norm_percentile_high": 99,
}

# Modalities to discover per patient (in display order).
# bias-corrected variants are preferred over raw where both exist.
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


def _build_modality_paths(patient_dir: str, patient_id: str) -> dict:
    """Return {modality_name: absolute_path} for all available NIfTI modalities."""
    paths = {}
    for name, suffix in MODALITY_PATTERNS:
        path = os.path.join(patient_dir, patient_id + suffix)
        if os.path.exists(path):
            paths[name] = path
    return paths


def _parse_args():
    p = argparse.ArgumentParser(
        description="Build a FiftyOne grouped dataset from UCSF-PDGM NIfTI files.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--data_root",   required=True,
                   help="Root folder containing one sub-folder per patient (UCSF-PDGM-*).")
    p.add_argument("--output_root", required=True,
                   help="Output folder where extracted PNG slices are written.")
    p.add_argument("--dataset_name", default=UCSF_DEFAULTS["dataset_name"],
                   help="FiftyOne dataset name (default: %(default)s).")
    p.add_argument("--modality_suffix", default=UCSF_DEFAULTS["modality_suffix"],
                   help="Primary NIfTI modality suffix for slice extraction "
                        "(default: %(default)s).")
    p.add_argument("--modality", default=UCSF_DEFAULTS["modality"],
                   help="Modality label stored on each sample (default: %(default)s).")
    p.add_argument("--no_seg", action="store_true",
                   help="Skip segmentation extraction.")
    p.add_argument("--config_json", default=None,
                   help="Path to a JSON file with additional CONFIG overrides.")
    return p.parse_args()


if __name__ == "__main__":
    args = _parse_args()

    cfg = dict(CONFIG)
    cfg.update(UCSF_DEFAULTS)

    if args.config_json:
        with open(args.config_json) as f:
            cfg.update(json.load(f))

    cfg["data_root"]       = args.data_root
    cfg["output_root"]     = args.output_root
    cfg["dataset_name"]    = args.dataset_name
    cfg["modality_suffix"] = args.modality_suffix
    cfg["modality"]        = args.modality
    if args.no_seg:
        cfg["seg_suffix"] = ""

    os.makedirs(cfg["output_root"], exist_ok=True)

    print(f"Dataset  : {cfg['dataset_name']}")
    print(f"Data root: {cfg['data_root']}")
    print(f"Output   : {cfg['output_root']}")
    print(f"Modality : {cfg['modality_suffix']}")
    print(f"Seg      : {cfg['seg_suffix'] or '(none)'}")
    print(f"Labels   : {cfg['mask_targets']}")
    print()

    # Build slice dataset (PNG extraction + FiftyOne grouped dataset)
    dataset = build_dataset(cfg)

    # Post-process: add modality_paths to every sample so the 3D viewer can
    # switch between T1c / T1 / T2 / FLAIR / ADC / DWI without a rebuild.
    print("\nAdding modality_paths field to samples...")
    updated = 0
    for sample in dataset.iter_samples(progress=True, autosave=True):
        patient_id  = sample.patient_id
        patient_dir = os.path.join(cfg["data_root"], patient_id)
        mod_paths   = _build_modality_paths(patient_dir, patient_id)
        if mod_paths:
            sample["modality_paths"] = mod_paths
            updated += 1
    dataset.save()
    print(f"  {updated} samples updated with modality_paths")

    first = dataset.first()
    mods  = getattr(first, "modality_paths", {}) or {}
    print(f"\nFirst sample : {first.patient_id} | view={first.view}")
    print(f"  filepath   : {first.filepath}")
    print(f"  num_slices : {first.num_slices}")
    print(f"  has_seg    : {getattr(first, 'has_seg', False)}")
    print(f"  modalities : {list(mods.keys())}")
    print(f"\nLaunch with:")
    print(f"  python -c \"import fiftyone as fo; "
          f"fo.launch_app(fo.load_dataset('{cfg['dataset_name']}'))\"")
