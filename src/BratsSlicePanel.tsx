import { useOperatorExecutor } from "@fiftyone/operators";
import { selectedSamples, useSetSelected } from "@fiftyone/state";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRecoilValue } from "recoil";
import styled from "styled-components";

type View = "axial" | "coronal" | "sagittal";

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

// All layout uses inline styles to avoid styled-components dual-instance issue.
const panelStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", height: "100%",
  padding: "12px 16px", fontSize: "13px", color: "#ddd",
  background: "#1a1a1a", overflow: "hidden", boxSizing: "border-box",
};

const controlsStyle: React.CSSProperties = {
  display: "flex", flexWrap: "wrap", alignItems: "center",
  gap: "16px", paddingBottom: "12px", borderBottom: "1px solid #333", flexShrink: 0,
};

// alignContent:"start" prevents CSS Grid from stretching rows to fill panel height.
// Without it, 171 samples / ~3 cols = ~57 rows each only ~12px tall (looks like lines).
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  alignContent: "start",
  gap: "10px", paddingTop: "12px",
  overflowY: "auto", flex: 1, minHeight: 0,
};

const tileStyle: React.CSSProperties = {
  background: "#242424", borderRadius: "6px", overflow: "hidden",
};

const tileMetaStyle: React.CSSProperties = {
  display: "flex", flexWrap: "wrap", gap: "4px", padding: "4px 8px 8px",
};

// Styled-components only for interactive controls — border/background are dynamic.
const ViewGroup = styled.div`display: flex; gap: 4px;`;

const ViewBtn = styled.button<{ $active: boolean }>`
  padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px;
  border: 1px solid ${p => (p.$active ? "#f97316" : "#444")};
  background: ${p => (p.$active ? "#f97316" : "transparent")};
  color: ${p => (p.$active ? "#fff" : "#aaa")};
  &:hover { border-color: #f97316; }
`;

const SliderRow = styled.div`
  display: flex; align-items: center; gap: 8px; flex: 1; min-width: 180px;
`;

const Slider = styled.input`flex: 1; accent-color: #f97316;`;

const MaskGroup = styled.div`display: flex; gap: 12px;`;

const MaskLabel = styled.label<{ $color: string }>`
  display: flex; align-items: center; gap: 4px; cursor: pointer;
  color: ${p => p.$color};
  input { accent-color: ${p => p.$color}; cursor: pointer; }
`;

const MetaBadge = styled.span<{ $accent?: boolean }>`
  padding: 2px 5px; border-radius: 999px; font-size: 10px; line-height: 1.4;
  background: ${p => (p.$accent ? "#3a2a18" : "#2d2d2d")};
  color: ${p => (p.$accent ? "#ffb36a" : "#9a9a9a")};
`;

const StatusBar = styled.div`
  font-size: 11px; color: #555; padding-top: 6px; flex-shrink: 0;
`;

