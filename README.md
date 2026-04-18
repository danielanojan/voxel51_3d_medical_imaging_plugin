# BraTS Slice Viewer — Plugin (Phase A: Python backend)

Custom FiftyOne plugin that renders a grid of T1C slices for BraTS datasets
with a global slice slider, view selector, and per-class mask toggles.

**This directory currently contains Phase A only: the Python backend.**
Phase B (the JS panel) will be added next. Phase A is directly testable
without the JS — you can run `test_backend.py` to verify the compositing
pipeline produces correct overlays before we build anything on top.

## Files

- `fiftyone.yml` — plugin manifest, registers two operators
- `__init__.py` — operator definitions (`load_brats_slice`,
  `load_brats_slice_batch`) + slice/mask compositing logic
- `test_backend.py` — standalone smoke test, writes PNGs you can eyeball

## Prereqs

Dataset built by `brats_to_video_fo.py`, with each sample carrying:

- `slices_dir` (str)  — directory of `frame_XXXX.png`
- `masks_dir`  (str)  — directory of `frame_XXXX_{ncr,ed,et}.png`
- `num_slices` (int)  — slice count along this sample's view

## Step 1: Smoke test the backend (no plugin install needed)

From this directory:

```bash
python test_backend.py
```

Should write ~27 PNGs to `./backend_smoke_test/` (3 views × 3 frames ×
3 mask combos). Open a few and verify:

- `*_base.png` — grayscale T1C only, no overlays
- `*_all_masks.png` — red (NCR) / orange (ED) / magenta (ET) overlays
- `*_only_ed.png` — only orange edema overlay

If overlays look misaligned, the problem is upstream (in slice generation),
not in the plugin. If they look correct, we're good to install.

## Step 2: Install the plugin

Copy or symlink this directory into your FiftyOne plugins dir:

```bash
# Find your plugins dir
fiftyone config plugins_dir

# Symlink (so edits to source reflect immediately)
ln -s "$(pwd)" "$(fiftyone config plugins_dir)/brats-slice-viewer"

# Verify it's registered
fiftyone plugins list
fiftyone operators list | grep brats
```

You should see `load_brats_slice` and `load_brats_slice_batch` in the
operators list.

## Step 3: Test operators from Python

```python
import fiftyone as fo
import fiftyone.operators as foo

dataset = fo.load_dataset("brats-t1c-slice-videos")
sample = dataset.first()

op = foo.get_operator("@daniel/brats-slice-viewer/load_brats_slice")
result = op(
    dataset,
    sample_id=sample.id,
    frame=60,
    show_ncr=True, show_ed=True, show_et=True,
)
print(result.keys())
print("image length:", len(result["image"]))   # expect a base64 data URL
```

If that works, backend is ready. Next phase: JS panel.

## Notes

- Compositing happens in Python (PIL). Masks are alpha-blended at
  `OVERLAY_ALPHA=0.55` — tweak in `__init__.py` if they're too strong/weak.
- `@lru_cache` on `_read_slice_png` / `_read_mask_png` keeps hot frames
  in memory — scrubbing the same region is essentially free after the
  first pass.
- `load_brats_slice_batch` is the one the panel will call each slider
  tick: one request → N composited slices back. Single-call-per-grid is
  the important perf choice.
