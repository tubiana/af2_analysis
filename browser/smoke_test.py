"""End-to-end check of the built in-browser GUI with headless Chromium.

Usage: python browser/smoke_test.py <url> <results.zip> <screenshot.png>
"""

import sys

from playwright.sync_api import sync_playwright

url, zip_path, screenshot = sys.argv[1:4]
logs = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    page.on("console", lambda m: logs.append(f"[console.{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    try:
        page.goto(url)
        page.wait_for_selector("#afa-overlay", state="detached", timeout=300_000)
        print("Python runtime ready")
        page.set_input_files("#load-dialog input[type=file]", zip_path)
        page.wait_for_function(
            "document.getElementById('status')?.textContent.startsWith('Dataset loaded')",
            timeout=180_000,
        )
        print("Status:", page.text_content("#status"))
        rows = page.evaluate(
            "fetch('/api/table').then(r => r.json()).then(d => d.total)"
        )
        pae = page.evaluate("fetch('/api/pae?index=0').then(r => r.status)")
        comp = page.evaluate(
            """fetch('/api/compute', {method: 'POST', headers: {'Content-Type': 'application/json'},
                 body: JSON.stringify({score: 'iptm_d0'})}).then(r => r.json())"""
        )
        print(f"rows={rows} pae_status={pae} compute={comp}")
        page.wait_for_timeout(8000)  # let Mol* and Plotly render for the screenshot
        assert rows > 0 and pae == 200 and comp.get("ok"), "API checks failed"
        print("BROWSER GUI OK")
    finally:
        page.screenshot(path=screenshot)
        overlay = page.query_selector("#afa-overlay")
        if overlay:
            print("Overlay still shown:", overlay.text_content())
        print("\n".join(logs[-60:]))
        browser.close()
