/* Runs the unmodified af_analysis_gui Flask app inside Pyodide (WebAssembly).
 * The page talks to it with postMessage instead of HTTP: see browser-shim.js. */
const PYODIDE_VERSION = "0.27.7"; // must match the Pyodide used to build the pdb_cpp wheel
const INDEX_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
importScripts(INDEX_URL + "pyodide.js");

const status = (msg) => postMessage({ type: "status", msg });
self.postProgress = (json) => postMessage({ type: "progress", data: json });

const BOOTSTRAP = `
import io, json, os, queue, shutil, zipfile
os.environ["MPLBACKEND"] = "Agg"
import js
from af_analysis_gui import flask_app

class _JsProgressQueue:
    """Replaces the server's progress queue: forwards tqdm events to the page."""
    def put_nowait(self, event):
        js.postProgress(json.dumps(event))
    def empty(self):
        return True
    def get_nowait(self):
        raise queue.Empty

flask_app._PROGRESS_QUEUE = _JsProgressQueue()
_client = flask_app.app.test_client()

def handle(method, path, body, ctype):
    kwargs = {}
    if body is not None:
        kwargs = {"data": body, "content_type": ctype or "application/json"}
    r = _client.open(path, method=method, **kwargs)
    return [r.status_code, r.headers.get("Content-Type", ""), r.get_data(as_text=True)]

DATA_ROOT = "/data"

def _safe(name):
    keep = "".join(c if c.isalnum() or c in "-_." else "_" for c in name).strip("._")
    return keep or "dataset"

def _descend(d):
    # A zip/folder often wraps everything in one top-level directory: step into it.
    while True:
        entries = [e for e in os.listdir(d) if not e.startswith(".") and e != "__MACOSX"]
        if len(entries) == 1 and os.path.isdir(os.path.join(d, entries[0])):
            d = os.path.join(d, entries[0])
        else:
            return d

def _fresh(name):
    dest = os.path.join(DATA_ROOT, _safe(name))
    shutil.rmtree(dest, ignore_errors=True)
    os.makedirs(dest)
    return dest

def mount_zip(name, data):
    dest = _fresh(name[:-4] if name.lower().endswith(".zip") else name)
    with zipfile.ZipFile(io.BytesIO(data.to_bytes())) as z:
        z.extractall(dest)
    return _descend(dest)

def mount_files(name, files):
    dest = _fresh(name)
    for rel, data in files.to_py(depth=1):
        rel = os.path.normpath(rel).lstrip("/")
        if rel.startswith(".."):
            continue
        path = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as fh:
            fh.write(data.to_bytes())
    return _descend(dest)
`;

let py;
const ready = (async () => {
  status("Downloading the Python runtime…");
  py = await loadPyodide({ indexURL: INDEX_URL });
  status("Installing scientific Python packages…");
  await py.loadPackage("micropip");
  const micropip = py.pyimport("micropip");
  const base = new URL("wheels/", self.location).href;
  const manifest = await (await fetch(base + "manifest.json")).json();
  await micropip.install([
    "numpy", "pandas", "scipy", "matplotlib", "seaborn", "tqdm",
    "cmcrameri", "ipywidgets", "flask", base + manifest.pdb_cpp,
  ]);
  // af_analysis itself: skip its desktop-only deps (MDAnalysis, nglview).
  await micropip.install.callKwargs(base + manifest.af_analysis, { deps: false });
  status("Starting af_analysis…");
  await py.runPythonAsync(BOOTSTRAP);
  postMessage({ type: "ready" });
})().catch((err) => {
  postMessage({ type: "fatal", msg: String(err) });
  throw err;
});

self.onmessage = async (e) => {
  const { id, kind, args } = e.data;
  try {
    await ready;
    let result;
    if (kind === "request") {
      const out = py.globals.get("handle")(args.method, args.path, args.body ?? null, args.ctype ?? null);
      const [status, ctype, body] = out.toJs();
      out.destroy();
      result = { status, ctype, body };
    } else if (kind === "mount_zip") {
      result = py.globals.get("mount_zip")(args.name, args.data);
    } else if (kind === "mount_files") {
      result = py.globals.get("mount_files")(args.name, args.files);
    }
    postMessage({ type: "reply", id, ok: true, result });
  } catch (err) {
    postMessage({ type: "reply", id, ok: false, error: String(err) });
  }
};
