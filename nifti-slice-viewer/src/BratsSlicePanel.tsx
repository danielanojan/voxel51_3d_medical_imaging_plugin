import * as fos from "@fiftyone/state";
import { getColor } from "@fiftyone/utilities";
import { useOperatorExecutor } from "@fiftyone/operators";
import React, { useEffect, useRef, useState } from "react";
import { useRecoilState, useRecoilValue } from "recoil";

const SHIMMER_CSS = `
@keyframes shimmer {
  0%   { background-position: -400px 0; }
  100% { background-position:  400px 0; }
}
.slice-shimmer {
  background: linear-gradient(90deg, #1a1a1a 25%, #2a2a2a 50%, #1a1a1a 75%);
  background-size: 800px 100%;
  animation: shimmer 1.4s infinite linear;
}
`;

// Discrete zoom steps (column min-width px): small → large
const SIZES = [90, 130, 180, 240, 320, 420, 560];
const DEFAULT_SIZE_IDX = 2;

// ── Image cache ────────────────────────────────────────────────────────────────
const MAX_CACHE_ENTRIES = 2000;

function imgKey(id: string, f: number, flags: Record<string, boolean>): string {
  const flagStr = Object.keys(flags).sort().map(k => +flags[k]).join("");
  return `${id}:${f}:${flagStr}`;
}

// LRU cache: Map insertion order tracks recency. get() moves key to end (MRU),
// set() re-inserts to update order, eviction always removes the first key (LRU).
function cacheGet(cache: Map<string, string>, key: string): string | undefined {
  const val = cache.get(key);
  if (val !== undefined) { cache.delete(key); cache.set(key, val); }
  return val;
}

function cacheSet(cache: Map<string, string>, key: string, value: string): void {
  if (cache.has(key)) cache.delete(key);
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const lru = cache.keys().next();
    if (!lru.done) cache.delete(lru.value);
  }
  cache.set(key, value);
}

// ── Types ──────────────────────────────────────────────────────────────────────
interface MaskClass {
  name: string;
  value: number;
  color: [number, number, number];
}

interface SliceViewerConfig {
  is_grouped: boolean;
  views: string[];
  mask_classes: MaskClass[];
  fields: { slices_dir: string; masks_dir: string; num_slices: string };
}

type Sample = Record<string, unknown> & { id: string; group_id: string };

// ── Field bubbles ──────────────────────────────────────────────────────────────

// In FiftyOne grouped datasets, activePaths may be slice-prefixed
// (e.g. "axial.patient_id"). Strip the prefix so coronal/sagittal samples
// (whose dicts use bare field names) still match.
function resolveField(sample: Sample, path: string): unknown {
  if (path in sample) return sample[path];
  const dot = path.indexOf(".");
  if (dot !== -1) {
    const bare = path.slice(dot + 1);
    if (bare in sample) return sample[bare];
  }
  return undefined;
}

