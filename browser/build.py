"""Build the serverless (in-browser) version of af_analysis_gui.

The GUI's own template and static files are reused unchanged; this script only
renders the template to plain HTML, adds the Pyodide shim, and copies wheels.

Usage:
    python browser/build.py --wheels <dir with pdb_cpp (wasm) and af_analysis wheels> --out dist
"""

import argparse
import json
import shutil
from pathlib import Path

from jinja2 import Environment, FileSystemLoader

HERE = Path(__file__).resolve().parent
GUI_DIR = HERE.parent / "src" / "af_analysis_gui"
MAIN_JS = '<script type="module" src="static/js/main.js"></script>'


def build(wheels: Path, out: Path) -> None:
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)

    env = Environment(loader=FileSystemLoader(str(GUI_DIR / "templates")))
    html = env.get_template("flask_index.html").render(
        url_for=lambda endpoint, filename: f"static/{filename}"
    )
    if MAIN_JS not in html:
        raise SystemExit("Could not find the main.js <script> tag in the template")
    html = html.replace(
        MAIN_JS, '<script src="browser-shim.js"></script>\n  ' + MAIN_JS
    )
    (out / "index.html").write_text(html, encoding="utf-8")

    shutil.copytree(GUI_DIR / "static", out / "static")
    for name in ("browser-shim.js", "pyodide-worker.js"):
        shutil.copy(HERE / name, out / name)

    wheel_out = out / "wheels"
    wheel_out.mkdir()
    manifest = {}
    for whl in sorted(wheels.glob("*.whl")):
        shutil.copy(whl, wheel_out / whl.name)
        if whl.name.startswith("pdb_cpp-") and "wasm32" in whl.name:
            manifest["pdb_cpp"] = whl.name
        elif whl.name.startswith("af_analysis-"):
            manifest["af_analysis"] = whl.name
    missing = {"pdb_cpp", "af_analysis"} - manifest.keys()
    if missing:
        raise SystemExit(f"Missing wheel(s) in {wheels}: {', '.join(sorted(missing))}")
    (wheel_out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    (out / ".nojekyll").touch()
    print(f"Built {out} with {manifest}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--wheels", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path("dist"))
    args = parser.parse_args()
    build(args.wheels, args.out)
