# NIfTI 3D Viewer — Flask-Based FiftyOne Plugin

A Flask-based FiftyOne panel plugin that renders NIfTI volumes in an interactive 3D viewer (NiiVue) opened in a browser tab. The panel is built with FiftyOne's native Python panel API. Flask serves NIfTI files and dynamically generates the NiiVue viewer page — no JS bundle or React required.

---

## How It Works

1. **Flask server (port 5159)** — starts as a background daemon thread on panel load. Serves NIfTI files and generates NiiVue HTML pages on demand
2. **FiftyOne panel** — renders in the grid using `fop.Panel` + `types.MarkdownView`. Shows sample info, segmentation selector buttons, and a clickable viewer URL
3. **Browser tab** — user Cmd+clicks the URL from the panel → Flask generates and returns a complete NiiVue HTML page → 3D viewer opens in new tab

NiiVue is loaded from CDN (`unpkg.com`) inside the generated HTML. No local JS build step.

---

## Architecture

```
FiftyOne App (panel)
  │
  ├─ on_load() → _ensure_flask() → Flask daemon thread starts (port 5159)
  │
  ├─ render() → shows sample info + seg buttons + viewer URL
  │
  └─ User Cmd+clicks URL
          │
          ▼
      Browser tab → GET http://localhost:5159/viewer?sample_id=...&seg_field=...
          │
          ▼
      Flask /viewer → _build_niivue_html() → returns full HTML page
          │
          ▼
      NiiVue (CDN) → fetches CT + seg via GET /nifti?path=...
          │
          ▼
      3D render in browser
```

---

## Flask API

Flask runs on **port 5159** as a daemon thread, started automatically when the panel loads.

### `GET /viewer`

Generates and returns a complete NiiVue HTML page for a sample.

| Param | Type | Description |
|---|---|---|
| `sample_id` | string | FiftyOne sample `_id` |
| `seg_field` | string | Segmentation field name (default: `lung_and_infection_mask`) |

**Example:**
```
GET http://localhost:5159/viewer?sample_id=64a1f2...&seg_field=lung_mask
→ 200 text/html — full NiiVue viewer page
```

**Error:**
```
400 <pre>Error: ...</pre>   ← sample not found or dataset load failed
```

---

### `GET /nifti`

Serves a local NIfTI file as binary so NiiVue can fetch it from the browser.

| Param | Type | Description |
|---|---|---|
| `path` | string | Absolute path to `.nii` or `.nii.gz` on disk |

**Example:**
```
GET http://localhost:5159/nifti?path=/data/covid/patient001/ct.nii.gz
→ 200 application/octet-stream
```

**Headers set:**
```
Access-Control-Allow-Origin: *    ← required for browser cross-origin fetch
```

**Error:**
```
404 File not found: <path>
```

---

### `GET /health`

Liveness check — confirms Flask is running.

```
GET http://localhost:5159/health
→ 200 "ok"
```

---

## Dataset Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `filepath` | `str` | Yes | Absolute path to CT NIfTI volume |
| `<seg_field>_path` | `str` | No | Path to seg NIfTI — relative or absolute |
| `patient_id` | `str` | No | Display label in viewer (falls back to first 8 chars of sample ID) |
| `n_slices` | `int` | No | Shown in panel info bar |
| `shape` | `list` | No | Shown in panel info bar |

Seg path field is constructed as `{seg_field}_path` — e.g. `seg_field=lung_mask` → reads `sample.lung_mask_path`.

---

## Segmentation Overlays

Currently configured for COVID CT datasets:

| Button | `seg_field` | Colour |
|---|---|---|
| 🟢 Lung | `lung_mask` | Green |
| 🔴 Infection | `infection_mask` | Red |
| 🔵 Lung+Inf | `lung_and_infection_mask` | Blue |
| ⬜ None | `none` | No overlay |

> To use with a different dataset, update `SEG_LABELS` and `SEG_COLOURS` in `__init__.py` and set `<field>_path` fields on your samples.

---

## Viewer Controls

| Control | Action |
|---|---|
| **4-Up** | Axial + Coronal + Sagittal + 3D (default) |
| **Axial / Coronal / Sagittal** | Single plane view |
| **3D Only** | Full 3D volume — rotate with click+drag |
| **Toggle Seg** | Show/hide segmentation overlay |
| **Scroll** | Zoom in/out |

---

## Installation

No JS build step required.

```bash
# Find plugins dir
fiftyone config plugins_dir

# Symlink plugin
ln -s /path/to/nifti-3d-viewer "$(fiftyone config plugins_dir)/nifti-3d-viewer"

# Install Python deps
pip install flask nibabel

# Verify
fiftyone plugins list | grep nifti_3d_viewer
```

---

## Debugging

**Check Flask is running:**
```bash
curl http://localhost:5159/health
# → "ok" if running, connection refused if not started
```

**Test file is reachable:**
```bash
curl -I "http://localhost:5159/nifti?path=/absolute/path/to/file.nii.gz"
# → HTTP/1.1 200 OK
```

**Test viewer page generates:**
```bash
curl "http://localhost:5159/viewer?sample_id=<id>&seg_field=lung_mask"
# → Should return HTML with NiiVue script tag
```

**NiiVue not loading:**
- Requires internet — NiiVue loads from `unpkg.com` CDN
- Open browser devtools → Console for JS errors
- Network tab → look for failed `/nifti?path=...` requests (404 = wrong path)

**Seg overlay missing:**
- Check `<seg_field>_path` is set: `dataset[sample_id].lung_mask_path`
- Relative paths resolve from `os.path.dirname(os.path.dirname(sample.filepath))`

**Port conflict:**
```bash
lsof -i :5159
kill -9 <PID>   # free port, restart FiftyOne
```
Change port: edit `FLASK_PORT = 5159` in `__init__.py`.

---

## Files

| File | Purpose |
|---|---|
| `fiftyone.yml` | Plugin manifest |
| `__init__.py` | Flask server, NiiVue HTML builder, FiftyOne panel |
