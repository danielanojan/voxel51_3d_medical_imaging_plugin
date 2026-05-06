import { registerComponent, PluginComponentType } from "@fiftyone/plugins";
import { useOperatorExecutor } from "@fiftyone/operators";
import * as fos from "@fiftyone/state";
import { useRecoilValue } from "recoil";
import { useState, useEffect, useRef, useCallback } from "react";
import { Niivue } from "@niivue/niivue";

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
  label: {
    fontSize: 10, color: "#5a5f6e", marginRight: 4, flexShrink: 0,
  },
  btn: (active: boolean) => ({
    padding: "3px 10px", borderRadius: 4, cursor: "pointer",
    fontSize: 11, fontFamily: "monospace",
    border: `1px solid ${active ? "#5ac8fa" : "#2a2d36"}`,
    background: active ? "rgba(90,200,250,0.1)" : "transparent",
    color: active ? "#5ac8fa" : "#7a7f8e",
    transition: "all 0.15s",
  }),
  btnMod: (active: boolean) => ({
    padding: "3px 8px", borderRadius: 4, cursor: "pointer",
    fontSize: 11, fontFamily: "monospace",
    border: `1px solid ${active ? "#f97316" : "#2a2d36"}`,
    background: active ? "rgba(249,115,22,0.12)" : "transparent",
    color: active ? "#f97316" : "#7a7f8e",
    transition: "all 0.15s",
  }),
  btnCompare: (active: boolean) => ({
    padding: "3px 10px", borderRadius: 4, cursor: "pointer",
    fontSize: 11, fontFamily: "monospace", marginLeft: "auto",
    border: `1px solid ${active ? "#34c759" : "#2a2d36"}`,
    background: active ? "rgba(52,199,89,0.12)" : "transparent",
    color: active ? "#34c759" : "#7a7f8e",
    transition: "all 0.15s",
  }),
  select: {
    padding: "3px 8px", borderRadius: 4, cursor: "pointer",
    fontSize: 11, fontFamily: "monospace",
    border: "1px solid #2a2d36", background: "#13151a",
    color: "#f97316", outline: "none", minWidth: 90,
  },
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

// ── SingleNiivue ─────────────────────────────────────────────────────────────
// Self-contained Niivue canvas used in both single and grid (compare) mode.

interface SingleNiivueProps {
  label?: string;
  volumeUrl: string;
  segs: any[];
  activeSegs: Set<number>;
  layout: number;
  // crosshair sync (optional — only wired in compare mode)
  onMove?: (frac: number[]) => void;
  registerSync?: (fn: (frac: number[]) => void) => () => void;
}

