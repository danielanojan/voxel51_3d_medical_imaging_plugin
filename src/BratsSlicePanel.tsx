import { useOperatorExecutor } from "@fiftyone/operators";
import React, { useEffect, useRef, useState } from "react";

type View = "axial" | "coronal" | "sagittal";
const LIMIT = 20;

interface Sample {
  id: string;
  patient_id: string;
  view: View;
  num_slices: number;
  has_seg: boolean;
  has_ncr: boolean;
  has_ed: boolean;
  has_et: boolean;
  masked_slice_count: number;
  ncr_slice_count: number;
  ed_slice_count: number;
  et_slice_count: number;
}

// Generic single-view panel -- no styled-components, no recoil.
function BratsViewPanel({ view }: { view: View }) {
  const [frame, setFrame]     = useState(80);
  const [showNcr, setShowNcr] = useState(true);
  const [showEd,  setShowEd]  = useState(true);
  const [showEt,  setShowEt]  = useState(true);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [images,  setImages]  = useState<Record<string, string>>({});
  const [status,  setStatus]  = useState("Listing...");

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

  // List on mount
  useEffect(() => {
    listOp.execute({ view });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle list result
  useEffect(() => {
    const res = listOp.result as any;
    if (!res?.ok) return;
    const s: Sample[] = (res.samples ?? []).slice(0, LIMIT);
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

  // Reload on slider / mask change (debounced)
  useEffect(() => {
    const t = setTimeout(() => fireBatch(frame, showNcr, showEd, showEt), 80);
    return () => clearTimeout(t);
  }, [frame, showNcr, showEd, showEt]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLoading = listOp.isExecuting || batchOp.isExecuting;
  const aspectRatio = view === "axial" ? "1" : "240/155";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%",
      overflow: "hidden", padding: "12px 16px", fontSize: "13px",
      color: "#ddd", background: "#1a1a1a", boxSizing: "border-box" }}>

      {/* Controls */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center",
        gap: "16px", paddingBottom: "12px", borderBottom: "1px solid #333",
        flexShrink: 0 }}>

        <div style={{ fontSize: 12, fontWeight: 600, color: "#888",
          textTransform: "uppercase", letterSpacing: "0.08em", minWidth: 70 }}>
          {view}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8,
          flex: 1, minWidth: 200 }}>
          <span style={{ whiteSpace: "nowrap", fontSize: 12 }}>Slice</span>
          <input type="range" min={0} max={154} value={frame}
            style={{ flex: 1, accentColor: "#f97316" }}
            onChange={e => setFrame(Number(e.target.value))} />
          <span style={{ minWidth: "3ch", textAlign: "right", fontSize: 12 }}>{frame}</span>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
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
      </div>

      {/* Image grid — outer div scrolls, inner div is the grid.
          Keeping them separate fixes the clip-instead-of-scroll bug. */}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
      <div style={{ paddingTop: 10,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
        alignContent: "start",
        gap: 8 }}>
        {samples.length === 0
          ? <div style={{ color: "#444", fontSize: 12, padding: 8 }}>
              {isLoading ? "Listing samples..." : "No samples"}
            </div>
          : samples.map(s => (
              <div key={s.id} style={{ background: "#1e1e1e", borderRadius: 5,
                overflow: "hidden", border: "1px solid #2a2a2a" }}>
                <div style={{ padding: "3px 6px", fontSize: 10, color: "#555",
                  whiteSpace: "nowrap", overflow: "hidden",
                  textOverflow: "ellipsis" }}>
                  {s.patient_id}
                </div>
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
              </div>
            ))
        }
      </div>
      </div>

      {/* Status bar */}
      <div style={{ flexShrink: 0, paddingTop: 5, fontSize: 11, color: "#555",
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
