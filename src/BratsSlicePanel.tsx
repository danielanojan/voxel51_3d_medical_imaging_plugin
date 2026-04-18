import { useOperatorExecutor } from "@fiftyone/operators";
import React, { useEffect, useRef, useState } from "react";

type View = "axial" | "coronal" | "sagittal";
type Phase =
  | "init"
  | "listing-axial"
  | "listing-coronal"
  | "listing-sagittal"
  | "loading"
  | "done"
  | "error";

interface SampleMeta { id: string; patient_id: string; }

const VIEWS: View[] = ["axial", "coronal", "sagittal"];
const LIMIT = 10; // samples per view

// 10-image test — no controls, no selection, no mask overlays.
// Lists up to 10 samples per view then batch-loads all 30 images.
export function BratsSlicePanel() {
  const listSamples = useOperatorExecutor(
    "@daniel/brats-slice-viewer/list_brats_samples"
  );
  const loadBatch = useOperatorExecutor(
    "@daniel/brats-slice-viewer/load_brats_slice_batch"
  );

  const [phaseDisplay, setPhaseDisplay] = useState<Phase>("init");
  const [images, setImages] = useState<Record<string, string>>({});
  const [log, setLog] = useState<string[]>([]);
  const [allSamples, setAllSamples] = useState<SampleMeta[]>([]);

  const phaseRef = useRef<Phase>("init");
  const viewSamples = useRef<Partial<Record<View, SampleMeta[]>>>({});

  const setPhase = (p: Phase) => {
    phaseRef.current = p;
    setPhaseDisplay(p);
  };
  const addLog = (msg: string) => setLog((l) => [...l.slice(-50), msg]);

  // On mount: start axial listing
  useEffect(() => {
    addLog("Starting 10-image test...");
    addLog("-> listing axial (limit " + LIMIT + ")");
    setPhase("listing-axial");
    listSamples.execute({ view: "axial" });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // React to list results — chain axial → coronal → sagittal
  useEffect(() => {
    const res = listSamples.result as any;
    if (res == null) return;
    if (!res.ok) { addLog("list ERROR: " + JSON.stringify(res)); setPhase("error"); return; }

    const ph = phaseRef.current;
    const got: SampleMeta[] = (res.samples ?? []).slice(0, LIMIT).map((s: any) => ({
      id: s.id, patient_id: s.patient_id,
    }));
    const curView: View = ph === "listing-axial" ? "axial" : ph === "listing-coronal" ? "coronal" : "sagittal";
    const nextView: View | null = ph === "listing-axial" ? "coronal" : ph === "listing-coronal" ? "sagittal" : null;

    addLog(curView + ": got " + got.length + " samples");
    viewSamples.current[curView] = got;

    if (nextView) {
      addLog("-> listing " + nextView);
      setPhase(("listing-" + nextView) as Phase);
      listSamples.execute({ view: nextView });
    } else {
      // All views listed — fire the batch load
      const combined: SampleMeta[] = [];
      for (const v of VIEWS) combined.push(...(viewSamples.current[v] ?? []));
      setAllSamples(combined);
      const ids = combined.map((s) => s.id);
      addLog("-> batch loading " + ids.length + " images at frame 77");
      setPhase("loading");
      loadBatch.execute({ sample_ids: ids, frame: 77, show_ncr: false, show_ed: false, show_et: false });
    }
  }, [listSamples.result]); // eslint-disable-line react-hooks/exhaustive-deps

  // React to batch load result
  useEffect(() => {
    const res = loadBatch.result as any;
    if (res == null) return;
    if (!res.ok) { addLog("batch ERROR: " + JSON.stringify(res)); setPhase("error"); return; }

    const newImgs: Record<string, string> = {};
    let ok = 0; let fail = 0;
    for (const r of res.results ?? []) {
      if (!r.ok) { fail++; addLog("  FAIL ..." + r.sample_id?.slice(-8) + ": " + r.error); continue; }
      newImgs[r.sample_id] = r.image;
      ok++;
    }
    setImages(newImgs);
    setPhase("done");
    addLog("Done: " + ok + " loaded, " + fail + " failed");
  }, [loadBatch.result]); // eslint-disable-line react-hooks/exhaustive-deps

  const isLoading =
    phaseDisplay !== "init" &&
    phaseDisplay !== "done" &&
    phaseDisplay !== "error";

  const statusColor =
    phaseDisplay === "done"
      ? "#4ade80"
      : phaseDisplay === "error"
      ? "#f87171"
      : "#f97316";

  return (
    <div style={{ padding: 12, color: "#ddd", background: "#1a1a1a", height: "100%", overflowY: "auto", boxSizing: "border-box", fontFamily: "sans-serif", fontSize: 13 }}>
      {/* Status bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: statusColor, fontWeight: "bold" }}>{phaseDisplay.toUpperCase()}</span>
        {isLoading && <span style={{ fontSize: 11, color: "#666" }}>working...</span>}
        <span style={{ fontSize: 11, color: "#444", marginLeft: "auto" }}>
          {Object.keys(images).length} / {allSamples.length} images
        </span>
      </div>

      {/* One row-section per view */}
      {VIEWS.map((v) => {
        const list = viewSamples.current[v] ?? [];
        return (
          <div key={v} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: "bold", color: "#f97316", marginBottom: 8, textTransform: "capitalize" }}>
              {v} ({list.length})
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
              {list.map((s) => (
                <div key={s.id} style={{ background: "#242424", borderRadius: 6, overflow: "hidden" }}>
                  <div style={{ padding: "3px 8px", fontSize: 10, color: "#666", borderBottom: "1px solid #2e2e2e", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {s.patient_id}
                  </div>
                  {images[s.id]
                    ? <img src={images[s.id]} alt={s.patient_id} style={{ width: "100%", height: "auto", display: "block" }} />
                    : <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center", color: "#333", fontSize: 10 }}>
                        {isLoading ? "..." : "no image"}
                      </div>
                  }
                </div>
              ))}
              {list.length === 0 && (
                <div style={{ color: "#444", fontSize: 11, padding: 8 }}>
                  {isLoading ? "listing..." : "none"}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Debug log */}
      <div style={{ background: "#111", borderRadius: 4, padding: "8px 10px", marginTop: 8 }}>
        <div style={{ fontSize: 10, color: "#555", marginBottom: 4 }}>DEBUG LOG</div>
        <pre style={{ margin: 0, fontFamily: "monospace", fontSize: 10, color: "#666", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
          {log.join("\n") || "-"}
        </pre>
      </div>
    </div>
  );
}