export function BratsSlicePanel() {
  const [view, setView] = useState<View>("axial");
  const [frame, setFrame] = useState(80);
  const [maxSlices, setMaxSlices] = useState(155);
  const [showNcr, setShowNcr] = useState(true);
  const [showEd, setShowEd] = useState(true);
  const [showEt, setShowEt] = useState(true);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const selectedMap = useRecoilValue(selectedSamples);
  const setSelected = useSetSelected();

  const samplesRef = useRef<Sample[]>([]);
  const frameRef   = useRef(frame);
  const maskRef    = useRef({ showNcr, showEd, showEt });
  useEffect(() => { samplesRef.current = samples; }, [samples]);
  useEffect(() => { frameRef.current = frame; }, [frame]);
  useEffect(() => { maskRef.current = { showNcr, showEd, showEt }; }, [showNcr, showEd, showEt]);

  const listSamples = useOperatorExecutor("@daniel/brats-slice-viewer/list_brats_samples");
  const loadBatch   = useOperatorExecutor("@daniel/brats-slice-viewer/load_brats_slice_batch");

  const triggerLoad = useCallback(
    (list: Sample[], f: number, ncr: boolean, ed: boolean, et: boolean) => {
      if (list.length === 0) return;
      loadBatch.execute({ sample_ids: list.map(s => s.id), frame: f, show_ncr: ncr, show_ed: ed, show_et: et });
    },
    [] // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    setImages({});
    listSamples.execute({ view });
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const res = listSamples.result as any;
    if (!res?.ok) return;
    const newSamples: Sample[] = res.samples ?? [];
    setSamples(newSamples);
    samplesRef.current = newSamples;
    const maxN = newSamples.reduce((m: number, s: Sample) => Math.max(m, s.num_slices), 1);
    setMaxSlices(maxN);
    const f = Math.min(frameRef.current, maxN - 1);
    setFrame(f); frameRef.current = f;
    const { showNcr: ncr, showEd: ed, showEt: et } = maskRef.current;
    triggerLoad(newSamples, f, ncr, ed, et);
  }, [listSamples.result]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const res = loadBatch.result as any;
    if (!res?.ok) return;
    const updated: Record<string, string> = {};
    for (const r of res.results ?? []) {
      if (r.ok) updated[r.sample_id] = r.image;
    }
    setImages(prev => ({ ...prev, ...updated }));
  }, [loadBatch.result]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const list = samplesRef.current;
    if (list.length === 0) return;
    const t = setTimeout(() => {
      triggerLoad(list, frame, showNcr, showEd, showEt);
    }, 80);
    return () => clearTimeout(t);
  }, [frame, showNcr, showEd, showEt]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLoading = listSamples.isExecuting || loadBatch.isExecuting;

  const onTileClick = useCallback((id: string, multi: boolean) => {
    setSelected(current => {
      const next = multi ? new Map(current) : new Map<string, "default" | "alt">();
      if (multi && next.has(id)) next.delete(id); else next.set(id, "default");
      return next;
    });
  }, [setSelected]);

  return (
    <div style={panelStyle}>
      <div style={controlsStyle}>
        <ViewGroup>
          {(["axial", "coronal", "sagittal"] as View[]).map(v => (
            <ViewBtn key={v} $active={view === v} onClick={() => setView(v)}>
              {v[0].toUpperCase() + v.slice(1)}
            </ViewBtn>
          ))}
        </ViewGroup>

        <SliderRow>
          <span>Slice</span>
          <Slider type="range" min={0} max={maxSlices - 1} value={frame}
            onChange={e => setFrame(Number(e.target.value))} />
          <span style={{ minWidth: "5ch", textAlign: "right" }}>{frame} / {maxSlices - 1}</span>
        </SliderRow>

        <MaskGroup>
          <MaskLabel $color="#ff4444">
            <input type="checkbox" checked={showNcr} onChange={e => setShowNcr(e.target.checked)} /> NCR
          </MaskLabel>
          <MaskLabel $color="#ffa500">
            <input type="checkbox" checked={showEd} onChange={e => setShowEd(e.target.checked)} /> ED
          </MaskLabel>
          <MaskLabel $color="#ff00ff">
            <input type="checkbox" checked={showEt} onChange={e => setShowEt(e.target.checked)} /> ET
          </MaskLabel>
        </MaskGroup>
      </div>

      <div style={gridStyle}>
        {samples.map(s => (
          <div key={s.id} style={tileStyle}>
            <button
              type="button"
              style={{
                display: "flex", flexDirection: "column", width: "100%",
                padding: 0, boxSizing: "border-box", cursor: "pointer",
                border: `1px solid ${selectedMap.has(s.id) ? "#f97316" : "#303030"}`,
                borderRadius: "6px", background: "transparent", overflow: "hidden",
              }}
              onClick={e => onTileClick(s.id, e.metaKey || e.ctrlKey)}
              title={s.patient_id}
            >
              <div style={{ padding: "3px 8px", fontSize: 10, color: "#666", borderBottom: "1px solid #2e2e2e", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", width: "100%", boxSizing: "border-box" }}>
                {s.patient_id}
              </div>

              {images[s.id]
                ? <img src={images[s.id]} alt={s.patient_id} style={{ width: "100%", height: "auto", display: "block", imageRendering: "pixelated" }} />
                : <div style={{ height: 130, background: "#111", display: "flex", alignItems: "center", justifyContent: "center", color: "#333", fontSize: 18 }}>
                    {isLoading ? "·" : "–"}
                  </div>
              }

              <div style={tileMetaStyle}>
                {s.has_seg && <MetaBadge $accent>{s.masked_slice_count} masked</MetaBadge>}
                {s.has_ncr && <MetaBadge>NCR {s.ncr_slice_count}</MetaBadge>}
                {s.has_ed  && <MetaBadge>ED {s.ed_slice_count}</MetaBadge>}
                {s.has_et  && <MetaBadge>ET {s.et_slice_count}</MetaBadge>}
              </div>
            </button>
          </div>
        ))}

        {samples.length === 0 && listSamples.isExecuting && (
          <div style={{ color: "#555", padding: 8 }}>Fetching samples…</div>
        )}
        {samples.length === 0 && !listSamples.isExecuting && (
          <div style={{ color: "#555", padding: 8 }}>No samples for {view}.</div>
        )}
      </div>

      <StatusBar>
        {isLoading
          ? "Loading…"
          : `${samples.length} samples · ${view} · ${Object.keys(images).length} images · ${selectedMap.size} selected`}
      </StatusBar>
    </div>
  );
}
