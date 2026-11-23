#!/usr/bin/env python3
"""Live GitHub Pages verification harness for https://strockerik.github.io/chord-book/"""

import html
import json
import re
import subprocess
import sys
import time
import urllib.request

LIVE_URL = "https://strockerik.github.io/chord-book/"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def wait_for_pages_live(max_wait_sec=90):
    t0 = time.time()
    while time.time() - t0 < max_wait_sec:
        try:
            req = urllib.request.Request(LIVE_URL, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    body = resp.read().decode("utf-8", errors="ignore")
                    if "The Chord Book" in body:
                        return True, resp.status
        except Exception as e:
            last_err = str(e)
        time.sleep(3)
    return False, last_err


def main():
    print(f"Checking {LIVE_URL} ...")
    live, status = wait_for_pages_live()
    if not live:
        print(f"FAIL: GitHub Pages is not live yet ({status})")
        sys.exit(1)
    print(f"HTTP 200 OK — {LIVE_URL} is live! Running headless Chrome verification against live URL...")

    proc = subprocess.run(
        [
            CHROME,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--virtual-time-budget=6000",
            "--dump-dom",
            LIVE_URL,
        ],
        capture_output=True,
        text=True,
        timeout=45,
    )
    dom = proc.stdout

    checks = [
        ("Live page renders The Chord Book", "The Chord Book" in dom),
        ("Live page offers sign-in", 'id="auth-signin-form"' in dom),
        ("Live page offers use without signing in", "Use without signing in" in dom),
        ("Live page ships no song sheet before sign-in", 'class="sheet-page' not in dom and 'class="cl-pair"' not in dom),
    ]

    failed = 0
    for name, passed in checks:
        tag = "PASS" if passed else "FAIL"
        if not passed:
            failed += 1
        print(f"[{tag}] {name}")

    print(f"\nlive_github_pages_test: {len(checks) - failed}/{len(checks)} passed on {LIVE_URL}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
