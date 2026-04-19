import * as fos from "@fiftyone/state";
import { getColor } from "@fiftyone/utilities";
import { useOperatorExecutor } from "@fiftyone/operators";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRecoilState, useRecoilValue } from "recoil";

type View = "axial" | "coronal" | "sagittal";

// Discrete zoom steps (column min-width px): small → large
const SIZES = [90, 130, 180, 240, 320, 420, 560];
const DEFAULT_SIZE_IDX = 2; // 180px = reasonable default



// ─── Image cache ──────────────────────────────────────────────────────────────
// Key: "sampleId:frame:ncrEdEt" (e.g. "abc123:80:110")
// FIFO eviction keeps memory bounded; Map preserves insertion order.
const MAX_CACHE_ENTRIES = 2000;

function imgKey(id: string, f: number, ncr: boolean, ed: boolean, et: boolean): string {
  return `${id}:${f}:${+ncr}${+ed}${+et}`;
}

function cacheSet(cache: Map<string, string>, key: string, value: string): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

// Build field value bubbles from activePaths + sample data, mirroring GridTagBubbles.
// Uses @fiftyone/utilities getColor (externalized) to match the app color palette.
function buildTags(
  activePaths: string[],
  sample: Record<string, unknown>,
  coloring: { pool: readonly string[]; seed: number; by: string } | undefined
): Array<{ color: string; title: string; value: string }> {
  if (!activePaths?.length || !coloring) return [];
  const tags: Array<{ color: string; title: string; value: string }> = [];
  for (const path of activePaths) {
    if (path === "tags") {
      const sampleTags = (sample.tags as string[]) ?? [];
      for (const tag of sampleTags) {
        tags.push({ color: getColor(coloring.pool, coloring.seed, tag), title: tag, value: tag });
      }
    } else {
      const raw = sample[path];
      if (raw === undefined || raw === null) continue;
      const color = getColor(coloring.pool, coloring.seed,
        coloring.by === "field" ? path : String(raw));
      let value: string;
      if (typeof raw === "boolean") value = raw ? "True" : "False";
      else if (typeof raw === "number") {
        value = Number.isInteger(raw) ? raw.toLocaleString() :
          (raw < 0.001 ? raw.toFixed(6) : raw.toFixed(3));
      } else value = String(raw);
      tags.push({ color, title: `${path}: ${value}`, value });
    }
  }
  return tags;
}

interface Sample {
  id: string;
  group_id: string;
  patient_id: string;
  view: View;
  filepath: string;
  slices_dir: string;
  masks_dir: string;
  modality: string;
  dataset_source: string;
  created_at: string;
  last_modified_at: string;
  tags: string[];
  num_slices: number;
  axial_num_slices: number;
  coronal_num_slices: number;
  sagittal_num_slices: number;
  has_seg: boolean;
  has_ncr: boolean;
  has_ed: boolean;
  has_et: boolean;
  masked_slice_count: number;
  ncr_slice_count: number;
  ed_slice_count: number;
  et_slice_count: number;
}

// Fields that control overlay visibility — shown in the 'display_segmentation'
// sidebar group. Kept out of buildTags so they don't produce value bubbles.
const DISPLAY_CTRL_FIELDS = new Set(["show_ncr", "show_ed", "show_et"]);

