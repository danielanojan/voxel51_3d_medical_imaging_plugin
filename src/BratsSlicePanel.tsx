import * as fos from "@fiftyone/state";
import { getColor } from "@fiftyone/utilities";
import { useOperatorExecutor } from "@fiftyone/operators";
import React, { useEffect, useRef, useState } from "react";
import { useRecoilState, useRecoilValue } from "recoil";

// Discrete zoom steps (column min-width px): small → large
const SIZES = [90, 130, 180, 240, 320, 420, 560];
const DEFAULT_SIZE_IDX = 2;

// ── Image cache ────────────────────────────────────────────────────────────────
const MAX_CACHE_ENTRIES = 2000;

function imgKey(id: string, f: number, flags: Record<string, boolean>): string {
  const flagStr = Object.keys(flags).sort().map(k => +flags[k]).join("");
  return `${id}:${f}:${flagStr}`;
}

function cacheSet(cache: Map<string, string>, key: string, value: string): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
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
function buildTags(
  activePaths: string[],
  sample: Sample,
  coloring: { pool: readonly string[]; seed: number; by: string } | undefined
): Array<{ color: string; title: string; value: string }> {
  if (!activePaths?.length || !coloring) return [];
  const tags: Array<{ color: string; title: string; value: string }> = [];
  for (const path of activePaths) {
    if (path === "tags") {
      for (const tag of (sample.tags as string[]) ?? []) {
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

  const [activeView, setActiveView] = useState<string>("");
  const [frame,      setFrame]      = useState(0);
  const [maxSlices,  setMaxSlices]  = useState(1);
  const [maskFlags,  setMaskFlags]  = useState<Record<string, boolean>>({});
  const [sizeIdx,    setSizeIdx]    = useState(DEFAULT_SIZE_IDX);
  const colSize = SIZES[sizeIdx];
  const [samples, setSamples] = useState<Sample[]>([]);
  const [images,  setImages]  = useState<Record<string, string>>({});
  const [status,  setStatus]  = useState("Loading config...");

  const imageCache = useRef<Map<string, string>>(new Map());
  const samplesRef   = useRef<Sample[]>([]);
  const frameRef     = useRef(frame);
  const maskFlagsRef = useRef(maskFlags);
  const maxSlicesRef = useRef(maxSlices);
  const configRef    = useRef<SliceViewerConfig | null>(null);
  useEffect(() => { frameRef.current = frame; },         [frame]);
  useEffect(() => { maskFlagsRef.current = maskFlags; }, [maskFlags]);
  useEffect(() => { maxSlicesRef.current = maxSlices; }, [maxSlices]);
  useEffect(() => { configRef.current = config; },       [config]);

  const configOp   = useOperatorExecutor("@daniel/brats-slice-viewer/get_slice_viewer_config");
  const listOp     = useOperatorExecutor("@daniel/brats-slice-viewer/list_slice_samples");
  const batchOp    = useOperatorExecutor("@daniel/brats-slice-viewer/load_slice_batch");
  const prefetchOp = useOperatorExecutor("@daniel/brats-slice-viewer/load_slice_batch");

  const lastBatchFlagsRef    = useRef<Record<string, boolean>>({});
  const lastPrefetchRef      = useRef<{ flags: Record<string, boolean>; frame: number }>({ flags: {}, frame: 0 });

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
    const list = samplesRef.current;
    if (!list.length) return;
    const immediate: Record<string, string> = {};
    const missing: string[] = [];
    for (const s of list) {
      const url = imageCache.current.get(imgKey(s.id, f, flags));
      if (url !== undefined) immediate[s.id] = url;
      else missing.push(s.id);
    }
    if (Object.keys(immediate).length > 0) setImages(prev => ({ ...prev, ...immediate }));
    if (missing.length > 0) {
      setStatus(`Loading ${missing.length}/${list.length} images, slice ${f}...`);
      lastBatchFlagsRef.current = flags;
      batchOp.execute({ sample_ids: missing, frame: f, mask_flags: flags });
    } else {
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

  // Handle batch result — populate cache, display images, trigger prefetch
  useEffect(() => {
    const res = batchOp.result as any;
    if (!res?.ok) return;
    const updated: Record<string, string> = {};
    let ok = 0;
    const flags = lastBatchFlagsRef.current;
    for (const r of res.results ?? []) {
      if (r.ok) {
        cacheSet(imageCache.current, imgKey(r.sample_id, r.frame, flags), r.image);
        updated[r.sample_id] = r.image;
        ok++;
      }
    }
    setStatus(`${ok} images loaded`);
    setImages(prev => ({ ...prev, ...updated }));

    // Prefetch next frame so forward scrubbing feels instant
    const nextF = frameRef.current + 1;
    if (nextF < maxSlicesRef.current && samplesRef.current.length > 0 && !prefetchOp.isExecuting) {
      const notCached = samplesRef.current.filter(
        s => !imageCache.current.has(imgKey(s.id, nextF, flags))
      );
      if (notCached.length > 0) {
        lastPrefetchRef.current = { flags, frame: nextF };
        prefetchOp.execute({ sample_ids: notCached.map(s => s.id), frame: nextF, mask_flags: flags });
      }
    }
  }, [batchOp.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle prefetch result — populate cache; display if user is already on that frame
  useEffect(() => {
    const res = prefetchOp.result as any;
    if (!res?.ok) return;
    const { flags } = lastPrefetchRef.current;
    const displayNow: Record<string, string> = {};
    for (const r of res.results ?? []) {
      if (r.ok) {
        cacheSet(imageCache.current, imgKey(r.sample_id, r.frame, flags), r.image);
        if (r.frame === frameRef.current) displayNow[r.sample_id] = r.image;
      }
    }
    if (Object.keys(displayNow).length > 0) setImages(prev => ({ ...prev, ...displayNow }));
  }, [prefetchOp.result]); // eslint-disable-line react-hooks/exhaustive-deps

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
            onChange={e => setFrame(Number(e.target.value))} />
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
                          style={{ width: "100%", height: "auto",
                            display: "block", imageRendering: "auto" }} />
                      : <div style={{
                          aspectRatio: "1",
                          background: "#111",
                          display: "flex", alignItems: "center",
                          justifyContent: "center",
                          color: "#2a2a2a", fontSize: 20 }}>
                          {isLoading ? "." : "-"}
                        </div>
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
        borderTop: "1px solid #222" }}>
        {isLoading ? "Loading..." : status}
        <span style={{ marginLeft: 8 }}>
          ({samples.length} samples{activeView ? ` · ${activeView}` : ""})
        </span>
      </div>
    </div>
  );
}

export { BratsPanel };
