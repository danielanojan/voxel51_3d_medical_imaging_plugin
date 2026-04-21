# NIfTI 3D Viewer — FiftyOne Plugin

Renders NIfTI volumes in an interactive 3D viewer (NiiVue) inside the FiftyOne sample modal. Supports multi-label segmentation overlays with per-label toggle buttons and multiple layout views.

---

## How It Works

1. **Flask server (port 5152)** — spins up as a background thread on first use, serves local NIfTI files over HTTP so the browser can fetch them
2. **`get_nifti_urls` operator** — called when a sample opens in the modal; reads volume + seg paths, extracts per-label binary NIfTIs (cached on disk), returns HTTP URLs
3. **React panel (NiiVue)** — fetches volumes from Flask, renders interactive 3D/slice views with toggleable segmentation overlays

The panel only appears inside the **sample modal** (not as a standalone panel tab) — open any sample to activate it.

---

## Dataset Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `nifti_path` | `StringField` | Yes* | Absolute path to primary NIfTI volume (CT, MRI) |
| `seg_path` | `StringField` | No | Absolute path to segmentation NIfTI |
| `mask_targets` | `DictField` | No | Maps label integers → names, e.g. `{"1": "NCR", "2": "ED", "3": "ET"}` |

> *Falls back to `sample.filepath` if it ends in `.nii` or `.nii.gz` — datasets where `filepath` points directly to a NIfTI work without extra fields.

---

## Example Dataset Builder

```python
import fiftyone as fo

dataset = fo.Dataset("my-nifti-dataset")
dataset.persistent = True

for patient_dir in sorted(glob.glob("/data/*")):
    nifti_path = f"{patient_dir}/volume.nii.gz"
    seg_path   = f"{patient_dir}/seg.nii.gz"

    dataset.add_sample(fo.Sample(
        filepath=nifti_path,
        nifti_path=nifti_path,
        seg_path=seg_path if os.path.exists(seg_path) else None,
        mask_targets={"1": "NCR", "2": "ED", "3": "ET"},
    ))
```

### BraTS 2023

Use `build_nifti_dataset.py` from the `@daniel/nifti-slice-viewer` plugin to build a compatible dataset. Set `nifti_path` to the T1C volume path and `seg_path` to the segmentation path on each sample.

---

## Panel Features

### Layout Views

| Button | NiiVue slice type | Description |
|---|---|---|
| 4-Up | 3 | Axial + Coronal + Sagittal + 3D (default) |
| Axial | 0 | Single axial slice |
| Coronal | 1 | Single coronal slice |
| Sagittal | 2 | Single sagittal slice |
| 3D | 4 | Full 3D volume render |

### Segmentation Overlays

Each label in `mask_targets` appears as a toggle button. Active overlays are alpha-blended over the CT volume at opacity 0.6. Each label gets a distinct colormap (`red`, `warm`, `violet`, `green`, `blue`, `hot`, `cool`).

"All labels" button shows the combined segmentation in one pass. Individual label buttons show binary overlays extracted per-class.

---

## Installation

```bash
# Find plugins dir
fiftyone config plugins_dir

# Symlink plugin
ln -s /path/to/nifti_niivue_plugin "$(fiftyone config plugins_dir)/nifti_niivue_plugin"

# Install JS deps and build
cd nifti_niivue_plugin
FIFTYONE_DIR=/path/to/fiftyone yarn install && yarn build

# Verify
fiftyone plugins list | grep niivue
```

---

## Build Reference

```bash
# Activate env
source ~/fiftyone_env/bin/activate

# Rebuild JS bundle
cd /Users/Daniel/fiftyone_new/fiftyone/__plugins__/nifti_niivue_plugin
FIFTYONE_DIR=/Users/Daniel/fiftyone_new/fiftyone yarn build

# Start app
python3 -c "import fiftyone as fo; fo.launch_app(fo.load_dataset('brats-native'))"
```

---

## Debugging

**Flask server not starting:** Check port 5152 is free — `lsof -i :5152`. The server starts on first operator call; if it fails silently, restart the FiftyOne Python process.

**NIfTI not loading:** Open browser devtools → Network tab. Look for failed requests to `localhost:5152/nifti?path=...`. Common causes:
- Path doesn't exist on disk
- `nifti_path` field not set and `filepath` isn't a `.nii.gz`
- Flask thread died — restart FiftyOne

**Seg overlays missing:** Confirm `seg_path` is set on the sample and the file exists. Per-label NIfTIs are cached alongside the seg file — check that directory is writable.

---

## Files

| File | Purpose |
|---|---|
| `fiftyone.yml` | Plugin manifest |
| `__init__.py` | Flask server, `get_nifti_urls` operator, per-label seg extraction |
| `src/index.tsx` | React panel — NiiVue setup, layout buttons, seg toggles |
| `dist/index.umd.js` | Built JS bundle |
