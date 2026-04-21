"""
__init__.py — NIfTI 3D Viewer Plugin (Python Panel + Flask + Niivue)
Flask server serves NIfTI files and Niivue HTML.
FiftyOne panel shows sample info and URL to open in browser.
"""

import os
import threading
import urllib.parse
import logging

import fiftyone as fo
import fiftyone.operators.panel as fop
import fiftyone.operators.types as types

FLASK_PORT    = 5159
_flask_thread = None


def _resolve_path(sample, field: str) -> str:
    """Resolve potentially relative path to absolute."""
    path = getattr(sample, field, None)
    if not path:
        return ""
    if os.path.isabs(path):
        return path
    base = os.path.dirname(os.path.dirname(sample.filepath))
    return os.path.normpath(os.path.join(base, path))


def _build_niivue_html(ct_url, seg_url, seg_colour, patient_id):
    seg_js = ""
    if seg_url:
        r, g, b, a = seg_colour
        seg_js = f"""
    try {{
        await nv.addVolumeFromUrl({{
            url: "{seg_url}",
            colormap: "warm",
            opacity: {a},
            colorbarVisible: false,
        }});
    }} catch(e) {{ console.warn("Seg load failed:", e); }}
        """

    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>NIfTI 3D — {patient_id}</title>
<style>
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{
    background:#0a0a0a; color:#e2e4ea;
    font-family:monospace; font-size:12px;
    display:flex; flex-direction:column; height:100vh; overflow:hidden;
  }}
  #toolbar {{
    display:flex; align-items:center; gap:6px; flex-wrap:wrap;
    padding:8px 12px; background:rgba(255,255,255,0.04);
    border-bottom:1px solid #1e2028; flex-shrink:0;
  }}
  .btn {{
    padding:3px 10px; border-radius:4px;
    border:1px solid #2a2d36; background:transparent;
    color:#7a7f8e; cursor:pointer; font-size:11px; font-family:monospace;
    transition:all 0.15s;
  }}
  .btn:hover {{ border-color:#5ac8fa; color:#5ac8fa; }}
  .btn.active {{ border-color:#5ac8fa; background:rgba(90,200,250,0.1); color:#5ac8fa; }}
  #gl {{ flex:1; width:100%; display:block; }}
  #status {{ font-size:10px; color:#5a5f6e; margin-left:auto; }}
</style>
</head>
<body>
<div id="toolbar">
  <span style="font-weight:700;color:#5ac8fa;text-transform:uppercase;letter-spacing:0.1em;font-size:11px">
    {patient_id}
  </span>
  <button class="btn active" onclick="setLayout(3,this)">4-Up</button>
  <button class="btn" onclick="setLayout(0,this)">Axial</button>
  <button class="btn" onclick="setLayout(1,this)">Coronal</button>
  <button class="btn" onclick="setLayout(2,this)">Sagittal</button>
  <button class="btn" onclick="setLayout(4,this)">3D Only</button>
  <button class="btn" onclick="toggleSeg()">Toggle Seg</button>
  <span id="status">Loading…</span>
</div>
<canvas id="gl"></canvas>

<script>
var _nv = null;
var _segVisible = true;

function setLayout(t, btn) {{
  if (!_nv) return;
  _nv.setSliceType(t);
  document.querySelectorAll(".btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
}}

function toggleSeg() {{
  if (!_nv || _nv.volumes.length < 2) return;
  _segVisible = !_segVisible;
  _nv.setOpacity(1, _segVisible ? 0.5 : 0);
  _nv.drawScene();
}}

window.addEventListener("resize", () => {{ if (_nv) _nv.resizeListener(); }});
</script>

<script type="module">
import {{ Niivue }} from "https://unpkg.com/@niivue/niivue@0.67.0/dist/index.js";

const nv = new Niivue({{
  isResizeCanvas: true,
  show3Dcrosshair: true,
  backColor: [0.04, 0.04, 0.06, 1],
  crosshairColor: [0.35, 0.78, 0.98, 1],
  sliceType: 3,
}});

_nv = nv;

await nv.attachTo("gl");
document.getElementById("status").textContent = "Fetching CT…";

try {{
  await nv.loadVolumes([{{ url: "{ct_url}", colormap: "gray", opacity: 1.0 }}]);
  document.getElementById("status").textContent = "CT loaded ✅";
}} catch(e) {{
  document.getElementById("status").textContent = "CT load failed: " + e;
}}

{seg_js}

document.getElementById("status").textContent = "✅ " + nv.volumes.length + " volume(s) loaded";
</script>
</body>
</html>"""


def _start_flask(dataset_name):
    from flask import Flask, request, send_file, Response

    app = Flask(__name__)
    logging.getLogger("werkzeug").setLevel(logging.ERROR)

    SEG_COLOURS = {
        "lung_mask":               [0.2,  0.8,  0.35, 0.5],
        "infection_mask":          [1.0,  0.23, 0.19, 0.7],
        "lung_and_infection_mask": [0.04, 0.52, 1.0,  0.5],
        "none":                    [0, 0, 0, 0],
    }

    @app.route("/viewer")
    def viewer():
        sample_id = request.args.get("sample_id", "")
        seg_field = request.args.get("seg_field", "lung_and_infection_mask")
        try:
            dataset    = fo.load_dataset(dataset_name)
            sample     = dataset[sample_id]
            ct_path    = sample.filepath
            base_dir   = os.path.dirname(os.path.dirname(ct_path))
            seg_rel    = getattr(sample, f"{seg_field}_path", None) if seg_field != "none" else None
            if seg_rel and not os.path.isabs(seg_rel):
                seg_path = os.path.normpath(os.path.join(base_dir, seg_rel))
            else:
                seg_path = seg_rel
            patient_id = getattr(sample, "patient_id", sample_id[:8])
        except Exception as e:
            return f"<pre>Error: {e}</pre>", 400

        ct_url  = f"http://localhost:{FLASK_PORT}/nifti?path={urllib.parse.quote(ct_path)}"
        seg_url = (
            f"http://localhost:{FLASK_PORT}/nifti?path={urllib.parse.quote(seg_path)}"
            if seg_path else ""
        )
        colour = SEG_COLOURS.get(seg_field, [1, 0, 0, 0.5])
        html   = _build_niivue_html(ct_url, seg_url, colour, patient_id)
        return Response(html, mimetype="text/html")

    @app.route("/nifti")
    def serve_nifti():
        path = request.args.get("path", "")
        if not path or not os.path.exists(path):
            return f"File not found: {path}", 404
        resp = send_file(path, mimetype="application/octet-stream",
                         as_attachment=False,
                         download_name=os.path.basename(path))
        resp.headers["Access-Control-Allow-Origin"] = "*"
        return resp

    @app.route("/health")
    def health():
        return "ok"

    app.run(host="0.0.0.0", port=FLASK_PORT, debug=False, use_reloader=False)


def _ensure_flask(dataset_name):
    global _flask_thread
    if _flask_thread and _flask_thread.is_alive():
        return
    _flask_thread = threading.Thread(
        target=_start_flask, args=(dataset_name,), daemon=True
    )
    _flask_thread.start()


# ── Panel ─────────────────────────────────────────────────────────────────────
SEG_LABELS = {
    "lung_mask":               "🟢 Lung",
    "infection_mask":          "🔴 Infection",
    "lung_and_infection_mask": "🔵 Lung + Inf",
    "none":                    "⬜ None",
}


class NiftiViewerPanel(fop.Panel):

    @property
    def config(self):
        return fop.PanelConfig(
            name="nifti_3d_viewer",
            label="NIfTI 3D Viewer",
            surfaces="grid",
            allow_multiple=True,
        )

    def on_load(self, ctx):
        ctx.panel.set_state("seg_field", "lung_and_infection_mask")
        _ensure_flask(ctx.dataset.name if ctx.dataset else "covid_ct_3d")

    def on_change_current_sample(self, ctx):
        ctx.panel.set_state("sample_id", ctx.current_sample)

    def set_seg_lung(self, ctx):
        ctx.panel.set_state("seg_field", "lung_mask")

    def set_seg_infection(self, ctx):
        ctx.panel.set_state("seg_field", "infection_mask")

    def set_seg_lung_inf(self, ctx):
        ctx.panel.set_state("seg_field", "lung_and_infection_mask")

    def set_seg_none(self, ctx):
        ctx.panel.set_state("seg_field", "none")

    def render(self, ctx):
        panel     = types.Object()
        state     = ctx.panel.state or {}
        seg_field = state.get("seg_field", "lung_and_infection_mask")

        _ensure_flask(ctx.dataset.name if ctx.dataset else "covid_ct_3d")

        # get sample_id
        sample_id = ctx.current_sample
        if not sample_id:
            sample_id = state.get("sample_id")
        if not sample_id and ctx.selected:
            sample_id = ctx.selected[0]
        ctx.panel.set_state("sample_id", sample_id or "")

        # ── info ──────────────────────────────────────────────────────────
        panel.str("info", view=types.MarkdownView(read_only=True))
        if not sample_id:
            ctx.panel.set_state("info", "👆 **Click a sample** to load in 3D viewer")
        else:
            try:
                s   = ctx.dataset[sample_id]
                pid = getattr(s, "patient_id", sample_id[:8])
                ctx.panel.set_state("info",
                    f"**Patient:** {pid} | "
                    f"**Slices:** {getattr(s,'n_slices','?')} | "
                    f"**Shape:** {getattr(s,'shape',[])} | "
                    f"**Seg:** {SEG_LABELS.get(seg_field, seg_field)}"
                )
            except Exception:
                ctx.panel.set_state("info", f"Sample: `{sample_id[:20]}`")

        # ── viewer URL ─────────────────────────────────────────────────────
        if sample_id:
            viewer_url = (
                f"http://localhost:{FLASK_PORT}/viewer"
                f"?sample_id={sample_id}&seg_field={seg_field}"
            )
            panel.str("url", view=types.MarkdownView(read_only=True))
            ctx.panel.set_state("url",
                f"**Open in browser:**\n\n"
                f"[{viewer_url}]({viewer_url})\n\n"
                f"*(Cmd+click the link above)*"
            )

        # ── seg selector ───────────────────────────────────────────────────
        panel.str("seg_hdr", view=types.MarkdownView(read_only=True))
        ctx.panel.set_state("seg_hdr", "**Segmentation overlay:**")

        seg_obj = types.Object()
        seg_obj.btn("sl",  label="🟢 Lung",      on_click=self.method_to_uri("set_seg_lung"))
        seg_obj.btn("si",  label="🔴 Infection",  on_click=self.method_to_uri("set_seg_infection"))
        seg_obj.btn("sli", label="🔵 Lung+Inf",   on_click=self.method_to_uri("set_seg_lung_inf"))
        seg_obj.btn("sn",  label="⬜ None",        on_click=self.method_to_uri("set_seg_none"))
        panel.define_property("seg_btns", seg_obj, view=types.HStackView())

        # ── instructions ───────────────────────────────────────────────────
        panel.str("instructions", view=types.MarkdownView(read_only=True))
        ctx.panel.set_state("instructions",
            "**How to use:**\n"
            "1. Click a sample in the grid\n"
            "2. Select a segmentation overlay\n"
            "3. Cmd+click the URL to open 3D viewer\n\n"
            "**In the viewer:**\n"
            "- **4-Up** — all 4 views\n"
            "- **Axial / Coronal / Sagittal** — single plane\n"
            "- **3D Only** — rotate with click+drag\n"
            "- **Toggle Seg** — show/hide overlay\n"
            "- **Scroll** — zoom\n\n"
            f"*Server: [http://localhost:{FLASK_PORT}/health]"
            f"(http://localhost:{FLASK_PORT}/health)*"
        )

        return types.Property(panel)


def register(p):
    p.register(NiftiViewerPanel)
