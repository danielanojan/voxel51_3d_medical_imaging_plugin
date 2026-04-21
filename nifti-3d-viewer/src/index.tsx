import { registerComponent, PluginComponentType } from "@fiftyone/plugins";
import { useOperatorExecutor } from "@fiftyone/operators";
import * as fos from "@fiftyone/state";
import { useRecoilValue } from "recoil";
import { useState, useEffect, useRef, useCallback } from "react";
import { Niivue } from "@niivue/niivue";

// Colourmap palette — assigned by index to each seg overlay
const SEG_COLORMAPS = ["red", "warm", "violet", "green", "blue", "hot", "cool"];

const LAYOUT_OPTIONS = [
  { value: 3, label: "4-Up"     },
  { value: 0, label: "Axial"    },
  { value: 1, label: "Coronal"  },
  { value: 2, label: "Sagittal" },
  { value: 4, label: "3D"       },
];

const S = {
  root: {
    display: "flex", flexDirection: "column" as const,
    height: "100%", background: "#0d0d0f",
    color: "#e2e4ea", fontFamily: "'DM Mono', monospace", fontSize: 12,
    overflow: "hidden",
  },
  toolbar: {
    display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" as const,
    padding: "8px 12px", borderBottom: "1px solid #1e2028",
    background: "rgba(255,255,255,0.02)", flexShrink: 0,
  },
  title: {
    fontSize: 11, fontWeight: 700, letterSpacing: "0.1em",
    textTransform: "uppercase" as const, color: "#5ac8fa", marginRight: "auto",
  },
  btn: (active: boolean) => ({
    padding: "3px 10px", borderRadius: 4, cursor: "pointer",
    fontSize: 11, fontFamily: "monospace",
    border: `1px solid ${active ? "#5ac8fa" : "#2a2d36"}`,
    background: active ? "rgba(90,200,250,0.1)" : "transparent",
    color: active ? "#5ac8fa" : "#7a7f8e",
    transition: "all 0.15s",
  }),
  canvasWrap: {
    flex: 1, minHeight: 0, position: "relative" as const, overflow: "hidden",
    background: "#0a0a0a", display: "flex", flexDirection: "column" as const,
  },
  canvas: { width: "100%", height: "100%", display: "block", minHeight: 0, flex: 1 },
  info: {
    padding: "6px 12px", fontSize: 10, color: "#5a5f6e",
    borderTop: "1px solid #1e2028", flexShrink: 0,
    background: "rgba(0,0,0,0.3)",
  },
  notice: {
    flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
    color: "#3a3d48", fontSize: 13,
  },
  loadingOverlay: {
    position: "absolute" as const, inset: 0, display: "flex",
    alignItems: "center", justifyContent: "center",
    background: "rgba(13,13,15,0.8)", color: "#5ac8fa",
    fontSize: 12, letterSpacing: "0.1em",
  },
};

