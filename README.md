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

## Flask File Server API

The plugin spins up a Flask server on **port 5152** as a background daemon thread. It starts automatically on first operator call and lives for the duration of the FiftyOne Python process.

### `GET /nifti`

Serves a local NIfTI file as a binary stream so NiiVue can fetch it from the browser.

| Param | Type | Description |
|---|---|---|
| `path` | string | Absolute path to the `.nii` or `.nii.gz` file on disk |

**Example:**
```
GET http://localhost:5152/nifti?path=/data/brats/BraTS-001/BraTS-001_t1c.nii.gz
```

**Response:**
- `200` — file bytes, `Content-Type: application/octet-stream`
- `404` — `Not found: <path>` if path is missing or doesn't exist on disk

**Headers set:**
```
Access-Control-Allow-Origin: *     ← required — browser blocks cross-origin requests without this
Cache-Control: public, max-age=3600
```

---

### `GET /health`

Quick liveness check — confirms the Flask server is running.

```
GET http://localhost:5152/health
→ 200 "ok"
```

Useful to verify the server started before debugging NiiVue load failures.

---

### Manually test the server

Open a terminal while FiftyOne is running (after opening at least one NIfTI sample in the modal to trigger server start):

```bash
# Check server is alive
curl http://localhost:5152/health

# Check a specific file is reachable
curl -I "http://localhost:5152/nifti?path=/absolute/path/to/file.nii.gz"
# Should return: HTTP/1.1 200 OK

# Download and inspect
curl "http://localhost:5152/nifti?path=/absolute/path/to/file.nii.gz" -o /tmp/test.nii.gz
file /tmp/test.nii.gz   # should say: gzip compressed data
```

---

## Debugging

**Check if Flask is running:**
```bash
lsof -i :5152
# Should show a Python process. If empty — server hasn't started yet (open a NIfTI sample) or crashed.
```

**NIfTI not loading in NiiVue:**
1. Open browser devtools → Network tab
2. Filter by `localhost:5152`
3. Look for failed requests — status 404 means wrong path, no request at all means operator didn't return a URL

Common causes:
- `nifti_path` field not set and `filepath` isn't `.nii/.nii.gz`
- Path exists on Python side but is wrong (typo, symlink, relative path)
- Flask thread crashed — restart FiftyOne Python process

**Seg overlays not appearing:**
1. `curl http://localhost:5152/health` — confirm server is up
2. Check `seg_path` is set on the sample: `dataset[sample_id].seg_path`
3. Check per-label cached NIfTIs exist alongside the seg file:
   ```bash
   ls $(dirname /path/to/seg.nii.gz)
   # Should show seg-label1.nii.gz, seg-label2.nii.gz etc after first load
   ```
4. Check the seg directory is writable — label extraction writes files there

**Port conflict:**
```bash
lsof -i :5152          # find what's using the port
kill -9 <PID>          # free it, then restart FiftyOne
```
To change the port, edit `FLASK_PORT = 5152` in `__init__.py` and rebuild.

---

## Files

| File | Purpose |
|---|---|
| `fiftyone.yml` | Plugin manifest |
| `__init__.py` | Flask server, `get_nifti_urls` operator, per-label seg extraction |
| `src/index.tsx` | React panel — NiiVue setup, layout buttons, seg toggles |
| `dist/index.umd.js` | Built JS bundle |
