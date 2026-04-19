import * as fos from "@fiftyone/state";
import { getColor } from "@fiftyone/utilities";
import { useOperatorExecutor } from "@fiftyone/operators";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRecoilValue } from "recoil";

type View = "axial" | "coronal" | "sagittal";

// Discrete zoom steps (column min-width px): small → large
const SIZES = [90, 130, 180, 240, 320, 420, 560];
const DEFAULT_SIZE_IDX = 2; // 180px = reasonable default

const DEFAULT_FILTER = () => true;

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

// No styled-components. recoil/fos.view are externalized (host app instance) -- safe to use.
function BratsViewPanel({ view }: { view: View }) {
  const [frame,   setFrame]   = useState(80);
  const [showNcr, setShowNcr] = useState(true);
  const [showEd,  setShowEd]  = useState(true);
  const [showEt,  setShowEt]  = useState(true);
  // sizeIdx indexes into SIZES; – button decreases cols (zooms in), + increases cols (zooms out)
  const [sizeIdx, setSizeIdx] = useState(DEFAULT_SIZE_IDX);
  const colSize = SIZES[sizeIdx];
  const [samples, setSamples] = useState<Sample[]>([]);
  const [images,  setImages]  = useState<Record<string, string>>({});
  const [status,  setStatus]  = useState("Listing...");

  // Native FiftyOne field display — same color palette as GridTagBubbles
  const lookerOptions = fos.useLookerOptions(false);

  // Track all three state atoms that can change what samples are shown:
  //   fos.view          — committed view pipeline stages (saved views)
  //   fos.filters       — ephemeral sidebar filters (range sliders, tag filters)
  //   fos.extendedStages — sort order + field visibility + sample selection
  // None of these imply the others; all three must be watched independently.
  const fosView       = useRecoilValue(fos.view) ?? [];
  const fosFilters    = useRecoilValue(fos.filters);
  const fosExtended   = useRecoilValue(fos.extendedStages);
  const viewKey = JSON.stringify([fosView, fosFilters, fosExtended]);

  const samplesRef = useRef<Sample[]>([]);
  const frameRef   = useRef(frame);
  const maskRef    = useRef({ showNcr, showEd, showEt });
  useEffect(() => { frameRef.current = frame; }, [frame]);
  useEffect(() => { maskRef.current = { showNcr, showEd, showEt }; }, [showNcr, showEd, showEt]);

  const listOp  = useOperatorExecutor("@daniel/brats-slice-viewer/list_brats_samples");
  const batchOp = useOperatorExecutor("@daniel/brats-slice-viewer/load_brats_slice_batch");

  const fireBatch = (f: number, ncr: boolean, ed: boolean, et: boolean) => {
    const list = samplesRef.current;
    if (!list.length) return;
    setStatus("Loading " + list.length + " images, slice " + f + "...");
    batchOp.execute({ sample_ids: list.map(s => s.id), frame: f, show_ncr: ncr, show_ed: ed, show_et: et });
  };

  const reList = () => {
    setSamples([]);
    setImages({});
    samplesRef.current = [];
    listOp.execute({ view });
  };

  // List on mount
  useEffect(() => { listOp.execute({ view }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh when committed view, sidebar filters, or sort order changes.
  // Skip the very first render — the mount effect above already fired.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return; }
    reList();
  }, [viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle list result
  useEffect(() => {
    const res = listOp.result as any;
    if (!res?.ok) return;
    const s: Sample[] = res.samples ?? [];
    samplesRef.current = s;
    setSamples(s);
    const { showNcr, showEd, showEt } = maskRef.current;
    fireBatch(frameRef.current, showNcr, showEd, showEt);
  }, [listOp.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle batch result
  useEffect(() => {
    const res = batchOp.result as any;
    if (!res?.ok) return;
    const updated: Record<string, string> = {};
    let ok = 0;
    for (const r of res.results ?? []) {
      if (r.ok) { updated[r.sample_id] = r.image; ok++; }
    }
    setStatus(ok + " images loaded");
    setImages(prev => ({ ...prev, ...updated }));
  }, [batchOp.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload images on slice / mask change (debounced)
  useEffect(() => {
    const t = setTimeout(() => fireBatch(frame, showNcr, showEd, showEt), 80);
    return () => clearTimeout(t);
  }, [frame, showNcr, showEd, showEt]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLoading = listOp.isExecuting || batchOp.isExecuting;
  const aspectRatio = view === "axial" ? "1" : "240/155";
  // Slider value: invert so left=small thumbnails (zoomed out), right=large (zoomed in)
  // We store colSize directly and display an inverted slider.

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%",
      overflow: "hidden", padding: "12px 16px", fontSize: "13px",
      color: "#ddd", background: "#1a1a1a", boxSizing: "border-box" }}>

      {/* Controls */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center",
        gap: "12px", paddingBottom: "12px", borderBottom: "1px solid #333",
        flexShrink: 0 }}>

        {/* View label */}
        <div style={{ fontSize: 12, fontWeight: 600, color: "#888",
          textTransform: "uppercase", letterSpacing: "0.08em", minWidth: 60 }}>
          {view}
        </div>

        {/* Slice slider */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 160 }}>
          <span style={{ whiteSpace: "nowrap", fontSize: 12, color: "#888" }}>Slice</span>
          <input type="range" min={0} max={154} value={frame}
            style={{ flex: 1, accentColor: "#f97316" }}
            onChange={e => setFrame(Number(e.target.value))} />
          <span style={{ minWidth: "3ch", textAlign: "right", fontSize: 12 }}>{frame}</span>
        </div>

        {/* Mask toggles */}
        <div style={{ display: "flex", gap: 10 }}>
          {([
            ["NCR", "#ff4444", showNcr, setShowNcr],
            ["ED",  "#ffa500", showEd,  setShowEd],
            ["ET",  "#ff00ff", showEt,  setShowEt],
          ] as const).map(([label, color, val, setter]) => (
            <label key={label} style={{ display: "flex", alignItems: "center",
              gap: 4, cursor: "pointer", color, fontSize: 12 }}>
              <input type="checkbox" checked={val}
                onChange={e => (setter as any)(e.target.checked)}
                style={{ accentColor: color }} />
              {label}
            </label>
          ))}
        </div>

        {/* Size slider */}
        <input type="range" min={0} max={SIZES.length - 1} value={sizeIdx}
          title="Image size"
          style={{ width: 70, accentColor: "#f97316" }}
          onChange={e => setSizeIdx(Number(e.target.value))} />

        {/* Refresh — also available manually in case auto-sync missed something */}
        <button type="button" onClick={reList} disabled={isLoading}
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
                  const tags = buildTags(
                    lookerOptions?.activePaths ?? [],
                    s as any,
                    lookerOptions?.coloring as any,
                  );

                  return (
                  <div key={s.id} style={{ position: "relative", background: "#1e1e1e",
                    borderRadius: 4, overflow: "hidden", border: "1px solid #2a2a2a" }}>
                    {images[s.id]
                      ? <img src={images[s.id]} alt={s.patient_id}
                          style={{ width: "100%", height: "auto",
                            display: "block", imageRendering: "pixelated" }} />
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
        <span style={{ marginLeft: 8 }}>({samples.length} patients)</span>
      </div>
    </div>
  );
}

export function BratsAxialPanel()    { return <BratsViewPanel view="axial" />; }
export function BratsCoronalPanel()  { return <BratsViewPanel view="coronal" />; }
export function BratsSagittalPanel() { return <BratsViewPanel view="sagittal" />; }
