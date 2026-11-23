#!/usr/bin/env python3
"""Generate custom Chord Book PWA icons (apple-touch-icon.png, icon-192.png, icon-512.png)
in the exact visual family of The House Index ('Hi' -> 'Cb' in Fraunces Bold on #FCFBF8 paper
with Chord Book's Stage Amber #9A3412 and Deep Indigo #1E3A8A accent pills).
"""

import base64
import functools
import http.server
import json
import pathlib
import socketserver
import subprocess
import sys
import threading

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS_DIR = ROOT / "icons"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


class IconHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, holder=None, **kwargs):
        self.holder = holder
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        pass

    def do_POST(self):
        if self.path == "/__icons":
            length = int(self.headers.get("Content-Length", "0"))
            self.holder["data"] = json.loads(self.rfile.read(length).decode("utf-8"))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            return
        self.send_response(404)
        self.end_headers()


DRIVER = r"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="style.css">
</head>
<body>
<script>
(async () => {
  await document.fonts.ready;
  // Load Fraunces bold explicitly
  await document.fonts.load("700 200px Fraunces");

  function renderIcon(size) {
    const cv = document.createElement("canvas");
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext("2d");

    // 1. Warm paper background matching House Index (#FCFBF8)
    ctx.fillStyle = "#FCFBF8";
    ctx.fillRect(0, 0, size, size);

    // 2. "Cb" monogram in Fraunces 700 bold (#2A2520 ink)
    ctx.fillStyle = "#2A2520";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const fontSize = Math.round(size * 0.49);
    ctx.font = `700 ${fontSize}px "Fraunces", Georgia, serif`;
    ctx.fillText("Cb", size * 0.5, size * 0.595);

    // 3. Signature two pill bars underneath (Stage Amber #9A3412 + Deep Indigo/Gold #D97706)
    const pillH = Math.round(size * 0.056);
    const pillW = Math.round(size * 0.255);
    const gap = Math.round(size * 0.024);
    const pillY = Math.round(size * 0.715);
    const r = pillH / 2;

    function roundRect(x, y, w, h, rad, color) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, rad);
      ctx.fill();
    }

    const leftX = Math.round(size * 0.5 - gap / 2 - pillW);
    const rightX = Math.round(size * 0.5 + gap / 2);
    roundRect(leftX, pillY, pillW, pillH, r, "#9A3412");
    roundRect(rightX, pillY, pillW, pillH, r, "#D97706");

    return cv.toDataURL("image/png").split(",")[1];
  }

  const out = {
    "apple-touch-icon.png": renderIcon(180),
    "icon-192.png": renderIcon(192),
    "icon-512.png": renderIcon(512)
  };

  await fetch("/__icons", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(out)
  });
})();
</script>
</body>
</html>
"""


def main():
    driver_file = ROOT / "__icon_driver.html"
    driver_file.write_text(DRIVER, encoding="utf-8")
    holder = {"data": None}

    handler = functools.partial(IconHandler, holder=holder)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    try:
        subprocess.run(
            [
                CHROME,
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                "--virtual-time-budget=3000",
                f"http://127.0.0.1:{port}/__icon_driver.html",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
    finally:
        httpd.shutdown()
        if driver_file.exists():
            driver_file.unlink()

    if not holder["data"]:
        print("FAIL: Could not generate icons", file=sys.stderr)
        sys.exit(1)

    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    for name, b64 in holder["data"].items():
        path = ICONS_DIR / name
        path.write_bytes(base64.b64decode(b64))
        print(f"Generated {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
