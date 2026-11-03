# af_analysis GUI in the browser (no install)

This folder builds a **serverless** version of `af_analysis_gui`: the unmodified
Flask app and `af_analysis` run in the browser with [Pyodide](https://pyodide.org)
(Python compiled to WebAssembly). Students open a web page, drop their result
`.zip` (or folder), and get the full GUI. Nothing is uploaded anywhere.

How it works:

- `pyodide-worker.js` starts Pyodide in a Web Worker, installs `af_analysis`
  plus a WebAssembly build of `pdb_cpp`, and answers API requests with Flask's
  test client, so the GUI's Python code is reused unchanged.
- `browser-shim.js` is loaded before the GUI's `main.js`. It routes
  `fetch("/api/...")`, the progress `EventSource`, and the CSV export to the
  worker, and adds the drag & drop zone to the *Load dataset* dialog.
- `build.py` renders the GUI template to static HTML and assembles `dist/`.
- `.github/workflows/browser-gui.yml` builds the wheels and the site, tests it in
  headless Chromium (`smoke_test.py`), and publishes it to the `gh-pages` branch.

Not available yet in the browser: clustering / superposition (they need
MDAnalysis, which has no WebAssembly build), so the *Cluster* button is hidden.

Build locally (needs a Pyodide 0.27.7 wheel of `pdb_cpp` in `wheelhouse/`):

```bash
pip wheel --no-deps . -w wheelhouse
python browser/build.py --wheels wheelhouse --out dist
python -m http.server 8000 -d dist
```
