# NIfTI Plugins for FiftyOne

Two FiftyOne plugins for interactive exploration of NIfTI MRI datasets.

| Plugin | Description |
|---|---|
| [`@daniel/nifti-slice-viewer`](nifti-slice-viewer/) | 2D slice grid — scrub through slices, toggle segmentation overlays, browse all samples simultaneously |
| [`@daniel/nifti-3d-viewer`](nifti-3d-viewer/) | 3D volume viewer (NiiVue) — renders MRI + segmentation overlays in axial/coronal/sagittal/3D layouts inside the sample modal |

---

## Quick Start

### 1. Prerequisites

```bash
pip install fiftyone nibabel pillow flask
```

### 2. Install Plugins

The frontend must be built from source. Yarn portal paths in `package.json` resolve relative to the FiftyOne source tree, so a clone of fiftyone is required for the build step even if you installed fiftyone via pip.

```bash
# 1. Install FiftyOne (skip if already installed)
pip install fiftyone

# 2. Clone FiftyOne source — needed only for the build, not for running
git clone https://github.com/voxel51/fiftyone.git

# 3. Clone this repo inside the fiftyone source plugins dir
git clone https://github.com/danielanojan/voxel51_3d_medical_imaging_plugin.git \
    fiftyone/__plugins__/@daniel

# 4. Build both plugins
cd fiftyone/__plugins__/@daniel/nifti-slice-viewer
FIFTYONE_DIR=$(pwd)/../../.. yarn install && FIFTYONE_DIR=$(pwd)/../../.. yarn build

cd ../nifti-3d-viewer
FIFTYONE_DIR=$(pwd)/../../.. yarn install && FIFTYONE_DIR=$(pwd)/../../.. yarn build

# 5. Copy built plugins to your FiftyOne plugins directory
cd ../../..   # back to fiftyone/ root
PLUGINS_DIR=$(python -c "import fiftyone as fo; print(fo.config.plugins_dir)")
cp -r fiftyone/__plugins__/@daniel "$PLUGINS_DIR/@daniel"

# 6. Verify
fiftyone plugins list
```

To install only one plugin, build that plugin only and copy just that subdirectory to `$PLUGINS_DIR/@daniel/`.

### 3. Build the Dataset

Use `build_nifti_dataset.py` to extract PNG slices from NIfTI files and create a FiftyOne dataset.

```bash
# Minimal (no segmentation)
python build_nifti_dataset.py \
    --data_root /path/to/nifti/dataset \
    --output_root /path/to/output/slices \
    --dataset_name my-dataset

# BraTS 2023 example (with segmentation)
python build_nifti_dataset.py \
    --data_root /data/ASNR-MICCAI-BraTS2023-GLI-Challenge-TrainingData \
    --output_root /data/brats_slices \
    --dataset_name brats2023 \
    --patient_dir_glob "BraTS-*" \
    --modality_suffix="-t1c.nii.gz" \
    --seg_suffix="-seg.nii.gz" \
    --mask_targets '{"1":"NCR","2":"ED","3":"ET"}' \
    --modality T1C \
    --dataset_source brats2023
```

> **Note:** Suffixes starting with `-` must use `=` syntax (e.g. `--modality_suffix="-t1c.nii.gz"`) due to an argparse limitation.

Run `python build_nifti_dataset.py --help` for all options.

#### UCSF-PDGM dataset

Two dedicated scripts handle the UCSF-PDGM flat folder layout (all NIfTI files in one folder per patient, prefixed with the patient ID):

```
UCSF-PDGM-0004_nifti/
    UCSF-PDGM-0004_T1c_bias.nii.gz
    UCSF-PDGM-0004_T2_bias.nii.gz
    UCSF-PDGM-0004_FLAIR_bias.nii.gz
    UCSF-PDGM-0004_tumor_segmentation.nii.gz
    ...
```

**1-patient test dataset** (quickest way to verify both plugins work):

```bash
# Edit PATIENT_DIR at the top of the script to point to your folder, then:
python build_ucsf_test.py
```

This creates a persistent FiftyOne dataset named `ucsf-pdgm-test` with:
- Axial / coronal / sagittal PNG slices for the slice viewer
- All available modalities in `modality_paths` for the 3D viewer dropdown and compare mode
- Tumour segmentation overlays (NCR / ED / ET)

**Full UCSF-PDGM dataset** (multiple patients, standard folder layout):

```bash
# Expected layout: <data_root>/UCSF-PDGM-*/  ← one subfolder per patient
python build_ucsf_pdgm.py \
    --data_root /path/to/UCSF-PDGM \
    --output_root /path/to/output/slices \
    --dataset_name ucsf-pdgm
```

Both scripts set `modality_paths` on every sample so the **3D viewer's modality dropdown and compare mode** work out of the box.

### 4. Launch FiftyOne

```bash
python -c "
import fiftyone as fo
fo.launch_app(fo.load_dataset('brats2023'))
"
```

