# NIfTI Slice Viewer — FiftyOne Plugin

A FiftyOne panel plugin for interactive exploration of NIfTI MRI datasets. Renders a grid of samples with a global slice slider, optional anatomical view selector (for grouped datasets), and toggleable per-class segmentation overlays. Works with any NIfTI-derived dataset; configure via `dataset.info["slice_viewer"]`. Ships with BraTS 2023 defaults out of the box.

---

## What's Built

### Panel: `BratsSliceViewer`

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

```bash
# Find your plugins dir
fiftyone config plugins_dir

# Symlink (edits to source reflect immediately without reinstall)
ln -s "$(pwd)" "$(fiftyone config plugins_dir)/brats-slice-viewer"

# Build the JS bundle
FIFTYONE_DIR=/path/to/fiftyone yarn install && yarn build

# Verify registration
fiftyone plugins list
fiftyone operators list | grep slice
```

---

## Build Reference

```bash
# Activate Python env
source ~/fiftyone_env/bin/activate

# Rebuild dataset (only after schema changes)
cd /Users/Daniel/voxel51
python3 build_nifti_dataset.py

# Rebuild plugin frontend
cd /Users/Daniel/fiftyone_new/fiftyone/__plugins__/brats-slice-viewer
FIFTYONE_DIR=/Users/Daniel/fiftyone_new/fiftyone yarn build

# Start app (full restart required to pick up new plugin bundle)
python3 -c "import fiftyone as fo; fo.launch_app(fo.load_dataset('brats-native'))"

# Hard-refresh browser after restart: Cmd+Shift+R
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
| `build_nifti_dataset.py` | Pipeline to extract slices/masks from BraTS NIfTI files into a FiftyOne dataset |
| `test_backend.py` | Standalone smoke test for the compositing pipeline |
