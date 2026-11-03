/* Serverless mode for af_analysis_gui.
 * Loaded before the GUI's own main.js. Calls to the Flask API ("/api/...") are
 * answered by the same Flask app running in Pyodide in a Web Worker, so the
 * GUI code is reused unchanged. Also adds drag & drop loading of a .zip or folder. */
(() => {
  "use strict";
  const worker = new Worker("pyodide-worker.js");
  const pending = new Map();
  const sources = new Set();
  let seq = 0;
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  // ── Loading overlay ────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
    #afa-overlay{position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;
      background:rgba(255,255,255,.92);font-family:Inter,system-ui,sans-serif;color:#2d3a57;text-align:center;padding:16px}
    #afa-overlay .spinner-border{margin-bottom:12px}
    #afa-overlay small{color:#6c757d}
    .afa-drop{border:2px dashed #9aa7c7;border-radius:10px;padding:22px 12px;text-align:center;color:#2d3a57;
      background:#f6f8fc;margin-bottom:1rem;cursor:pointer;transition:background .15s,border-color .15s}
    .afa-drop.hover,body.afa-dragging .afa-drop{background:#e6ecfa;border-color:#3d5bd9}
    .afa-drop i{font-size:1.8rem;display:block;margin-bottom:4px}
    .afa-drop small{color:#6c757d}
    #browse-btn,#toolbar-cluster-btn{display:none!important}
  `;
  document.head.appendChild(style);

  const overlay = document.createElement("div");
  overlay.id = "afa-overlay";
  overlay.innerHTML = `<div><div class="spinner-border" role="status"></div>
    <div id="afa-overlay-msg">Starting Python in your browser…</div>
    <small>First visit: about 30 s (downloads ~40 MB). Then cached.<br>
    Your data never leaves your computer.</small></div>`;
  let isReady = false;
  const showOverlay = () => !isReady && document.body && !overlay.isConnected && document.body.appendChild(overlay);
  if (document.body) showOverlay(); else document.addEventListener("DOMContentLoaded", showOverlay);
  const setOverlay = (msg) => {
    const el = document.getElementById("afa-overlay-msg") || overlay.querySelector("#afa-overlay-msg");
    if (el) el.textContent = msg;
  };

  // ── Worker protocol ────────────────────────────────────────────────────────
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "status") setOverlay(m.msg);
    else if (m.type === "ready") { isReady = true; overlay.remove(); resolveReady(); }
    else if (m.type === "fatal") setOverlay("Failed to start Python: " + m.msg);
    else if (m.type === "progress") for (const es of [...sources]) es._emit(m.data);
    else if (m.type === "reply") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (p) m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
    }
  };
  const call = (kind, args, transfer = []) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, kind, args }, transfer);
  });

  const isApi = (url) => typeof url === "string" && url.startsWith("/api/");

  // ── fetch("/api/...") → Flask in Pyodide ──────────────────────────────────
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    if (!isApi(input)) return origFetch(input, init);
    await ready;
    const headers = new Headers(init.headers || {});
    const r = await call("request", {
      method: (init.method || "GET").toUpperCase(),
      path: input,
      body: init.body ?? null,
      ctype: headers.get("Content-Type"),
    });
    // A request may finish without its "__end__" progress event (e.g. on error):
    // close any progress listener still waiting so the GUI does not hang.
    setTimeout(() => { for (const es of [...sources]) es._emit('{"desc":"__end__","done":true}'); }, 0);
    return new Response(r.body, { status: r.status, headers: { "Content-Type": r.ctype || "application/json" } });
  };

  // ── EventSource("/api/progress/stream") → progress messages from the worker
  const OrigEventSource = window.EventSource;
  window.EventSource = function (url, opts) {
    if (!isApi(url)) return new OrigEventSource(url, opts);
    const es = {
      onmessage: null, onerror: null,
      close() { sources.delete(es); },
      _emit(data) { es.onmessage && es.onmessage({ data }); },
      addEventListener(type, fn) { if (type === "message") es.onmessage = fn; },
    };
    sources.add(es);
    return es;
  };

  // ── <a href="/api/export_csv">.click() → download from the worker ─────────
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const href = this.getAttribute("href");
    if (!isApi(href)) return origClick.call(this);
    window.fetch(href).then((r) => r.blob()).then((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = this.download || "download";
      origClick.call(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    });
  };

  // ── Drag & drop / pick a .zip or a folder ─────────────────────────────────
  const readEntry = (entry, prefix, out) => new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((f) => { out.push([prefix + f.name, f]); resolve(); }, resolve);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const next = () => reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const child of all) await readEntry(child, prefix + entry.name + "/", out);
          resolve();
        } else { all.push(...batch); next(); }
      }, resolve);
      next();
    } else resolve();
  });

  async function mountAndLoad(items) {
    const setStatus = (msg, err) => {
      const el = document.getElementById("status");
      if (el) { el.textContent = msg; el.style.color = err ? "#a11927" : "#2d3a57"; }
      const dz = document.getElementById("afa-drop-msg");
      if (dz) dz.textContent = msg;
    };
    try {
      await ready;
      let dir;
      if (items.length === 1 && items[0].kind === "file" && /\.zip$/i.test(items[0].file.name)) {
        const f = items[0].file;
        setStatus(`Unpacking ${f.name}…`);
        const data = new Uint8Array(await f.arrayBuffer());
        dir = await call("mount_zip", { name: f.name, data }, [data.buffer]);
      } else {
        const files = [];
        for (const it of items) {
          if (it.entry) await readEntry(it.entry, "", files);
          else files.push([it.file.webkitRelativePath || it.file.name, it.file]);
        }
        if (!files.length) throw new Error("No files found");
        const name = files[0][0].includes("/") ? files[0][0].split("/")[0] : "dropped_files";
        setStatus(`Reading ${files.length} files…`);
        const payload = [];
        for (const [rel, f] of files) payload.push([rel, new Uint8Array(await f.arrayBuffer())]);
        dir = await call("mount_files", { name, files: payload }, payload.map((p) => p[1].buffer));
      }
      const input = document.getElementById("directory");
      if (input) input.value = dir;
      setStatus(`Ready: ${dir}`);
      document.getElementById("load-btn")?.click();
    } catch (err) {
      setStatus("Could not read the dropped data: " + err.message, true);
    }
  }

  const itemsFromDrop = (dt) => {
    const items = [];
    for (const it of dt.items || []) {
      if (it.kind !== "file") continue;
      const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
      if (entry && entry.isDirectory) items.push({ entry });
      else items.push({ kind: "file", file: it.getAsFile() });
    }
    return items;
  };

  document.addEventListener("DOMContentLoaded", () => {
    const body = document.querySelector("#load-dialog .modal-body");
    if (body) {
      const zone = document.createElement("div");
      zone.className = "afa-drop";
      zone.innerHTML = `<i class="bi bi-file-earmark-zip"></i>
        <div id="afa-drop-msg"><b>Drop a result .zip or folder here</b></div>
        <small>AlphaFold 2/3, ColabFold, Boltz, Chai… — or click to choose a .zip.<br>
        Everything runs in your browser: nothing is uploaded.</small>
        <input type="file" accept=".zip" hidden>`;
      const picker = zone.querySelector("input");
      zone.addEventListener("click", () => picker.click());
      picker.addEventListener("change", () => {
        if (picker.files.length) mountAndLoad([{ kind: "file", file: picker.files[0] }]);
        picker.value = "";
      });
      body.prepend(zone);
      const label = body.querySelector('label[for="directory"]');
      if (label) label.textContent = "Loaded data (in-browser path)";
    }
    // Drop anywhere on the page.
    let depth = 0;
    window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; document.body.classList.add("afa-dragging"); });
    window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; document.body.classList.remove("afa-dragging"); } });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove("afa-dragging");
      const items = itemsFromDrop(e.dataTransfer);
      if (items.length) mountAndLoad(items);
    });
  });
})();
