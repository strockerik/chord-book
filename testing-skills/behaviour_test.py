#!/usr/bin/env python3
"""Behaviour, Undo, Set Lists, Performance Mode, and CSP verification harness for The Chord Book."""

import functools
import http.server
import json
import pathlib
import socketserver
import subprocess
import sys
import threading

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from fixtures import fixture_boot_script

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, results_holder=None, **kwargs):
        self.results_holder = results_holder
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        pass

    def do_POST(self):
        if self.path == "/__results":
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8")
            self.results_holder["data"] = json.loads(raw)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            return
        self.send_response(404)
        self.end_headers()


DRIVER_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Chord Book Behaviour & CSP Harness</title>
</head>
<body>
<iframe id="app-frame" style="width:1200px;height:850px;border:none;"></iframe>
<script>
__FIXTURE_BOOT__
(async () => {
  const R = [];
  const ok = (name, cond, detail = "") => {
    R.push({ name, pass: !!cond, detail: String(detail) });
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = document.getElementById("app-frame");

  const cspViolations = [];
  let win, doc;
  for (let i = 0; i < 60; i++) {
    win = frame.contentWindow;
    doc = frame.contentDocument;
    if (doc) {
      doc.addEventListener("securitypolicyviolation", (e) => {
        cspViolations.push(`${e.violatedDirective}: ${e.blockedURI}`);
      });
    }
    if (doc && doc.querySelector(".sheet-page")) break;
    await sleep(60);
  }

  try {
    // 0a. Only House Index members: no way past the sign-in screen on the live site
    ok("Sign-in screen has no way in without an account",
       !doc.getElementById("auth-continue-local-btn") && !doc.querySelector("#auth-gate .ghost-btn"));

    // 0. The empty message bar must not peek onto the screen or block taps
    const idleToast = win.getComputedStyle(doc.getElementById("toast-bar"));
    ok("Idle message bar is fully hidden", idleToast.visibility === "hidden" && idleToast.pointerEvents === "none",
       `visibility=${idleToast.visibility} pointerEvents=${idleToast.pointerEvents}`);

    // 1. Verify per-song saved settings + Undo
    const capoSel = doc.getElementById("capo-select");
    const origCapo = capoSel.value;
    capoSel.value = "4";
    capoSel.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(40);
    await sleep(480);
    const activeId = doc.querySelector(".song-list-card.is-selected")?.dataset.songId;
    const storedSong = () => JSON.parse(win.localStorage.getItem("cb:local:songs")).find((x) => x.id === activeId);
    ok("Changing capo saves itself", String(storedSong()?.capo) === "4", `capo=${storedSong()?.capo}`);
    capoSel.value = origCapo;
    capoSel.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(480);
    ok("Changing capo back saves itself", String(storedSong()?.capo) === origCapo);

    // 2. Verify "Rewrite in Key" (bake transpose into stored ChordPro) + Undo
    doc.getElementById("transpose-up-btn").click();
    doc.getElementById("transpose-up-btn").click();
    await sleep(50);
    const bakeBtn = doc.getElementById("bake-transpose-key-btn");
    ok("Rewrite in Key button appears when transposed", !bakeBtn.hidden);
    bakeBtn.click();
    await sleep(60);
    const undoBake = doc.getElementById("toast-action-trigger");
    ok("Rewrite in Key resets delta to Original and offers Undo",
       doc.getElementById("transpose-delta-badge").textContent === "Original" && !!undoBake);
    if (undoBake) {
      undoBake.click();
      await sleep(60);
    }

    // 3. Verify Delete Song + Undo restores song to library
    const initialCount = doc.querySelectorAll(".song-list-card").length;
    doc.getElementById("delete-song-btn").click();
    await sleep(60);
    const afterDeleteCount = doc.querySelectorAll(".song-list-card").length;
    ok("Delete removes song from library", afterDeleteCount === initialCount - 1, `${initialCount} -> ${afterDeleteCount}`);
    const undoDelete = doc.getElementById("toast-action-trigger");
    if (undoDelete) {
      undoDelete.click();
      await sleep(60);
    }
    const restoredCount = doc.querySelectorAll(".song-list-card").length;
    ok("Undo restores deleted song back into library", restoredCount === initialCount);

    // 4. Verify Performance Mode (Stage overlay, auto-scroll, pedal PageDown key, exit)
    doc.getElementById("perform-song-btn").click();
    await sleep(60);
    const perfOverlay = doc.getElementById("perform-overlay");
    ok("Performance Mode opens full-screen stage overlay", !perfOverlay.hidden);
    const perfBody = doc.getElementById("perform-body");
    doc.getElementById("perform-autoscroll-btn").click();
    await sleep(140);
    ok("Auto-scroll button toggles active state", doc.getElementById("perform-autoscroll-btn").classList.contains("is-active"));
    // Tap body to pause auto-scroll
    perfBody.click();
    await sleep(40);
    ok("Tapping performance body pauses auto-scroll", !doc.getElementById("perform-autoscroll-btn").classList.contains("is-active"));
    // Close performance mode
    doc.getElementById("perform-close-btn").click();
    await sleep(40);
    ok("Performance Mode closes cleanly", perfOverlay.hidden);

    // 5. Verify Set Lists modal & performing a set + Export PDF / Export HTML buttons
    doc.getElementById("nav-setlists-btn").click();
    await sleep(80);
    const setlistRows = doc.querySelectorAll(".setlist-item-row");
    const exportPdfBtn = doc.getElementById("print-setlist-pdf-btn");
    const exportHtmlBtn = doc.getElementById("export-setlist-html-btn");
    ok("Set Lists modal loads default set list items (4 songs) and Export PDF / Export HTML buttons",
       setlistRows.length >= 4 && !!exportPdfBtn && !!exportHtmlBtn);
    doc.querySelector('[data-close-sheet="setlists-modal"]').click();
    await sleep(40);

    // 5b. Verify Device Mode Override in Account ("You") modal switches to Phone & back to Auto (v0.3.0)
    const acctBtn = doc.getElementById("nav-account-btn")
      || Array.from(doc.querySelectorAll("header button, nav button")).find((b) => /\byou\b|account/i.test(b.textContent || ""));
    if (acctBtn) acctBtn.click();
    await sleep(50);
    const overrideSel = doc.getElementById("device-override-select");
    let phoneSwitched = false;
    let autoRestored = false;
    if (overrideSel) {
      overrideSel.value = "phone";
      overrideSel.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(50);
      phoneSwitched = doc.body.dataset.device === "phone";
      overrideSel.value = "auto";
      overrideSel.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(50);
      autoRestored = doc.body.dataset.device === "desktop";
    }
    ok("Device override selector in Account modal switches body[data-device] to phone and back to desktop",
       !!overrideSel && phoneSwitched && autoRestored,
       `hasSelect=${!!overrideSel}, phoneSwitched=${phoneSwitched}, autoRestored=${autoRestored}`);
    doc.querySelector('#account-modal [data-close-sheet="account-modal"]')?.click();
    await sleep(40);

    // 5c. Verify Layer 2 On-Sheet Align Chords Mode & Layer 1 Editor Quality Check
    const alignBtn = doc.getElementById("toggle-align-mode-btn");
    alignBtn?.click();
    await sleep(60);
    const nudgeBtns = doc.querySelectorAll("#song-stage-container .chord-nudge-btn");
    const alignBannerVisible = !doc.getElementById("song-align-mode-banner")?.hidden;
    doc.getElementById("align-mode-done-btn")?.click();
    await sleep(40);
    const alignClosed = doc.getElementById("song-align-mode-banner")?.hidden &&
      doc.querySelectorAll("#song-stage-container .chord-nudge-btn").length === 0;
    ok("Align Chords mode toggles ◀/▶ chord nudge buttons on sheet and closes cleanly",
       alignBannerVisible && nudgeBtns.length >= 4 && alignClosed,
       `banner=${alignBannerVisible}, nudges=${nudgeBtns.length}, closed=${alignClosed}`);

    doc.getElementById("edit-song-btn")?.click();
    await sleep(60);
    const qcBox = doc.getElementById("editor-alignment-qc-box");
    const editorArea = doc.getElementById("edit-song-chordpro");
    const qcVisibleOnOpen = !!qcBox && !qcBox.hidden;
    const origEditorPro = editorArea ? editorArea.value : "";
    let qcAutoFixed = false;
    if (editorArea) {
      editorArea.value = origEditorPro + "\n[D]The lantern wa[G]lked";
      editorArea.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(50);
      const fixBtn = doc.getElementById("editor-apply-qc-fixes-btn");
      if (fixBtn) {
        fixBtn.click();
        await sleep(50);
        qcAutoFixed = editorArea.value.includes("The [D]lantern") && editorArea.value.includes("[G]walked");
      }
      editorArea.value = origEditorPro;
      editorArea.dispatchEvent(new Event("input", { bubbles: true }));
    }
    doc.querySelector('#song-editor-modal [data-close-sheet="song-editor-modal"]')?.click();
    await sleep(40);
    ok("Editor Quality Check box detects alignment issues and 1-tap Auto-Fix repairs them",
       qcVisibleOnOpen && qcAutoFixed,
       `qcVisible=${qcVisibleOnOpen}, autoFixed=${qcAutoFixed}`);

    // 5d. Editor protects unsaved work and keeps fields it has no input for
    const tempoBefore = storedSong()?.tempo;
    doc.getElementById("edit-song-btn").click();
    await sleep(50);
    doc.getElementById("edit-song-notes").value = "unsaved audit edit";
    win.confirm = () => false;
    doc.getElementById("song-editor-modal").click();
    await sleep(30);
    ok("Tapping outside a changed editor asks first and can keep editing", !doc.getElementById("song-editor-modal").hidden);
    win.confirm = () => true;
    doc.getElementById("song-editor-modal").click();
    await sleep(30);
    ok("Confirming discard closes the editor", doc.getElementById("song-editor-modal").hidden);
    doc.getElementById("edit-song-btn").click();
    await sleep(50);
    doc.getElementById("edit-song-genre").value = "rock";
    doc.getElementById("song-editor-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await sleep(80);
    ok("Saving the editor keeps tempo", storedSong()?.tempo === tempoBefore && tempoBefore != null, `tempo=${storedSong()?.tempo}`);
    ok("Editor saves the song's genre", storedSong()?.layout_prefs?.genre === "rock", storedSong()?.layout_prefs?.genre);

    // 5e. A pedal press at the end of a song moves to the next song in the set
    doc.getElementById("nav-setlists-btn").click();
    await sleep(80);
    doc.getElementById("perform-setlist-btn").click();
    await sleep(80);
    const stageBody = doc.getElementById("perform-body");
    const firstTitle = doc.getElementById("perform-title").textContent;
    stageBody.scrollTop = stageBody.scrollHeight;
    await sleep(40);
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }));
    await sleep(60);
    ok("Pedal at end of song advances the set", doc.getElementById("perform-title").textContent !== firstTitle);
    const stageChord = stageBody.querySelector(".chord-cell[data-chord]");
    ok("Chords don't block page-turn taps on stage", win.getComputedStyle(stageChord).pointerEvents === "none");
    const stageRect = stageBody.getBoundingClientRect();
    const tapCenter = () => stageBody.dispatchEvent(new win.MouseEvent("click", {
      bubbles: true, clientX: stageRect.left + stageRect.width / 2, clientY: stageRect.top + stageRect.height / 2
    }));
    const scrollBtn = doc.getElementById("perform-autoscroll-btn");
    tapCenter();
    await sleep(40);
    const startedByTap = scrollBtn.classList.contains("is-active");
    tapCenter();
    await sleep(40);
    ok("Center tap starts and pauses scrolling", startedByTap && !scrollBtn.classList.contains("is-active"));
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await sleep(40);
    ok("Leaving Stage returns to the open set list",
       doc.getElementById("perform-overlay").hidden && !doc.getElementById("setlists-modal").hidden);
    doc.querySelector('[data-close-sheet="setlists-modal"]').click();
    await sleep(40);

    // 5f. Tuning saves and changes the key the song sounds in
    const tuningSel = doc.getElementById("song-tuning-select");
    tuningSel.value = "half";
    tuningSel.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(480);
    ok("Half step down saves and lowers the sounding key",
       storedSong()?.tuning === "Eb Ab Db Gb Bb Eb" && doc.getElementById("sounding-key-readout").textContent.includes("Eb"),
       `${storedSong()?.tuning} / ${doc.getElementById("sounding-key-readout").textContent}`);
    tuningSel.value = "standard";
    tuningSel.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(480);

    // 5g. Scroll length follows tempo and includes instrumental sections
    const timing = await import("/js/timing.js");
    const chordproModule = await import("/js/chordpro.js");
    const timedSheet = chordproModule.parse(`{start_of_intro: Intro}\n[G] [C] [G] [D]\n{end_of_intro}\n{start_of_verse: Verse 1}\n[G]Walking down the [C]road tonight\n{end_of_verse}\n{start_of_chorus: Chorus}\n[G]Sing it [D]out again\n{end_of_chorus}`);
    const slow = timing.estimateSongTiming({ tempo: 40, time_signature: "4/4", notes: "Form: Intro • V1 • CH • V1 • CH" }, timedSheet).seconds;
    const fast = timing.estimateSongTiming({ tempo: 80, time_signature: "4/4", notes: "Form: Intro • V1 • CH • V1 • CH" }, timedSheet).seconds;
    const noIntro = timing.estimateSongTiming({ tempo: 40, time_signature: "4/4", notes: "Form: V1 • CH • V1 • CH" }, timedSheet).seconds;
    ok("Scroll length follows BPM, form, and intros", slow > fast * 1.2 && slow > noIntro, `slow=${slow} fast=${fast} noIntro=${noIntro}`);

    // 6. Verify Service Worker registration & zero CSP violations
    let swReg = null;
    for (let i = 0; i < 25 && !swReg; i++) {
      swReg = await win.navigator.serviceWorker.getRegistration();
      if (!swReg) await sleep(60);
    }
    ok("Service Worker registers cleanly under strict CSP", !!swReg);
    ok("Zero Content-Security-Policy violations", cspViolations.length === 0, cspViolations.join(" | "));

  } catch (err) {
    ok("Behaviour harness completed without exceptions", false, err && err.stack || String(err));
  }

  await fetch("/__results", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(R)
  });
})();
</script>
</body>
</html>
"""


def main():
    driver_file = ROOT / "__behaviour_driver.html"
    driver_file.write_text(DRIVER_HTML.replace("__FIXTURE_BOOT__", fixture_boot_script()), encoding="utf-8")
    results_holder = {"data": None}

    handler = functools.partial(QuietHandler, results_holder=results_holder)
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    try:
        subprocess.run(
            [
                CHROME,
                "--headless=new",
                "--host-resolver-rules=MAP *.supabase.co 127.0.0.1:9",
                "--disable-gpu",
                "--no-sandbox",
                "--virtual-time-budget=8000",
                f"http://127.0.0.1:{port}/__behaviour_driver.html",
            ],
            capture_output=True,
            text=True,
            timeout=45,
        )
    finally:
        httpd.shutdown()
        if driver_file.exists():
            driver_file.unlink()

    results = results_holder["data"]
    if not results:
        print("FAIL: Headless Chrome did not post behaviour results.", file=sys.stderr)
        sys.exit(2)

    failed = [r for r in results if not r["pass"]]
    for r in results:
        status = "PASS" if r["pass"] else "FAIL"
        print(f"[{status}] {r['name']}" + (f" — {r['detail']}" if not r["pass"] else ""))
    print(f"\nbehaviour_and_csp_test: {len(results) - len(failed)}/{len(results)} passed.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