function SingleNiivue({ label, volumeUrl, segs, activeSegs, layout, onMove, registerSync }: SingleNiivueProps) {
  const nvRef       = useRef<any>(null);
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef     = useRef<HTMLDivElement>(null);
  const isSyncingRef = useRef(false);
  const [loading, setLoading] = useState(false);

  const buildVolumes = (url: string, segSet: Set<number>, segList: any[]) => {
    const vols: any[] = [{ url, name: "volume.nii.gz", colormap: "gray", opacity: 1.0 }];
    segSet.forEach(idx => {
      const seg = segList[idx];
      if (seg?.url) vols.push({
        url: seg.url, name: `seg_${idx}.nii.gz`,
        colormap: SEG_COLORMAPS[idx % SEG_COLORMAPS.length],
        opacity: 0.6, colorbarVisible: false,
      });
    });
    return vols;
  };

  const loadVolumes = useCallback((nv: any, url: string, segSet: Set<number>, segList: any[]) => {
    if (!url) return;
    setLoading(true);
    nv.loadVolumes(buildVolumes(url, segSet, segList))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line

  // Mount: create Niivue and load initial volume
  const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasElRef.current = canvas;
    if (!canvas) { nvRef.current = null; return; }
    requestAnimationFrame(() => {
      const parent = canvas.parentElement;
      canvas.width  = parent?.clientWidth  || 400;
      canvas.height = parent?.clientHeight || 300;
      const nv = new Niivue({
        isResizeCanvas: true, show3Dcrosshair: true,
        backColor: [0.04, 0.04, 0.06, 1],
        crosshairColor: [0.35, 0.78, 0.98, 1],
        sliceType: layout,
      });
      nv.attachToCanvas(canvas);
      nvRef.current = nv;
      // broadcast crosshair position to sibling viewers
      nv.onLocationChange = (loc: any) => {
        if (isSyncingRef.current || !onMove || !loc?.frac) return;
        onMove(loc.frac);
      };
      if (volumeUrl) loadVolumes(nv, volumeUrl, activeSegs, segs);
    });
  }, []); // eslint-disable-line — intentionally run once on mount

  // Register as a sync target so siblings can move our crosshair
  useEffect(() => {
    if (!registerSync) return;
    return registerSync((frac: number[]) => {
      const nv = nvRef.current;
      if (!nv?.scene) return;
      isSyncingRef.current = true;
      nv.scene.crosshairPos = frac;
      nv.drawScene();
      isSyncingRef.current = false;
    });
  }, [registerSync]);

  // Reload when url or active segs change
  useEffect(() => {
    if (nvRef.current && volumeUrl) loadVolumes(nvRef.current, volumeUrl, activeSegs, segs);
  }, [volumeUrl, activeSegs, segs, loadVolumes]);

  // Layout change
  useEffect(() => {
    if (nvRef.current) nvRef.current.setSliceType(layout);
  }, [layout]);

  // Resize observer
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

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden" }}>
      {label && (
        <div style={{
          fontSize: 9, color: "#f97316", padding: "2px 6px", background: "#0d0d0f",
          flexShrink: 0, letterSpacing: "0.1em", textTransform: "uppercase" as const,
          borderBottom: "1px solid #1e2028",
        }}>
          {label}
        </div>
      )}
      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <canvas ref={canvasRef} style={S.canvas} />
        {loading && <div style={{ ...S.loadingOverlay, fontSize: 10 }}>LOADING…</div>}
      </div>
    </div>
  );
}


// ── Main panel ────────────────────────────────────────────────────────────────