function NiftiNiivuePanel() {
  const modalSample  = useRecoilValue(fos.modalSample as any);
  const activeSample = modalSample?.sample ?? modalSample;
  const datasetName  = useRecoilValue(fos.datasetName);
  const sampleId     = activeSample?._id ?? activeSample?.id ?? null;
  const samplePath   = activeSample?.filepath ?? "";
  const isNiftiSample = /\.nii(\.gz)?$/i.test(samplePath)
    || !!(activeSample?.nifti_path)
    || !!(activeSample?.nifti_t1c_path);

  const nvRef         = useRef<any>(null);
  const canvasElRef   = useRef<HTMLCanvasElement | null>(null);
  const urlsRef       = useRef<any>(null);
  const activeSegsRef = useRef<Set<number>>(new Set());  // indices into segs array

  const [layout,     setLayout]     = useState(3);
  const [activeSegs, setActiveSegs] = useState<Set<number>>(new Set());
  const [urls,       setUrls]       = useState<any>(null);
  const [loading,    setLoading]    = useState(false);
  const [status,     setStatus]     = useState("");
  const urlsCacheRef  = useRef<Map<string, any>>(new Map());
  const fetchStartRef = useRef<number>(0);

  const executor = useOperatorExecutor("@daniel/nifti-3d-viewer/get_nifti_urls");

  // ── build NiiVue volume list from active seg indices ──────────────────────
  const doLoadVolumes = useCallback((nv: any, data: any) => {
    const u = data?.result ?? data;
    if (!u?.ct_url) {
      console.warn("[NIFTI] ct_url missing", data);
      setStatus("❌ ct_url missing");
      return;
    }

    const segs: any[] = u.segs ?? [];
    const volumes: any[] = [
      { url: u.ct_url, name: "volume.nii.gz", colormap: "gray", opacity: 1.0 }
    ];

    activeSegsRef.current.forEach((idx) => {
      const seg = segs[idx];
      if (seg?.url) {
        volumes.push({
          url: seg.url,
          name: `seg_${idx}.nii.gz`,
          colormap: SEG_COLORMAPS[idx % SEG_COLORMAPS.length],
          opacity: 0.6,
          colorbarVisible: false,
        });
      }
    });

    setLoading(true);
    setStatus(`⏳ Loading ${volumes.length - 1} overlay(s)…`);
    const tStart = performance.now();

    nv.loadVolumes(volumes)
      .then(() => {
        setStatus(`✅ Loaded in ${(performance.now() - tStart).toFixed(0)}ms`);
        setLoading(false);
      })
      .catch((e: any) => {
        console.error("[NIFTI] loadVolumes failed:", e);
        setStatus(`❌ ${e}`);
        setLoading(false);
      });
  }, []);

  // ── canvas callback ref ────────────────────────────────────────────────────
  const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasElRef.current = canvas;
    if (!canvas) { nvRef.current = null; return; }
    requestAnimationFrame(() => {
      const parent = canvas.parentElement;
      canvas.width  = parent?.clientWidth  || 800;
      canvas.height = parent?.clientHeight || 600;
      const nv = new Niivue({
        isResizeCanvas: true, show3Dcrosshair: true,
        backColor: [0.04, 0.04, 0.06, 1],
        crosshairColor: [0.35, 0.78, 0.98, 1],
        sliceType: 3,
      });
      nv.attachToCanvas(canvas);
      nvRef.current = nv;
      if (urlsRef.current) doLoadVolumes(nv, urlsRef.current);
    });
  }, [doLoadVolumes]);

  // ── fetch when sample changes ──────────────────────────────────────────────
  useEffect(() => {
    if (!sampleId || !datasetName || !isNiftiSample) {
      setUrls(null); urlsRef.current = null; setLoading(false); return;
    }
    const key = `${datasetName}:${sampleId}`;
    if (urlsCacheRef.current.has(key)) {
      const cached = urlsCacheRef.current.get(key);
      urlsRef.current = cached; setUrls(cached); setStatus("(from cache)");
      if (nvRef.current) doLoadVolumes(nvRef.current, cached);
      return;
    }
    setLoading(true); setStatus("⏳ Fetching URLs…");
    fetchStartRef.current = performance.now();
    executor.execute({ sample_id: sampleId, dataset_name: datasetName });
  }, [sampleId, datasetName, isNiftiSample]);

  // ── consume executor.result ────────────────────────────────────────────────
  useEffect(() => {
    if (!executor.result) return;
    const dt = (performance.now() - fetchStartRef.current).toFixed(1);
    const key = `${datasetName}:${sampleId}`;
    urlsCacheRef.current.set(key, executor.result);
    urlsRef.current = executor.result;
    setUrls(executor.result);
    setLoading(false); setStatus(`URLs fetched in ${dt}ms`);
    if (nvRef.current) doLoadVolumes(nvRef.current, executor.result);
  }, [executor.result]);

  // ── toggle seg overlay by index ────────────────────────────────────────────
  const toggleSeg = useCallback((idx: number) => {
    setActiveSegs(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      activeSegsRef.current = next;
      if (nvRef.current && urlsRef.current) doLoadVolumes(nvRef.current, urlsRef.current);
      return next;
    });
  }, [doLoadVolumes]);

  // ── layout change ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (nvRef.current) nvRef.current.setSliceType(layout);
  }, [layout]);

  // ── resize observer ────────────────────────────────────────────────────────
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!wrapRef.current) return;
    const obs = new ResizeObserver(() => {
      if (nvRef.current && canvasElRef.current && wrapRef.current) {
        canvasElRef.current.width  = wrapRef.current.clientWidth;
        canvasElRef.current.height = wrapRef.current.clientHeight;
        nvRef.current.resizeListener();
      }
    });
    obs.observe(wrapRef.current);
    return () => obs.disconnect();
  }, []);

  if (!sampleId)      return <div style={S.root}><div style={S.notice}>Select an image to open the NIfTI viewer</div></div>;
  if (!isNiftiSample) return <div style={S.root}><div style={S.notice}>Select a sample with a NIfTI file or nifti_t1c_path field</div></div>;

  const u    = urls?.result ?? urls;
  const pid  = u?.sample_label ?? "…";
  const segs: any[] = u?.segs ?? [];

  return (
    <div style={S.root}>

      <div style={S.toolbar}>
        <span style={S.title}>NIfTI 3D — {pid}</span>
        {LAYOUT_OPTIONS.map(o => (
          <button key={o.value} style={S.btn(layout === o.value)} onClick={() => setLayout(o.value)}>
            {o.label}
          </button>
        ))}
      </div>

      {segs.length > 0 && (
        <div style={{ ...S.toolbar, borderTop: "none", paddingTop: 4 }}>
          <span style={{ color: "#5a5f6e", fontSize: 10, marginRight: 4 }}>SEG:</span>
          {segs.map((seg: any, idx: number) => (
            <button key={idx} style={S.btn(activeSegs.has(idx))} onClick={() => toggleSeg(idx)}>
              {seg.label}
            </button>
          ))}
        </div>
      )}

      <div ref={wrapRef} style={S.canvasWrap}>
        <canvas ref={canvasRef} style={S.canvas} />
        {loading && <div style={S.loadingOverlay}>{status || "LOADING…"}</div>}
      </div>

      <div style={S.info}>
        {pid}
        {status && !loading && <span style={{ marginLeft: 12, color: "#34c759" }}>{status}</span>}
      </div>

    </div>
  );
}

registerComponent({
  name:      "NiftiNiivuePanel",
  label:     "NIfTI 3D Viewer",
  component: NiftiNiivuePanel,
  type:      PluginComponentType.Panel,
  activator: () => true,
  panelOptions: { surfaces: "modal" },
});
