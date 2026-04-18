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

// ── Layout ────────────────────────────────────────────────────────────────────

// ── Inline layout constants (immune to styled-components dual-instance issues) ──
const panelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  padding: "12px 16px",
  fontSize: "13px",
  color: "#ddd",
  background: "#1a1a1a",
  overflow: "hidden",
  boxSizing: "border-box",
};
const controlsStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "16px",
  paddingBottom: "12px",
  borderBottom: "1px solid #333",
  flexShrink: 0,
};
const gridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
  alignContent: "start",   // rows size to content; do NOT stretch to fill height
  gap: "10px",
  paddingTop: "12px",
  overflowY: "auto",       // scroll within the flex child
  flex: 1,
  minHeight: 0,            // allow flex child to shrink so scroll context forms
};
const tileStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  background: "#242424",
  borderRadius: "6px",
  overflow: "hidden",
};

const ViewGroup = styled.div`
  display: flex;
  gap: 4px;
`;

const ViewBtn = styled.button<{ $active: boolean }>`
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid ${p => (p.$active ? "#f97316" : "#444")};
  background: ${p => (p.$active ? "#f97316" : "transparent")};
  color: ${p => (p.$active ? "#fff" : "#aaa")};
  cursor: pointer;
  font-size: 12px;
  &:hover { border-color: #f97316; }
`;

const SliderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 180px;
`;

const Slider = styled.input`
  flex: 1;
  accent-color: #f97316;
`;

const MaskGroup = styled.div`
  display: flex;
  gap: 12px;
`;

const MaskLabel = styled.label<{ $color: string }>`
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  color: ${p => p.$color};
  input { accent-color: ${p => p.$color}; cursor: pointer; }
`;

// kept: only styled-components with dynamic props or non-layout styles remain below

// ── Inline style constants (match FiftyOne looker approach) ──────────────────
// FiftyOne's built-in grid sets an explicit pixel height on each tile via the
// Spotlight layout engine, then renders a <canvas position:absolute object-fit:contain>
// inside it. We mirror this: padding-bottom % gives a stable height from the
// grid cell width, then the image fills it absolutely with object-fit:contain.
const tileButtonBase: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  boxSizing: "border-box",
  padding: 0,
  borderRadius: "6px",
  background: "transparent",
  overflow: "hidden",
  cursor: "pointer",
  textAlign: "left",
};

// image aspect-ratio wrapper — same trick FiftyOne uses for thumbnail containers.
// width comes from the grid cell; padding-bottom: 75% sets height = 0.75 × width.
const imgWrapStyle: React.CSSProperties = {
  position: "relative",
  width: "100%",
  paddingBottom: "75%",   // 4:3 — good for both 240×240 and 240×155 slices
  overflow: "hidden",
  background: "#111",
};

// fills the wrapper absolutely, like FiftyOne's .lookerCanvas
const imgFillStyle: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  height: "100%",
  objectFit: "contain",
  imageRendering: "pixelated",
  display: "block",
};

const placeholderStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#3a3a3a",
  fontSize: "11px",
};

const tileMetaStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "6px",
  padding: "6px 8px 8px",
};

const TileLabel = styled.div`
  padding: 4px 8px;
  font-size: 11px;
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const MetaBadge = styled.span<{ $accent?: boolean }>`
  padding: 2px 6px;
  border-radius: 999px;
  background: ${p => (p.$accent ? "#3a2a18" : "#2d2d2d")};
  color: ${p => (p.$accent ? "#ffb36a" : "#9a9a9a")};
  font-size: 10px;
  line-height: 1.4;
`;

const StatusBar = styled.div`
  font-size: 11px;
  color: #555;
  padding-top: 6px;
  flex-shrink: 0;
`;