function NiftiNiivuePanel() {
  const modalSample  = useRecoilValue(fos.modalSample as any);
  const activeSample = modalSample?.sample ?? modalSample;
  const datasetName  = useRecoilValue(fos.datasetName);
  const sampleId     = activeSample?._id ?? activeSample?.id ?? null;
  const samplePath   = activeSample?.filepath ?? "";
  const isNiftiSample = /\.nii(\.gz)?$/i.test(samplePath)
    || !!(activeSample?.nifti_path)
    || !!(activeSample?.nifti_t1c_path);

  // Single-viewer state (used when compareMode === false)
  const nvRef          = useRef<any>(null);
  const canvasElRef    = useRef<HTMLCanvasElement | null>(null);
  const urlsRef        = useRef<any>(null);
  const activeSegsRef  = useRef<Set<number>>(new Set());
  const activeCtUrlRef = useRef<string>("");

  const [layout,       setLayout]       = useState(3);
  const [activeSegs,   setActiveSegs]   = useState<Set<number>>(new Set());
  const [activeMod,    setActiveMod]    = useState<string>("");
  const [compareMode,  setCompareMode]  = useState(false);
  const [selectedMods, setSelectedMods] = useState<Set<string>>(new Set());
  const [urls,         setUrls]         = useState<any>(null);
  const [loading,      setLoading]      = useState(false);
  const [status,       setStatus]       = useState("");
  const urlsCacheRef   = useRef<Map<string, any>>(new Map());
  const fetchStartRef  = useRef<number>(0);

  const executor = useOperatorExecutor("@daniel/nifti-3d-viewer/get_nifti_urls");

  // ── single-viewer volume loader ─────────────────────────────────────────────
  const doLoadVolumes = useCallback((nv: any, data: any, ctUrl?: string) => {
    const u = data?.result ?? data;
    const volumeUrl = ctUrl || activeCtUrlRef.current || u?.ct_url;
    if (!volumeUrl) { setStatus("❌ No volume URL"); return; }

    const segs: any[] = u.segs ?? [];
    const volumes: any[] = [{ url: volumeUrl, name: "volume.nii.gz", colormap: "gray", opacity: 1.0 }];
    activeSegsRef.current.forEach(idx => {
      const seg = segs[idx];
      if (seg?.url) volumes.push({
        url: seg.url, name: `seg_${idx}.nii.gz`,
        colormap: SEG_COLORMAPS[idx % SEG_COLORMAPS.length],
        opacity: 0.6, colorbarVisible: false,
      });
    });

    setLoading(true);
    setStatus("⏳ Loading…");
    const t0 = performance.now();
    nv.loadVolumes(volumes)
      .then(() => { setStatus(`✅ ${(performance.now() - t0).toFixed(0)}ms`); setLoading(false); })
      .catch((e: any) => { setStatus(`❌ ${e}`); setLoading(false); });
  }, []);

  // ── single-viewer canvas ────────────────────────────────────────────────────
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
      if (urlsRef.current) doLoadVolumes(nv, urlsRef.current, activeCtUrlRef.current);
    });
  }, [doLoadVolumes]);

  // ── fetch URLs when sample changes ─────────────────────────────────────────
  useEffect(() => {
    if (!sampleId || !datasetName || !isNiftiSample) {
      setUrls(null); urlsRef.current = null; setLoading(false);
      activeCtUrlRef.current = ""; setActiveMod(""); setSelectedMods(new Set()); return;
    }
    const key = `${datasetName}:${sampleId}`;
    if (urlsCacheRef.current.has(key)) {
      _applyUrls(urlsCacheRef.current.get(key));
      setStatus("(cached)");
      return;
    }
    setLoading(true); setStatus("⏳ Fetching URLs…");
    fetchStartRef.current = performance.now();
    executor.execute({ sample_id: sampleId, dataset_name: datasetName });
  }, [sampleId, datasetName, isNiftiSample]); // eslint-disable-line

  const _applyUrls = (result: any) => {
    const u = result?.result ?? result;
    const modUrls: Record<string, string> = u?.modality_urls ?? {};
    const modKeys = Object.keys(modUrls);
    const defaultMod = modKeys[0] || "";
    const defaultUrl = (modKeys.length > 0 ? modUrls[modKeys[0]] : null) || u?.ct_url || "";
    activeCtUrlRef.current = defaultUrl;
    urlsRef.current = result;
    setUrls(result);
    setActiveMod(defaultMod);
    setSelectedMods(new Set([defaultMod]));
    if (nvRef.current) doLoadVolumes(nvRef.current, result, defaultUrl);
  };

  useEffect(() => {
    if (!executor.result) return;
    const key = `${datasetName}:${sampleId}`;
    urlsCacheRef.current.set(key, executor.result);
    setLoading(false);
    setStatus(`URLs in ${(performance.now() - fetchStartRef.current).toFixed(0)}ms`);
    _applyUrls(executor.result);
  }, [executor.result]); // eslint-disable-line

  // ── single-viewer modality switch ───────────────────────────────────────────
  const switchModality = useCallback((name: string, url: string) => {
    setActiveMod(name);
    activeCtUrlRef.current = url;
    if (nvRef.current && urlsRef.current) doLoadVolumes(nvRef.current, urlsRef.current, url);
  }, [doLoadVolumes]);

  // ── seg overlay toggle ──────────────────────────────────────────────────────
  const toggleSeg = useCallback((idx: number) => {
    setActiveSegs(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      activeSegsRef.current = next;
      if (nvRef.current && urlsRef.current)
        doLoadVolumes(nvRef.current, urlsRef.current, activeCtUrlRef.current);
      return next;
    });
  }, [doLoadVolumes]);

  // ── layout change (single viewer) ──────────────────────────────────────────
  useEffect(() => {
    if (nvRef.current) nvRef.current.setSliceType(layout);
  }, [layout]);

  // ── resize observer (single viewer) ────────────────────────────────────────
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

  // ── crosshair sync registry for compare mode ────────────────────────────────
  const syncListenersRef = useRef<Set<(frac: number[]) => void>>(new Set());

  const registerSync = useCallback((fn: (frac: number[]) => void) => {
    syncListenersRef.current.add(fn);
    return () => { syncListenersRef.current.delete(fn); };
  }, []);

  const broadcastPosition = useCallback((frac: number[]) => {
    syncListenersRef.current.forEach(fn => fn(frac));
  }, []);

  // ── compare mode helpers ────────────────────────────────────────────────────
  const toggleModSelection = (name: string) => {
    setSelectedMods(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        if (next.size > 1) next.delete(name); // always keep at least one
      } else {
        next.add(name);
      }
      return next;
    });
  };

  // ── render ──────────────────────────────────────────────────────────────────
  if (!sampleId)      return <div style={S.root}><div style={S.notice}>Select an image to open the NIfTI viewer</div></div>;
  if (!isNiftiSample) return <div style={S.root}><div style={S.notice}>Select a sample with a NIfTI file or nifti_path field</div></div>;

  const u       = urls?.result ?? urls;
  const pid     = u?.sample_label ?? "…";
  const segs: any[]                     = u?.segs ?? [];
  const modUrls: Record<string, string> = u?.modality_urls ?? {};
  const modKeys = Object.keys(modUrls);

  const compareEntries = [...selectedMods]
    .filter(m => modUrls[m])
    .map(m => ({ name: m, url: modUrls[m] }));
  const gridCols = compareEntries.length <= 2
    ? compareEntries.length
    : Math.ceil(Math.sqrt(compareEntries.length));
  const gridRows = Math.ceil(compareEntries.length / gridCols);

  return (
    <div style={S.root}>

      {/* Row 1 — layout */}
      <div style={S.toolbar}>
        <span style={S.title}>NIfTI 3D — {pid}</span>
        {LAYOUT_OPTIONS.map(o => (
          <button key={o.value} style={S.btn(layout === o.value)} onClick={() => setLayout(o.value)}>
            {o.label}
          </button>
        ))}
      </div>

      {/* Row 2 — modality: dropdown (single) or toggle buttons (compare) */}
      {modKeys.length > 0 && (
        <div style={{ ...S.toolbar, borderTop: "none", paddingTop: 4 }}>
          <span style={S.label}>MOD:</span>
          {compareMode
            ? modKeys.map(name => (
                <button key={name} style={S.btnMod(selectedMods.has(name))}
                  onClick={() => toggleModSelection(name)}>
                  {name}
                </button>
              ))
            : (
              <select value={activeMod}
                onChange={e => switchModality(e.target.value, modUrls[e.target.value])}
                style={S.select}>
                {modKeys.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            )
          }
          <button style={S.btnCompare(compareMode)} onClick={() => {
            if (!compareMode) setSelectedMods(new Set([activeMod || modKeys[0]]));
            setCompareMode(c => !c);
          }}>
            {compareMode ? "✕ Compare" : "⊞ Compare"}
          </button>
        </div>
      )}

      {/* Row 3 — segmentation overlays (apply to all viewers) */}
      {segs.length > 0 && (
        <div style={{ ...S.toolbar, borderTop: "none", paddingTop: 4 }}>
          <span style={S.label}>SEG:</span>
          {segs.map((seg: any, idx: number) => (
            <button key={idx} style={S.btn(activeSegs.has(idx))} onClick={() => toggleSeg(idx)}>
              {seg.label}
            </button>
          ))}
        </div>
      )}

      {/* Main area — compare grid or single viewer */}
      {compareMode && compareEntries.length > 0 ? (
        <div style={{
          flex: 1, minHeight: 0, overflow: "hidden",
          display: "grid",
          gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
          gridTemplateRows: `repeat(${gridRows}, 1fr)`,
          gap: 4, padding: 4,
          background: "#080809",
        }}>
          {compareEntries.map(({ name, url }) => (
            <SingleNiivue
              key={name}
              label={name}
              volumeUrl={url}
              segs={segs}
              activeSegs={activeSegs}
              layout={layout}
              onMove={broadcastPosition}
              registerSync={registerSync}
            />
          ))}
        </div>
      ) : (
        <div ref={wrapRef} style={S.canvasWrap}>
          <canvas ref={canvasRef} style={S.canvas} />
          {loading && <div style={S.loadingOverlay}>{status || "LOADING…"}</div>}
        </div>
      )}

      {/* Status bar */}
      <div style={S.info}>
        {pid}
        {compareMode
          ? <span style={{ marginLeft: 8, color: "#34c759" }}>COMPARE · {[...selectedMods].join(" · ")}</span>
          : activeMod && <span style={{ marginLeft: 8, color: "#f97316" }}>{activeMod}</span>
        }
        {!loading && status && <span style={{ marginLeft: 12, color: "#5a5f6e" }}>{status}</span>}
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
