# NIfTI Slice Viewer — FiftyOne Plugin

A FiftyOne panel plugin for interactive exploration of NIfTI MRI datasets. Renders a grid of samples with a global slice slider, optional anatomical view selector (for grouped datasets), and toggleable per-class segmentation overlays. Works with any NIfTI-derived dataset; configure via `dataset.info["slice_viewer"]`. Ships with BraTS 2023 defaults out of the box.

---

## What's Built

### Panel: `NiftiSliceViewer`

A full React panel registered in the FiftyOne UI:

- **Sample grid** — displays all samples from the current dataset view as tiles in a responsive CSS Grid
- **Global slice slider** — scrub through slices for every sample simultaneously; slider range adapts to the current view
- **View selector** — shown only for grouped datasets; buttons are derived dynamically from `dataset.group_slices`
- **Segmentation overlay toggles** — one checkbox per mask class, rendered from dataset config; masks are alpha-blended server-side
- **Discrete zoom** — 7 zoom levels (90 → 560 px tile width) via a range slider
- **Field value bubbles** — tiles display sidebar-active field values as colour-matched chips, mirroring the native FiftyOne grid
- **Modal integration** — plain click opens the native Visualize panel via `fos.useSetExpandedSample()`; Ctrl/Cmd+click toggles checkbox selection
- **Next-frame prefetch** — while idle, pre-fetches the next slice to eliminate stutter when scrubbing forward

### Operators

| Operator | Purpose |
|---|---|
| `get_slice_viewer_config` | Returns dataset config (views, mask classes, field names) to the frontend on mount |
| `list_slice_samples` | Lists samples for a given view, respecting sidebar filters and sort |
| `load_slice` | Single composited slice for one sample |
| `load_slice_batch` | N composited slices in one round-trip — called on every slider tick |

---

## Configuration

Config is read from `dataset.info["slice_viewer"]`. If absent, BraTS 2023 defaults apply (so existing BraTS datasets work with no changes).

```python
dataset.info["slice_viewer"] = {
    # Field names on each sample that point to slice/mask directories
    "slices_dir_field": "slices_dir",   # default
    "masks_dir_field":  "masks_dir",    # default
    "num_slices_field": "num_slices",   # default

    # Segmentation classes — any number, any pixel values, any colours
    "mask_classes": [
        {"name": "ncr", "value": 1, "color": [255,  68,  68]},
        {"name": "ed",  "value": 2, "color": [255, 165,   0]},
        {"name": "et",  "value": 3, "color": [255,   0, 255]},
    ],
}
dataset.save()
```

For a dataset with a single class and different field names:

```python
dataset.info["slice_viewer"] = {
    "slices_dir_field": "slice_path",
    "masks_dir_field":  "mask_path",
    "num_slices_field": "depth",
    "mask_classes": [
        {"name": "tumor", "value": 1, "color": [255, 0, 0]},
    ],
}
dataset.save()
```

If `mask_classes` is empty, the overlay toggle bar is hidden and slices render without any segmentation layer.

---

## Dataset Requirements

Each sample must have:

| Field | Type | Description |
|---|---|---|
| _(configured)_ `slices_dir` | `str` | Directory containing `frame_XXXX.png` grayscale slices |
| _(configured)_ `masks_dir` | `str` | Directory containing `frame_XXXX_mask.png` combined mask files |
| _(configured)_ `num_slices` | `int` | Total slice count for this sample's view |

Mask files use pixel-value encoding: pixel value `0` = background, any non-zero value = a class defined in `mask_classes`. The combined single-file approach (vs one file per class) reduces file count and lets compositing decode all classes in one read.

For grouped datasets (axial/coronal/sagittal), each group slice is a separate sample with its own `slices_dir`, `masks_dir`, and `num_slices`. Use `build_nifti_dataset.py` to build this layout from raw BraTS NIfTI files.

---

## How It Differs from Default FiftyOne

| Feature | Default FiftyOne | This Plugin |
|---|---|---|
| NIfTI / volume display | Not supported | Per-slice PNG compositing with overlay masks |
| Segmentation overlays | Static label display | Live toggle per class at any slice |
| Grid scrubbing | Frame-based video scrub | Global MRI slice slider, view-aware slice count |
| Tile click | Opens modal via native Looker | Same — uses `useSetExpandedSample` for identical behaviour |
| Field chips | Built-in GridTagBubbles (internal) | Custom `buildTags()` re-implementing same colour logic |

---

## Design Decisions

### 1. Config via `dataset.info["slice_viewer"]`

All BraTS-specific values (field names, mask classes, colors, pixel values) moved to dataset-level config with BraTS values as defaults. The plugin reads config once on panel mount via the `get_slice_viewer_config` operator, then drives all UI from that config state. New datasets need only set `dataset.info["slice_viewer"]` — no plugin code changes required.

### 2. Batch operator over per-tile requests

The panel calls `load_slice_batch` once per slider tick, getting back N composited images in a single round-trip. Issuing one operator call per tile per tick would cause severe stutter on grids larger than ~5 samples.

### 3. Two-layer image cache

**Python side:** `@lru_cache` on `_composite_and_encode` (keyed by `slices_dir + masks_dir + frame + mask_config_tuple`) keeps composited results in memory. Repeated scrubbing of the same slice region is essentially free after the first pass.

**Frontend side:** A `Map<string, string>` keyed by `"sampleId:frame:<flagbits>"` stores base64 data URLs. FIFO eviction at 2000 entries keeps browser memory bounded.

### 4. Hashable mask config tuple for `lru_cache`