function buildTags(
  activePaths: string[],
  sample: Sample,
  coloring: { pool: readonly string[]; seed: number; by: string } | undefined
): Array<{ color: string; title: string; value: string }> {
  if (!activePaths?.length || !coloring) return [];
  const tags: Array<{ color: string; title: string; value: string }> = [];
  for (const path of activePaths) {
    if (path === "tags" || path.endsWith(".tags")) {
      for (const tag of (sample.tags as string[]) ?? []) {
        tags.push({ color: getColor(coloring.pool, coloring.seed, tag), title: tag, value: tag });
      }
    } else {
      const raw = resolveField(sample, path);
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

function rgbStr(color: [number, number, number]): string {
  return `rgb(${color[0]},${color[1]},${color[2]})`;
}

// ── Panel ──────────────────────────────────────────────────────────────────────
function BratsPanel() {
  const setExpandedSample = fos.useSetExpandedSample();
  const lookerOptions     = fos.useLookerOptions(false);
  const fosView           = useRecoilValue(fos.view) ?? [];
  const fosFilters        = useRecoilValue(fos.filters);
  const fosExtended       = useRecoilValue(fos.extendedStages);
  const [selectedSamples, setSelectedSamples] = useRecoilState(fos.selectedSamples);
  const viewKey = JSON.stringify([fosView, fosFilters, fosExtended]);

  // Plugin config — loaded from backend on mount, drives all dynamic behaviour
  const [config, setConfig] = useState<SliceViewerConfig | null>(null);

  const [activeView,   setActiveView]   = useState<string>("");
  const [frame,        setFrame]        = useState(0);
  const [maxSlices,    setMaxSlices]    = useState(1);
  const [maskFlags,    setMaskFlags]    = useState<Record<string, boolean>>({});
  const [sizeIdx,      setSizeIdx]      = useState(DEFAULT_SIZE_IDX);
  const [visibleCount, setVisibleCount] = useState(20);
  const colSize = SIZES[sizeIdx];
  const [samples,    setSamples]    = useState<Sample[]>([]);
  const [images,     setImages]     = useState<Record<string, string>>({});
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [status,     setStatus]     = useState("Loading config...");
  const directionRef  = useRef<1 | -1>(1);

  const imageCache     = useRef<Map<string, string>>(new Map());
  const gridScrollRef  = useRef<HTMLDivElement>(null);
  const samplesRef     = useRef<Sample[]>([]);
  const frameRef       = useRef(frame);
  const maskFlagsRef   = useRef(maskFlags);
  const maxSlicesRef   = useRef(maxSlices);
  const windowSizeRef  = useRef(visibleCount);
  const colSizeRef     = useRef(colSize);
  const configRef      = useRef<SliceViewerConfig | null>(null);
  useEffect(() => { frameRef.current = frame; },             [frame]);
  useEffect(() => { maskFlagsRef.current = maskFlags; },     [maskFlags]);
  useEffect(() => { maxSlicesRef.current = maxSlices; },     [maxSlices]);
  useEffect(() => { windowSizeRef.current = visibleCount; }, [visibleCount]);
  useEffect(() => { colSizeRef.current = colSize; },         [colSize]);
  useEffect(() => { configRef.current = config; },           [config]);

  // Auto-calculate how many tiles are visible in the scroll viewport
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const compute = () => {
      const GAP = 6;
      const w = el.clientWidth;
      const h = el.clientHeight;
      const cols = Math.max(1, Math.floor((w + GAP) / (colSizeRef.current + GAP)));
      const rows = Math.max(1, Math.ceil(h / (colSizeRef.current + GAP)));
      setVisibleCount(cols * rows);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Recompute when tile size changes (colSize drives both cols and row height)
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const GAP = 6;
    const cols = Math.max(1, Math.floor((el.clientWidth + GAP) / (colSize + GAP)));
    const rows = Math.max(1, Math.ceil(el.clientHeight / (colSize + GAP)));
    setVisibleCount(cols * rows);
  }, [colSize]);

  const configOp    = useOperatorExecutor("@daniel/nifti-slice-viewer/get_slice_viewer_config");
  const listOp      = useOperatorExecutor("@daniel/nifti-slice-viewer/list_slice_samples");
  const batchOp     = useOperatorExecutor("@daniel/nifti-slice-viewer/load_slice_batch");
  const restBatchOp = useOperatorExecutor("@daniel/nifti-slice-viewer/load_slice_batch");
  const prefetchOp  = useOperatorExecutor("@daniel/nifti-slice-viewer/load_slice_batch");
  const prefetch2Op = useOperatorExecutor("@daniel/nifti-slice-viewer/load_slice_batch");

  const lastBatchFlagsRef = useRef<Record<string, boolean>>({});
  const lastRestFlagsRef  = useRef<Record<string, boolean>>({});
  const pendingRestRef    = useRef<{ ids: string[]; frame: number; flags: Record<string, boolean> }>({ ids: [], frame: 0, flags: {} });
  const lastPrefetchRef   = useRef<{ flags: Record<string, boolean>; frame: number }>({ flags: {}, frame: 0 });

  const toggleSelected = (id: string) => {
    setSelectedSamples((prev: Map<string, unknown>) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id); else next.set(id, "default");
      return next as any;
    });
  };

  const handleTileClick = (e: React.MouseEvent, sample: Sample) => {
    if (e.ctrlKey || e.metaKey) {
      toggleSelected(sample.id);
    } else {
      setExpandedSample({ id: sample.id, groupId: sample.group_id || undefined });
    }
  };

  const fireBatch = (f: number, flags: Record<string, boolean>) => {
    const list  = samplesRef.current;
    const wSize = windowSizeRef.current;
    if (!list.length) return;

    const windowSamples = list.slice(0, wSize);
    const restSamples   = list.slice(wSize);

    // Display any cached images from both window and rest immediately
    const immediate: Record<string, string> = {};
    const missingWindow: string[] = [];
    const missingRest:   string[] = [];

    for (const s of windowSamples) {
      const url = cacheGet(imageCache.current, imgKey(s.id, f, flags));
      if (url !== undefined) immediate[s.id] = url;
      else missingWindow.push(s.id);
    }
    for (const s of restSamples) {
      const url = cacheGet(imageCache.current, imgKey(s.id, f, flags));
      if (url !== undefined) immediate[s.id] = url;
      else missingRest.push(s.id);
    }

    if (Object.keys(immediate).length > 0) setImages(prev => ({ ...prev, ...immediate }));

    if (missingWindow.length > 0) {
      // Phase 1: load priority window; rest will follow in batchOp.result handler
      setLoadingIds(new Set([...missingWindow, ...missingRest]));
      setStatus(`Loading ${missingWindow.length} priority · ${missingRest.length} queued, slice ${f}...`);
      lastBatchFlagsRef.current = flags;
      pendingRestRef.current = { ids: missingRest, frame: f, flags };
      batchOp.execute({ sample_ids: missingWindow, frame: f, mask_flags: flags });
    } else if (missingRest.length > 0) {
      // Window all cached — go straight to background rest load
      setLoadingIds(new Set(missingRest));
      setStatus(`Loading ${missingRest.length} background images, slice ${f}...`);
      lastRestFlagsRef.current = flags;
      restBatchOp.execute({ sample_ids: missingRest, frame: f, mask_flags: flags });
    } else {
      setLoadingIds(new Set());
      setStatus(`${list.length} images (all cached)`);
    }
  };

  const reList = (v: string) => {
    setSamples([]);
    setImages({});
    samplesRef.current = [];
    imageCache.current.clear();
    listOp.execute({ view: v || null });
  };

  // Load config on mount
  useEffect(() => { configOp.execute({}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle config result — set state; the viewKey/activeView/config effect triggers first list
  useEffect(() => {
    const res = configOp.result as any;
    if (!res?.ok) return;
    const cfg: SliceViewerConfig = {
      is_grouped:   res.is_grouped,
      views:        res.views ?? [],
      mask_classes: res.mask_classes ?? [],
      fields:       res.fields ?? { slices_dir: "slices_dir", masks_dir: "masks_dir", num_slices: "num_slices" },
    };
    const initialFlags: Record<string, boolean> = {};
    for (const cls of cfg.mask_classes) initialFlags[cls.name] = true;
    setMaskFlags(initialFlags);
    maskFlagsRef.current = initialFlags;
    setActiveView(cfg.views[0] ?? "");
    setConfig(cfg);
  }, [configOp.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-list when config first loads, or when view/filters/sort/activeView changes.
  // config in deps ensures we wait for it; React batches the state updates from
  // the config handler so this fires once (not twice) when config arrives.
  useEffect(() => {
    if (!config) return;
    reList(activeView);
  }, [viewKey, activeView, config]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle list result — update maxSlices and trigger first batch
  useEffect(() => {
    const res = listOp.result as any;
    if (!res?.ok) return;
    const s: Sample[] = res.samples ?? [];
    samplesRef.current = s;
    setSamples(s);
    if (s.length > 0 && configRef.current) {
      const numSlicesField = configRef.current.fields.num_slices;
      const newMax = Math.max(...s.map(x => (x[numSlicesField] as number) || 0));
      setMaxSlices(newMax);
      maxSlicesRef.current = newMax;
      setFrame(f => Math.min(f, newMax - 1));
    }
    fireBatch(Math.min(frameRef.current, maxSlicesRef.current - 1), maskFlagsRef.current);
  }, [listOp.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle window batch result — display images, then fire rest batch + prefetch in parallel
  useEffect(() => {
    const res = batchOp.result as any;
    if (!res?.ok) return;
    const updated: Record<string, string> = {};
    let ok = 0;
    const flags = lastBatchFlagsRef.current;
    const loadedIds = new Set<string>();
    for (const r of res.results ?? []) {
      if (r.ok) {
        cacheSet(imageCache.current, imgKey(r.sample_id, r.frame, flags), r.image);
        updated[r.sample_id] = r.image;
        loadedIds.add(r.sample_id);
        ok++;
      }
    }
    setImages(prev => ({ ...prev, ...updated }));
    setLoadingIds(prev => { const n = new Set(prev); loadedIds.forEach(id => n.delete(id)); return n; });

    // Phase 2: fire background rest batch — skip if user already scrubbed to a new frame
    const { ids: restIds, frame: restFrame, flags: restFlags } = pendingRestRef.current;
    if (restFrame !== frameRef.current) return;
    const stillMissing = restIds.filter(id => !imageCache.current.has(imgKey(id, restFrame, restFlags)));
    if (stillMissing.length > 0) {
      setStatus(`${ok} loaded · loading ${stillMissing.length} in background...`);
      lastRestFlagsRef.current = restFlags;
      restBatchOp.execute({ sample_ids: stillMissing, frame: restFrame, mask_flags: restFlags });
    } else {
      setStatus(`${ok} images loaded`);
    }

    // Directional prefetch runs in parallel with rest batch
    const dir  = directionRef.current;
    const cur  = frameRef.current;
    const max  = maxSlicesRef.current;
    const list = samplesRef.current;
    if (!list.length) return;

    const tryPrefetch = (op: typeof prefetchOp, f: number) => {
      if (f < 0 || f >= max || op.isExecuting) return;
      const notCached = list.filter(s => !imageCache.current.has(imgKey(s.id, f, flags)));
      if (!notCached.length) return;
      lastPrefetchRef.current = { flags, frame: f };
      op.execute({ sample_ids: notCached.map(s => s.id), frame: f, mask_flags: flags });
    };

    tryPrefetch(prefetchOp,  cur + dir);
    tryPrefetch(prefetch2Op, cur + dir * 2);
  }, [batchOp.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle background rest batch result
  useEffect(() => {
    const res = restBatchOp.result as any;
    if (!res?.ok) return;
    const flags = lastRestFlagsRef.current;
    const updated: Record<string, string> = {};
    const loadedIds = new Set<string>();
    let ok = 0;
    for (const r of res.results ?? []) {
      if (r.ok) {
        cacheSet(imageCache.current, imgKey(r.sample_id, r.frame, flags), r.image);
        updated[r.sample_id] = r.image;
        loadedIds.add(r.sample_id);
        ok++;
      }
    }
    setImages(prev => ({ ...prev, ...updated }));
    setLoadingIds(prev => { const n = new Set(prev); loadedIds.forEach(id => n.delete(id)); return n; });
    setStatus(`${samplesRef.current.length} images loaded`);
  }, [restBatchOp.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared handler for prefetch results — populate cache; display if user is on that frame
  const handlePrefetchResult = (res: any) => {
    if (!res?.ok) return;
    const { flags } = lastPrefetchRef.current;
    const displayNow: Record<string, string> = {};
    const loadedIds = new Set<string>();
    for (const r of res.results ?? []) {
      if (r.ok) {
        cacheSet(imageCache.current, imgKey(r.sample_id, r.frame, flags), r.image);
        if (r.frame === frameRef.current) { displayNow[r.sample_id] = r.image; loadedIds.add(r.sample_id); }
      }
    }
    if (Object.keys(displayNow).length > 0) {
      setImages(prev => ({ ...prev, ...displayNow }));
      setLoadingIds(prev => { const n = new Set(prev); loadedIds.forEach(id => n.delete(id)); return n; });
    }
  };

  useEffect(() => handlePrefetchResult(prefetchOp.result),  [prefetchOp.result]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => handlePrefetchResult(prefetch2Op.result), [prefetch2Op.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload images on slice / mask change (debounced)
  useEffect(() => {
    const t = setTimeout(() => fireBatch(frame, maskFlags), 80);
    return () => clearTimeout(t);
  }, [frame, maskFlags]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLoading    = !config || listOp.isExecuting || batchOp.isExecuting;
  const sliderMax    = Math.max(maxSlices - 1, 0);
  const clampedFrame = Math.min(frame, sliderMax);

  if (!config) {
    return <div style={{ padding: 16, color: "#666", fontSize: 13 }}>Loading config...</div>;
  }

  return (
    <>
    <style>{SHIMMER_CSS}</style>
    <div style={{ display: "flex", flexDirection: "column", height: "100%",
      overflow: "hidden", padding: "12px 16px", fontSize: "13px",
      color: "#ddd", background: "#1a1a1a", boxSizing: "border-box" }}>

      {/* Controls */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center",
        gap: "12px", paddingBottom: "12px", borderBottom: "1px solid #333",
        flexShrink: 0 }}>

        {/* View selector — only shown for grouped datasets */}
        {config.views.length > 0 && (
          <div style={{ display: "flex", gap: 4 }}>
            {config.views.map(v => (
              <button key={v} type="button"
                onClick={() => setActiveView(v)}
                disabled={isLoading}
                style={{
                  padding: "3px 10px", borderRadius: 4, fontSize: 12,
                  cursor: isLoading ? "default" : "pointer",
                  border: "1px solid",
                  borderColor: activeView === v ? "#f97316" : "#444",
                  background:  activeView === v ? "#f9731622" : "transparent",
                  color:       activeView === v ? "#f97316" : "#888",
                  textTransform: "capitalize",
                  fontWeight: activeView === v ? 600 : 400,
                }}>
                {v}
              </button>
            ))}
          </div>
        )}

        {/* Slice slider */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 160 }}>
          <span style={{ whiteSpace: "nowrap", fontSize: 12, color: "#888" }}>Slice</span>
          <input type="range" min={0} max={sliderMax} value={clampedFrame}
            style={{ flex: 1, accentColor: "#f97316" }}
            onChange={e => {
              const next = Number(e.target.value);
              directionRef.current = next >= frameRef.current ? 1 : -1;
              setFrame(next);
            }} />
          <span style={{ minWidth: "7ch", textAlign: "right", fontSize: 12,
            fontVariantNumeric: "tabular-nums", color: "#aaa" }}>
            {clampedFrame}/{sliderMax}
          </span>
        </div>

        {/* Mask toggles — dynamic from config */}
        {config.mask_classes.length > 0 && (
          <div style={{ display: "flex", gap: 10 }}>
            {config.mask_classes.map(cls => {
              const color = rgbStr(cls.color);
              return (
                <label key={cls.name} style={{ display: "flex", alignItems: "center",
                  gap: 4, cursor: "pointer", color, fontSize: 12, textTransform: "uppercase" }}>
                  <input type="checkbox"
                    checked={maskFlags[cls.name] ?? true}
                    onChange={e => setMaskFlags(prev => ({ ...prev, [cls.name]: e.target.checked }))}
                    style={{ accentColor: color }} />
                  {cls.name}
                </label>
              );
            })}
          </div>
        )}

        {/* Size slider */}
        <input type="range" min={0} max={SIZES.length - 1} value={sizeIdx}
          title="Image size"
          style={{ width: 70, accentColor: "#f97316" }}
          onChange={e => setSizeIdx(Number(e.target.value))} />

        {/* Refresh */}
        <button type="button" onClick={() => reList(activeView)} disabled={isLoading}
          style={{ padding: "4px 8px", borderRadius: 4, fontSize: 12,
            cursor: isLoading ? "default" : "pointer",
            border: "1px solid #444", background: "transparent",
            color: isLoading ? "#555" : "#aaa", flexShrink: 0 }}>
          {isLoading ? "..." : "↻"}
        </button>
      </div>

      {/* Image grid */}
      <div ref={gridScrollRef} style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
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
                const tags = buildTags(
                  lookerOptions?.activePaths ?? [],
                  s,
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
                      ? <img src={images[s.id]} alt={s.id}
                          style={{ width: "100%", height: "auto", display: "block",
                            imageRendering: "auto",
                            opacity: loadingIds.has(s.id) ? 0.45 : 1,
                            transition: "opacity 0.15s ease" }} />
                      : <div className="slice-shimmer"
                          style={{ aspectRatio: "1" }} />
                    }
                    {tags.length > 0 && (
                      <div style={{
                        position: "absolute", bottom: 0, left: 0, right: 0,
                        maxHeight: "100%", overflowY: "auto",
                        pointerEvents: "none",
                      }}>
                        {tags.map(({ color, title, value }, i) => (
                          <span key={i} title={title} style={{
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
                          }}>{value}</span>
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
        borderTop: "1px solid #222", display: "flex", justifyContent: "space-between" }}>
        <span>{isLoading ? "Loading..." : status}</span>
        <span>
          {samples.length} samples{activeView ? ` · ${activeView}` : ""}
          {" · "}visible: {Math.min(visibleCount, samples.length)}
        </span>
      </div>
    </div>
    </>
  );
}

export { BratsPanel };