// ── Component ─────────────────────────────────────────────────────────────────

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

  // Refs keep latest values accessible inside effects without stale closures
  const samplesRef = useRef<Sample[]>([]);
  const frameRef = useRef(frame);
  const maskRef = useRef({ showNcr, showEd, showEt });
  useEffect(() => { samplesRef.current = samples; }, [samples]);
  useEffect(() => { frameRef.current = frame; }, [frame]);
  useEffect(() => { maskRef.current = { showNcr, showEd, showEt }; }, [showNcr, showEd, showEt]);

  const listSamples = useOperatorExecutor(
    "@daniel/brats-slice-viewer/list_brats_samples"
  );
  const loadBatch = useOperatorExecutor(
    "@daniel/brats-slice-viewer/load_brats_slice_batch"
  );

  const triggerLoad = useCallback(
    (sampleList: Sample[], f: number, ncr: boolean, ed: boolean, et: boolean) => {
      if (sampleList.length === 0) return;
      loadBatch.execute({
        sample_ids: sampleList.map(s => s.id),
        frame: f,
        show_ncr: ncr,
        show_ed: ed,
        show_et: et,
      });
    },
    // loadBatch.execute is stable across renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Fetch sample list whenever view changes
  useEffect(() => {
    setImages({});
    listSamples.execute({ view });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // When sample list arrives: update state and load first batch
  useEffect(() => {
    const res = listSamples.result as any;
    if (!res?.ok) return;
    const newSamples: Sample[] = res.samples ?? [];
    setSamples(newSamples);
    samplesRef.current = newSamples;
    const maxN = newSamples.reduce((m: number, s: Sample) => Math.max(m, s.num_slices), 1);
    setMaxSlices(maxN);
    const f = Math.min(frameRef.current, maxN - 1);
    setFrame(f);
    frameRef.current = f;
    const { showNcr: ncr, showEd: ed, showEt: et } = maskRef.current;
    triggerLoad(newSamples, f, ncr, ed, et);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listSamples.result]);

  // When batch arrives: merge into image map
  useEffect(() => {
    const res = loadBatch.result as any;
    if (!res?.ok) return;
    const updated: Record<string, string> = {};
    for (const r of res.results ?? []) {
      if (r.ok) updated[r.sample_id] = r.image;
    }
    setImages(prev => ({ ...prev, ...updated }));
  }, [loadBatch.result]);

  // Reload on frame / mask change (debounced)
  useEffect(() => {
    const sampleList = samplesRef.current;
    if (sampleList.length === 0) return;
    const t = setTimeout(() => {
      triggerLoad(sampleList, frame, showNcr, showEd, showEt);
    }, 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, showNcr, showEd, showEt]);

  const isLoading = listSamples.isExecuting || loadBatch.isExecuting;

  const onTileClick = useCallback((sampleId: string, multiSelect: boolean) => {
    setSelected((current) => {
      const next = multiSelect ? new Map(current) : new Map<string, "default" | "alt">();
      if (multiSelect && next.has(sampleId)) {
        next.delete(sampleId);
      } else {
        next.set(sampleId, "default");
      }
      return next;
    });
  }, [setSelected]);

  return (
    <div style={panelStyle}>
      <div style={controlsStyle}>
        <ViewGroup>
          {(["axial", "coronal", "sagittal"] as View[]).map(v => (
            <ViewBtn key={v} $active={view === v} onClick={() => setView(v)}>
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </ViewBtn>
          ))}
        </ViewGroup>

        <SliderRow>
          <span>Slice</span>
          <Slider
            type="range"
            min={0}
            max={maxSlices - 1}
            value={frame}
            onChange={e => setFrame(Number(e.target.value))}
          />
          <span style={{ minWidth: "5ch", textAlign: "right" }}>
            {frame} / {maxSlices - 1}
          </span>
        </SliderRow>

        <MaskGroup>
          <MaskLabel $color="#ff4444">
            <input type="checkbox" checked={showNcr} onChange={e => setShowNcr(e.target.checked)} />
            NCR
          </MaskLabel>
          <MaskLabel $color="#ffa500">
            <input type="checkbox" checked={showEd} onChange={e => setShowEd(e.target.checked)} />
            ED
          </MaskLabel>
          <MaskLabel $color="#ff00ff">
            <input type="checkbox" checked={showEt} onChange={e => setShowEt(e.target.checked)} />
            ET
          </MaskLabel>
        </MaskGroup>
      </div>

      <div style={gridStyle}>
        {samples.map(s => (
          <div key={s.id} style={tileStyle}>
            {/* Plain <button> with inline styles — avoids styled-components dual-instance problem */}
            <button
              type="button"
              style={{
                ...tileButtonBase,
                border: `1px solid ${selectedMap.has(s.id) ? "#f97316" : "#303030"}`,
              }}
              onClick={(e) => onTileClick(s.id, e.metaKey || e.ctrlKey)}
              title={`${s.patient_id} · ${s.view}`}
            >
              <TileLabel>{s.patient_id}</TileLabel>
              {/* FiftyOne pattern: position:relative wrapper gives explicit height;
                  position:absolute img fills it with object-fit:contain */}
              <div style={imgWrapStyle}>
                {images[s.id]
                  ? <img src={images[s.id]} alt={s.patient_id} style={imgFillStyle} />
                  : <div style={placeholderStyle}>·</div>
                }
              </div>
              <div style={tileMetaStyle}>
                <MetaBadge $accent>{s.masked_slice_count} masked</MetaBadge>
                {s.has_ncr && <MetaBadge>NCR {s.ncr_slice_count}</MetaBadge>}
                {s.has_ed && <MetaBadge>ED {s.ed_slice_count}</MetaBadge>}
                {s.has_et && <MetaBadge>ET {s.et_slice_count}</MetaBadge>}
              </div>
            </button>
          </div>
        ))}
        {samples.length === 0 && !listSamples.isExecuting && (
          <div style={{ color: "#555", padding: "8px" }}>
            No samples match the current sidebar filters for {view}.
          </div>
        )}
        {samples.length === 0 && listSamples.isExecuting && (
          <div style={{ color: "#555", padding: "8px" }}>Fetching samples…</div>
        )}
      </div>

      <StatusBar>
        {isLoading
          ? "Loading…"
          : `${samples.length} samples · ${view} · ${Object.keys(images).length} images loaded · ${selectedMap.size} selected`}
      </StatusBar>
    </div>
  );
}