Open the **NIfTI Slice Viewer** panel from the Panels menu for the 2D grid view.
Open any sample in the modal to activate the **NIfTI 3D Viewer** panel.

---

## Repository Structure

```
@daniel/                          ← clone here: ~/.fiftyone/plugins/@daniel
├── README.md                     ← this file
├── install.sh                    ← installs one or both plugins
├── build_nifti_dataset.py        ← generic NIfTI → FiftyOne grouped dataset builder
├── build_ucsf_pdgm.py            ← UCSF-PDGM dataset builder (multi-patient)
├── build_ucsf_test.py            ← UCSF-PDGM 1-patient test dataset builder
├── build_native_dataset.py       ← alternative builder for pre-extracted PNG slice datasets
│
├── nifti-slice-viewer/           ← @daniel/nifti-slice-viewer
│   ├── fiftyone.yml
│   ├── __init__.py               ← Python operators + PIL compositing
│   ├── src/                      ← React panel source
│   ├── dist/                     ← built JS bundle (generated by yarn build)
│   └── README.md
│
└── nifti-3d-viewer/              ← @daniel/nifti-3d-viewer
    ├── fiftyone.yml
    ├── __init__.py               ← Flask server + get_nifti_urls operator
    ├── src/                      ← React panel source (NiiVue)
    ├── dist/                     ← built JS bundle (generated by yarn build)
    └── README.md
```

---

## Dataset Compatibility

Both plugins read the same fields from each sample:

| Field | Required by | Description |
|---|---|---|
| `slices_dir` | slice-viewer | Path to folder containing `frame_XXXX.png` slice images |
| `masks_dir` | slice-viewer | Path to folder containing `frame_XXXX_mask.png` mask images |
| `num_slices` | slice-viewer | Total slice count for this sample's anatomical view |
| `nifti_path` | 3d-viewer | Absolute path to the primary NIfTI volume file |
| `seg_path` | 3d-viewer | Absolute path to the segmentation NIfTI file (optional) |
| `mask_targets` | both | Dict mapping pixel value → label name, e.g. `{"1": "NCR"}` |
| `modality_paths` | 3d-viewer | Dict mapping modality name → absolute NIfTI path (enables dropdown + compare mode) |

`build_nifti_dataset.py` sets all fields except `modality_paths`. The UCSF-PDGM scripts set all fields including `modality_paths`.

---

## For Developers

### Python backend changes

Edit `__init__.py` directly in the installed plugin location — no build step needed:

```bash
# Find where the plugin is installed
python -c "import fiftyone as fo; print(fo.config.plugins_dir)"
# → e.g. ~/.fiftyone/plugins

# Edit the backend
~/.fiftyone/plugins/@daniel/nifti-slice-viewer/__init__.py
# or
~/.fiftyone/plugins/@daniel/nifti-3d-viewer/__init__.py

# Restart FiftyOne to pick up changes
```

### Frontend changes (React / TypeScript)

The plugins use yarn portal paths that only resolve inside the FiftyOne source tree, so builds must be done there.

**One-time setup:**

```bash
git clone https://github.com/voxel51/fiftyone.git
cd fiftyone && pip install -e .

git clone https://github.com/danielanojan/voxel51_3d_medical_imaging_plugin.git \
    fiftyone/__plugins__/@daniel
```

**Development loop (pick the plugin you're working on):**

```bash
# --- nifti-slice-viewer ---
cd fiftyone/__plugins__/@daniel/nifti-slice-viewer
FIFTYONE_DIR=$(pwd)/../../.. yarn install   # first time only

# Edit src/BratsSlicePanel.tsx or src/index.ts, then:
FIFTYONE_DIR=$(pwd)/../../.. yarn build

# Sync built bundle to the installed location
cp dist/index.umd.js \
   $(python -c "import fiftyone as fo; print(fo.config.plugins_dir)")/@daniel/nifti-slice-viewer/dist/index.umd.js
```

```bash
# --- nifti-3d-viewer ---
cd fiftyone/__plugins__/@daniel/nifti-3d-viewer
FIFTYONE_DIR=$(pwd)/../../.. yarn install   # first time only

# Edit src/index.tsx, then:
FIFTYONE_DIR=$(pwd)/../../.. yarn build

cp dist/index.umd.js \
   $(python -c "import fiftyone as fo; print(fo.config.plugins_dir)")/@daniel/nifti-3d-viewer/dist/index.umd.js
```

Hard-refresh the browser (`Cmd+Shift+R`) after each build — the old bundle is cached.

### Committing changes

`dist/` is gitignored — only commit source files. Other users build their own `dist/` from the source.

```bash
cd fiftyone/__plugins__/@daniel
git add nifti-slice-viewer/src/BratsSlicePanel.tsx
git commit -m "feat(slice-viewer): ..."
git push origin main
```

See each plugin's README for architecture details:
- [nifti-slice-viewer/README.md](nifti-slice-viewer/README.md)
- [nifti-3d-viewer/README.md](nifti-3d-viewer/README.md)