// No styled-components. recoil/fos.view are externalized (host app instance) -- safe to use.
function BratsPanel() {
  // Opens the native FiftyOne sample modal (Visualize panel) for a given sample.
  // useSetExpandedSample is exported from @fiftyone/state (externalized) and only
  // uses Recoil internally — no Relay dependency — so it works from plugin context.
  const setExpandedSample = fos.useSetExpandedSample();
  const [activeView, setActiveView] = useState<View>("axial");
  const [frame,      setFrame]      = useState(80);
  const [maxSlices,  setMaxSlices]  = useState(155); // updated from sample data on load
  // sizeIdx indexes into SIZES; small value = fewer cols (zoomed in), large = more cols
  const [sizeIdx, setSizeIdx] = useState(DEFAULT_SIZE_IDX);
  const colSize = SIZES[sizeIdx];
  const [samples, setSamples] = useState<Sample[]>([]);
  const [images,  setImages]  = useState<Record<string, string>>({});
  const [status,  setStatus]  = useState("Listing...");

  // Per-panel image cache — survives re-renders, cleared on reList()
  const imageCache = useRef<Map<string, string>>(new Map());

  // Native FiftyOne field display — same color palette as GridTagBubbles.
  // activePaths reflects the sidebar eye-icon state for ALL fields, including
  // our custom show_ncr / show_ed / show_et overlay-control fields.
  const lookerOptions = fos.useLookerOptions(false);
  const activePaths = lookerOptions?.activePaths ?? [];

  // Overlay toggles — driven by the sidebar eye icons (display_segmentation group).
  // If neither the fields nor any active-field config has been set yet (empty
  // activePaths or control fields absent), preserve the historic default of
  // showing all overlays. Once the dataset is configured and the app restarts,
  // each field is individually toggled via its eye icon.
  const hasDisplayFields =
    activePaths.includes("show_ncr") ||
    activePaths.includes("show_ed")  ||
    activePaths.includes("show_et");
  const showNcr = !hasDisplayFields || activePaths.includes("show_ncr");
  const showEd  = !hasDisplayFields || activePaths.includes("show_ed");
  const showEt  = !hasDisplayFields || activePaths.includes("show_et");

  // Track all state atoms that can change what samples are shown or highlighted:
  //   fos.view            — committed view pipeline stages (saved views)
  //   fos.filters         — ephemeral sidebar filters (range sliders, tag filters)
  //   fos.extendedStages  — sort order + field visibility + sample selection
  //   fos.selectedSamples — lasso/checkbox selection from Embeddings or grid
  // None of these imply the others; all must be watched independently.
  const fosView          = useRecoilValue(fos.view) ?? [];
  const fosFilters       = useRecoilValue(fos.filters);
  const fosExtended      = useRecoilValue(fos.extendedStages);
  const [selectedSamples, setSelectedSamples] = useRecoilState(fos.selectedSamples);
  const viewKey = JSON.stringify([fosView, fosFilters, fosExtended]);

  // selectedSamples is Map<string, SelectionType> — use Map operations.
  const toggleSelected = (id: string) => {
    setSelectedSamples((prev: Map<string, string>) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id); else next.set(id, "default");
      return next;
    });
  };

  // Plain click → open modal (native Visualize panel).
  // Ctrl/Cmd+click → toggle sample selection without opening modal.
  const handleTileClick = (e: React.MouseEvent, sample: Sample) => {
    if (e.ctrlKey || e.metaKey) {
      toggleSelected(sample.id);
    } else {
      setExpandedSample({
        id: sample.id,
        groupId: sample.group_id || undefined,
      });
    }
  };

  const samplesRef   = useRef<Sample[]>([]);
  const frameRef     = useRef(frame);
  const maskRef      = useRef({ showNcr, showEd, showEt });
  const maxSlicesRef = useRef(maxSlices);
  useEffect(() => { frameRef.current = frame; }, [frame]);
  useEffect(() => { maskRef.current = { showNcr, showEd, showEt }; }, [showNcr, showEd, showEt]);
  useEffect(() => { maxSlicesRef.current = maxSlices; }, [maxSlices]);

  const listOp     = useOperatorExecutor("@daniel/brats-slice-viewer/list_brats_samples");
  const batchOp    = useOperatorExecutor("@daniel/brats-slice-viewer/load_brats_slice_batch");
  const prefetchOp = useOperatorExecutor("@daniel/brats-slice-viewer/load_brats_slice_batch");

  // Track the mask params sent with the most recent main/prefetch request so
  // the result handler can build the correct cache key even if mask state
  // changed while the request was in flight.
  const lastBatchMaskRef    = useRef({ ncr: true, ed: true, et: true });
  const lastPrefetchMaskRef = useRef({ ncr: true, ed: true, et: true, frame: 0 });

  const fireBatch = (f: number, ncr: boolean, ed: boolean, et: boolean) => {
    const list = samplesRef.current;
    if (!list.length) return;

    // Serve cached images instantly; only request what's missing.
    const immediate: Record<string, string> = {};
    const missing: string[] = [];
    for (const s of list) {
      const url = imageCache.current.get(imgKey(s.id, f, ncr, ed, et));
      if (url !== undefined) { immediate[s.id] = url; }
      else { missing.push(s.id); }
    }
    if (Object.keys(immediate).length > 0) {
      setImages(prev => ({ ...prev, ...immediate }));
    }
    if (missing.length > 0) {
      setStatus(`Loading ${missing.length}/${list.length} images, slice ${f}...`);
      lastBatchMaskRef.current = { ncr, ed, et };
      batchOp.execute({ sample_ids: missing, frame: f, show_ncr: ncr, show_ed: ed, show_et: et });
    } else {
      setStatus(`${list.length} images (all cached)`);
    }
  };

  const reList = (v: View) => {
    setSamples([]);
    setImages({});
    samplesRef.current = [];
    imageCache.current.clear();
    listOp.execute({ view: v });
  };

  // List on mount
  useEffect(() => { reList(activeView); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-list when FO view/filters/sort OR activeView changes (skip first render).
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    reList(activeView);
  }, [viewKey, activeView]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle list result — update maxSlices, clamp frame, trigger first batch
  useEffect(() => {
    const res = listOp.result as any;
    if (!res?.ok) return;
    const s: Sample[] = res.samples ?? [];
    samplesRef.current = s;
    setSamples(s);
    if (s.length > 0) {
      const newMax = Math.max(...s.map((x: Sample) => x.num_slices));
      setMaxSlices(newMax);
      maxSlicesRef.current = newMax;
      setFrame(f => Math.min(f, newMax - 1));
    }
    const { showNcr, showEd, showEt } = maskRef.current;
    fireBatch(Math.min(frameRef.current, maxSlicesRef.current - 1), showNcr, showEd, showEt);
  }, [listOp.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle batch result — populate cache, display images, trigger prefetch
  useEffect(() => {
    const res = batchOp.result as any;
    if (!res?.ok) return;
    const updated: Record<string, string> = {};
    let ok = 0;
    const { ncr, ed, et } = lastBatchMaskRef.current;
    for (const r of res.results ?? []) {
      if (r.ok) {
        const key = imgKey(r.sample_id, r.frame, ncr, ed, et);
        cacheSet(imageCache.current, key, r.image);
        updated[r.sample_id] = r.image;
        ok++;
      }
    }
    setStatus(ok + " images loaded");
    setImages(prev => ({ ...prev, ...updated }));

    // Prefetch the next frame so forward scrubbing feels instant.
    const nextF = frameRef.current + 1;
    if (nextF < maxSlicesRef.current && samplesRef.current.length > 0 && !prefetchOp.isExecuting) {
      const notCached = samplesRef.current.filter(
        s => !imageCache.current.has(imgKey(s.id, nextF, ncr, ed, et))
      );
      if (notCached.length > 0) {
        lastPrefetchMaskRef.current = { ncr, ed, et, frame: nextF };
        prefetchOp.execute({
          sample_ids: notCached.map(s => s.id), frame: nextF,
          show_ncr: ncr, show_ed: ed, show_et: et,
        });
      }
    }
  }, [batchOp.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle prefetch result — populate cache; display if user arrived at that frame
  useEffect(() => {
    const res = prefetchOp.result as any;
    if (!res?.ok) return;
    const { ncr, ed, et, frame: pFrame } = lastPrefetchMaskRef.current;
    const displayNow: Record<string, string> = {};
    for (const r of res.results ?? []) {
      if (r.ok) {
        const key = imgKey(r.sample_id, r.frame, ncr, ed, et);
        cacheSet(imageCache.current, key, r.image);
        if (r.frame === frameRef.current) displayNow[r.sample_id] = r.image;
      }
    }
    if (Object.keys(displayNow).length > 0) {
      setImages(prev => ({ ...prev, ...displayNow }));
    }
  }, [prefetchOp.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload images on slice / mask change (debounced)
  useEffect(() => {
    const t = setTimeout(() => fireBatch(frame, showNcr, showEd, showEt), 80);
    return () => clearTimeout(t);
  }, [frame, showNcr, showEd, showEt]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLoading   = listOp.isExecuting || batchOp.isExecuting;
  const sliderMax   = Math.max(maxSlices - 1, 0);
  const clampedFrame = Math.min(frame, sliderMax);
  const aspectRatio = activeView === "axial" ? "1" : "240/155";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%",
      overflow: "hidden", padding: "12px 16px", fontSize: "13px",
      color: "#ddd", background: "#1a1a1a", boxSizing: "border-box" }}>

      {/* Controls */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center",
        gap: "12px", paddingBottom: "12px", borderBottom: "1px solid #333",
        flexShrink: 0 }}>

        {/* View selector buttons */}
        <div style={{ display: "flex", gap: 4 }}>
          {(["axial", "coronal", "sagittal"] as View[]).map(v => (
            <button key={v} type="button"
              onClick={() => setActiveView(v)}
              disabled={isLoading}
              style={{
                padding: "3px 10px", borderRadius: 4, fontSize: 12,
                cursor: isLoading ? "default" : "pointer",
                border: "1px solid",
                borderColor: activeView === v ? "#f97316" : "#444",
                background: activeView === v ? "#f9731622" : "transparent",
                color: activeView === v ? "#f97316" : "#888",
                textTransform: "capitalize",
                fontWeight: activeView === v ? 600 : 400,
              }}>
              {v}
            </button>
          ))}
        </div>

        {/* Slice slider */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 160 }}>
          <span style={{ whiteSpace: "nowrap", fontSize: 12, color: "#888" }}>Slice</span>
          <input type="range" min={0} max={sliderMax} value={clampedFrame}
            style={{ flex: 1, accentColor: "#f97316" }}
            onChange={e => setFrame(Number(e.target.value))} />
          <span style={{ minWidth: "7ch", textAlign: "right", fontSize: 12,
            fontVariantNumeric: "tabular-nums", color: "#aaa" }}>
            {clampedFrame}/{sliderMax}
          </span>
        </div>

        {/* Size slider */}
        <input type="range" min={0} max={SIZES.length - 1} value={sizeIdx}
          title="Image size"
          style={{ width: 70, accentColor: "#f97316" }}
          onChange={e => setSizeIdx(Number(e.target.value))} />

        {/* Refresh — also available manually in case auto-sync missed something */}
        <button type="button" onClick={() => reList(activeView)} disabled={isLoading}
          style={{ padding: "4px 8px", borderRadius: 4, fontSize: 12,
            cursor: isLoading ? "default" : "pointer",
            border: "1px solid #444", background: "transparent",
            color: isLoading ? "#555" : "#aaa", flexShrink: 0 }}>
          {isLoading ? "..." : "↻"}
        </button>
      </div>

      {/* Image grid — scroll wrapper separate from grid to fix clipping bug */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        <div style={{ paddingTop: 10,
          display: "grid",
          gridTemplateColumns: `repeat(auto-fill, minmax(${colSize}px, 1fr))`,
          alignContent: "start",
          gap: 6 }}>
          {samples.length === 0
            ? <div style={{ color: "#444", fontSize: 12, padding: 8 }}>
                {isLoading ? "Listing..." : "No samples — adjust sidebar filters and click ↻"}
              </div>
              : samples.map(s => {
                  // Filter out overlay-control fields so they don't produce
                  // value bubbles on every tile.
                  const tagPaths = activePaths.filter(
                    p => !DISPLAY_CTRL_FIELDS.has(p)
                  );
                  const tags = buildTags(
                    tagPaths,
                    s as any,
                    lookerOptions?.coloring as any,
                  );

                  return (
                  <div key={s.id}
                    onClick={e => handleTileClick(e, s)}
                    style={{ position: "relative", background: "#1e1e1e",
                    borderRadius: 4, overflow: "hidden", cursor: "pointer",
                    border: selectedSamples.has(s.id)
                      ? "2px solid #59c3f5"
                      : "1px solid #2a2a2a" }}>
                    {/* Checkmark badge — top-left, visible only when selected */}
                    {selectedSamples.has(s.id) && (
                      <div style={{
                        position: "absolute", top: 4, left: 4, zIndex: 10,
                        width: 18, height: 18, borderRadius: "50%",
                        background: "#59c3f5", display: "flex",
                        alignItems: "center", justifyContent: "center",
                        fontSize: 11, color: "#000", fontWeight: 700,
                        pointerEvents: "none",
                      }}>✓</div>
                    )}
                    {images[s.id]
                      ? <img src={images[s.id]} alt={s.patient_id}
                          style={{ width: "100%", height: "auto",
                            display: "block", imageRendering: "auto" }} />
                      : <div style={{
                          aspectRatio,
                          background: "#111",
                          display: "flex", alignItems: "center",
                          justifyContent: "center",
                          color: "#2a2a2a", fontSize: 20 }}>
                          {isLoading ? "." : "-"}
                        </div>
                    }
                    {/* Field bubbles — absolutely positioned at bottom, zero extra height */}
                    {tags.length > 0 && (
                      <div style={{
                        position: "absolute", bottom: 0, left: 0, right: 0,
                        maxHeight: "100%", overflowY: "auto",
                        pointerEvents: "none",
                      }}>
                        {tags.map(({ color, title, value }, i) => (
                          <span key={i}
                            title={title}
                            style={{
                              display: "inline-block",
                              backgroundColor: color,
                              padding: "2px 4px",
                              borderRadius: 3,
                              fontWeight: "bold",
                              fontSize: Math.max(9, Math.round(colSize * 0.065)),
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              maxWidth: "calc(100% - 8px)",
                              margin: "1px",
                              pointerEvents: "auto",
                            }}>
                            {value}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  );
                })
          }
        </div>
      </div>

      {/* Status bar */}
      <div style={{ flexShrink: 0, paddingTop: 4, fontSize: 11, color: "#555",
        borderTop: "1px solid #222" }}>
        {isLoading ? "Loading..." : status}
        <span style={{ marginLeft: 8 }}>({samples.length} patients · {activeView})</span>
      </div>
    </div>
  );
}

export { BratsPanel };