Dynamic mask classes can't be passed as a dict (not hashable). They are converted to a tuple of tuples before being passed to the cached function:

```python
mask_config = tuple(
    (cls["name"], cls["value"], cls["color"][0], cls["color"][1], cls["color"][2], enabled)
    for cls in mask_classes
)
```

All elements are primitives → fully hashable → `@lru_cache` works correctly.

### 5. JPEG encoding at max 240px

Composited slices are JPEG (q=88) resized to 240px max dimension before encoding. PNG would be ~15–40 KB/tile; JPEG is ~3–8 KB — roughly 5× smaller. At grid tile display sizes (≤420px) quality is visually lossless. The Python-side `@lru_cache` means encoding happens only on the first hit per (sample, frame, mask combo).

### 6. Next-frame prefetch

After every main batch completes, a second `useOperatorExecutor` instance fires a background request for `frame + 1`, skipping IDs already cached. When the result arrives, images go into cache; if the user has already scrubbed to that frame, they display immediately.

### 7. Grouped vs flat datasets

`list_slice_samples` checks `dataset.media_type == "group"` before calling `select_group_slices()`. Non-grouped (flat) datasets query the full dataset directly. The frontend hides the view selector buttons when `config.views` is empty.

### 8. Modal integration via `useSetExpandedSample`

`fos.useSetExpandedSample()` is Recoil-only and works correctly from a plugin bundle. The alternative (`useSetModalState`) calls `useRelayEnvironment()`, which fails inside a plugin because the plugin's bundled `react-relay` is a different instance from the host app's. `useSetExpandedSample({ id, groupId })` gives identical modal behaviour without any Relay dependency.

### 9. Field chips re-implemented externally

The native `GridTagBubbles` component is internal to the FiftyOne app and not exported. `buildTags()` replicates the same logic using `fos.useLookerOptions(false).activePaths` for sidebar eye-icon state and `getColor()` from `@fiftyone/utilities` for colour matching.

---

## Installation

The frontend must be built from source. Yarn portal paths resolve relative to the FiftyOne source tree, so a clone of fiftyone is required for the build even if fiftyone is already installed via pip.

```bash
# 1. Install FiftyOne (skip if already installed)
pip install fiftyone nibabel pillow

# 2. Clone FiftyOne source — needed for building only
git clone https://github.com/voxel51/fiftyone.git

# 3. Clone this repo inside the fiftyone source plugins dir
git clone https://github.com/danielanojan/voxel51_3d_medical_imaging_plugin.git \
    fiftyone/__plugins__/@daniel

# 4. Build
cd fiftyone/__plugins__/@daniel/nifti-slice-viewer
FIFTYONE_DIR=$(pwd)/../../.. yarn install
FIFTYONE_DIR=$(pwd)/../../.. yarn build

# 5. Copy to your FiftyOne plugins directory
cd ../../..   # back to fiftyone/ root
PLUGINS_DIR=$(python -c "import fiftyone as fo; print(fo.config.plugins_dir)")
cp -r fiftyone/__plugins__/@daniel "$PLUGINS_DIR/@daniel"

# 6. Verify
fiftyone plugins list
fiftyone operators list | grep slice
```

---

## Development

### Python backend (`__init__.py`)

No build step. Edit the file directly in the installed location and restart FiftyOne:

```bash
# Find installed location
python -c "import fiftyone as fo; print(fo.config.plugins_dir)"

# Edit
~/.fiftyone/plugins/@daniel/nifti-slice-viewer/__init__.py

# Restart FiftyOne to pick up changes
```

### Frontend (`src/`)

The `package.json` uses yarn portal paths that only resolve inside the FiftyOne source tree. Builds must be done there.

**One-time setup:**

```bash
git clone https://github.com/voxel51/fiftyone.git
cd fiftyone && pip install -e .

git clone https://github.com/danielanojan/voxel51_3d_medical_imaging_plugin.git \
    fiftyone/__plugins__/@daniel

cd fiftyone/__plugins__/@daniel/nifti-slice-viewer
FIFTYONE_DIR=$(pwd)/../../.. yarn install
```

**Development loop:**

```bash
cd fiftyone/__plugins__/@daniel/nifti-slice-viewer

# Edit src/BratsSlicePanel.tsx or src/index.ts, then:
FIFTYONE_DIR=$(pwd)/../../.. yarn build

# Sync built bundle to installed location
cp dist/index.umd.js \
   $(python -c "import fiftyone as fo; print(fo.config.plugins_dir)")/@daniel/nifti-slice-viewer/dist/index.umd.js
```

Hard-refresh browser (`Cmd+Shift+R`) after each build.

**Commit source + dist together:**

```bash
git add src/BratsSlicePanel.tsx
git commit -m "feat: ..."
git push origin main
```

---

## Smoke Test the Backend

```bash
python test_backend.py
```

Writes PNGs to `./backend_smoke_test/` (3 views × 3 frames × mask combos). Verify overlays are spatially correct before running the full app.

---

## Files

| File | Purpose |
|---|---|
| `fiftyone.yml` | Plugin manifest — name, operators, panel, JS bundle path |
| `__init__.py` | Backend operators + PIL compositing pipeline |
| `src/BratsSlicePanel.tsx` | React panel — grid, slider, overlay toggles, zoom, modal click |
| `src/index.ts` | Panel registration |
| `../build_nifti_dataset.py` | Pipeline to extract slices/masks from NIfTI files into a FiftyOne dataset (at repo root) |
| `test_backend.py` | Standalone smoke test for the compositing pipeline |
