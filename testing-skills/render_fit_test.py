#!/usr/bin/env python3
"""Headless Chrome DOM & Layout verification for The Chord Book:
1. 1-Sheet (8.5x11") and 2-Sheet (8.5x11") Auto-Fit Engine (`scrollHeight <= clientHeight`, `scrollWidth <= clientWidth`)
2. Chords stay over their syllables (`.cl-pair` inline-flex columns)
3. Sidebar Margin Notes rail renders and inline edits persist
4. Transposition (+2 semitones G -> A, Capo 2 -> Sounding Key) updates chords and diagrams
5. Ugly Single-Line Paste imports through the UI modal and formats onto 1 sheet
6. Vocal Key Analytics ("My Keys") computes best singing tonal center and song fit scores
7. Viewport smoke check at 360px, 390px, 430px, and 1280px (no horizontal page overflow, touch targets >= 40px)
"""

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
<title>Chord Book Layout & Behaviour Harness</title>
</head>
<body>
<iframe id="app-frame" style="width:1280px;height:900px;border:none;"></iframe>
<script>
__FIXTURE_BOOT__
(async () => {
  const R = [];
  const ok = (name, cond, detail = "") => {
    R.push({ name, pass: !!cond, detail: String(detail) });
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = document.getElementById("app-frame");

  // Wait for app inside iframe to finish booting
  let win, doc;
  // Boot time varies with machine load; the loop stops as soon as the first sheet appears.
  for (let i = 0; i < 250; i++) {
    win = frame.contentWindow;
    doc = frame.contentDocument;
    if (doc && doc.querySelector(".sheet-page .cl-pair")) break;
    await sleep(60);
  }

  try {
    // 1. Verify initial seed song renders in 1-Sheet (8.5x11") mode and fits 100%
    const sheet1 = doc.querySelector(".sheet-page");
    ok("1-Sheet mode renders an 8.5x11 (.sheet-page) container", !!sheet1);
    if (sheet1) {
      ok("1-Sheet fits vertically without clipping (scrollHeight <= clientHeight + 1)",
         sheet1.scrollHeight <= sheet1.clientHeight + 1,
         `scrollH=${sheet1.scrollHeight} clientH=${sheet1.clientHeight}`);
      const flow = sheet1.querySelector(".sheet-sections-flow");
      ok("1-Sheet fits horizontally without overflow",
         flow.scrollWidth <= flow.clientWidth + 4,
         `scrollW=${flow.scrollWidth} clientW=${flow.clientWidth}`);
    }

    // 1b. Verify every fixture song fits 100% on 1-Sheet (8.5x11")
    for (const songId of ["test-morning-river", "test-harvest-table", "test-lantern-waltz", "test-wildflower-road"]) {
      const cardBtn = doc.querySelector(`[data-select-song="${songId}"]`);
      ok(`Library includes song ${songId}`, !!cardBtn);
      if (cardBtn) {
        cardBtn.click();
        await sleep(60);
        const pg = doc.querySelector(".sheet-page");
        const fl = pg?.querySelector(".sheet-sections-flow");
        const fitsV = pg && pg.scrollHeight <= pg.clientHeight + 1 && (!fl || fl.scrollHeight <= fl.clientHeight + 1);
        const fitsH = fl && fl.scrollWidth <= fl.clientWidth + 4;
        ok(`Song ${songId} fits 100% on 1-Sheet (8.5x11)`, fitsV && fitsH,
           `scrollH=${pg?.scrollHeight}/${pg?.clientHeight} flowW=${fl?.scrollWidth}/${fl?.clientWidth}`);

        if (songId === "test-harvest-table") {
          const choruses = pg ? Array.from(pg.querySelectorAll(".song-section.is-chorus")) : [];
          const written = choruses.filter((el) => el.querySelectorAll(".lyric-line").length > 0);
          ok("Chorus-first song writes the chorus out again after each of the 3 verses",
             choruses.length === 4 && written.length === 4 && pg.querySelectorAll(".verse-chorus-reminder").length === 0,
             `choruses=${choruses.length} written=${written.length}`);


          const secGapPx = parseInt(pg?.style.getPropertyValue("--sheet-section-gap") || "0", 10);
          const rowGapPx = parseInt(pg?.style.getPropertyValue("--sheet-row-gap") || "0", 10);
          ok("Sheet uses the standard comfortable line and section spacing",
             secGapPx >= 16 && rowGapPx >= 4,
             `secGap=${secGapPx}px rowGap=${rowGapPx}px`);

          const verseHeader = pg?.querySelector(".song-section.type-verse .section-label");
          const chorusHeader = pg?.querySelector(".song-section.is-chorus .section-label");
          const sampleChord = pg?.querySelector("button.chord-cell");
          const sampleLyric = pg?.querySelector(".lyric-cell");
          if (verseHeader && chorusHeader && sampleChord && sampleLyric) {
            const vhStyle = win.getComputedStyle(verseHeader);
            const chStyle = win.getComputedStyle(chorusHeader);
            const cStyle = win.getComputedStyle(sampleChord);
            const lStyle = win.getComputedStyle(sampleLyric);
            const vhPx = parseFloat(vhStyle.fontSize);
            const chPx = parseFloat(chStyle.fontSize);
            const cPx = parseFloat(cStyle.fontSize);
            const lPx = parseFloat(lStyle.fontSize);
            ok("Organizational headers (Chorus, Verse) are bigger, heavier, and distinct in color from chords and lyrics",
               vhPx > lPx && chPx > lPx && vhPx > cPx &&
               parseInt(vhStyle.fontWeight, 10) >= 800 &&
               vhStyle.color !== cStyle.color && chStyle.color !== cStyle.color,
               `verse=${vhPx.toFixed(1)}px/${vhStyle.fontWeight}/${vhStyle.color} chorus=${chPx.toFixed(1)}px/${chStyle.color} lyric=${lPx.toFixed(1)}px chord=${cPx.toFixed(1)}px/${cStyle.color}`);
          }

          const allLinesSingleRow = Array.from(pg?.querySelectorAll(".lyric-line") || []).every((ln) => {
            const firstP = ln.firstElementChild;
            const lastP = ln.lastElementChild;
            if (!firstP || !lastP) return true;
            return Math.abs(firstP.getBoundingClientRect().top - lastP.getBoundingClientRect().top) <= 2 &&
                   lastP.getBoundingClientRect().right <= ln.getBoundingClientRect().right + 2;
          });
          ok("Song keeps every lyric+chord line (including trailing D/F#) on one line",
             allLinesSingleRow);

          const hideToggle = doc.getElementById("compact-chorus-toggle");
          hideToggle.checked = true;
          hideToggle.dispatchEvent(new Event("change", { bubbles: true }));
          await sleep(80);
          const hiddenPg = doc.querySelector(".sheet-page");
          const reminders = hiddenPg ? hiddenPg.querySelectorAll(".verse-chorus-reminder") : [];
          ok("Hide repeated choruses shows a bold CHORUS reminder after each of the 3 verses instead",
             reminders.length === 3 && Array.from(reminders).every((el) => el.textContent.trim() === "CHORUS") &&
             hiddenPg.querySelectorAll(".song-section.is-chorus").length === 1,
             `count=${reminders.length}`);
          hideToggle.checked = false;
          hideToggle.dispatchEvent(new Event("change", { bubbles: true }));
          await sleep(80);
        }

        if (songId === "test-lantern-waltz") {
          ok("Sheets say Chorus, never Refrain, in labels and notes",
             !/refrain/i.test(pg?.textContent || "") &&
             pg?.querySelector(".song-section.is-chorus .section-label")?.textContent === "Chorus",
             pg?.querySelector(".song-section.is-chorus .section-label")?.textContent);
          const brokenWord = Array.from(pg?.querySelectorAll(".lyric-cell.has-word-break") || [])
            .find((cell) => cell.textContent === "a-");
          const dash = brokenWord?.querySelector(".syllable-dash")?.textContent || "";
          const wordEnd = Array.from(pg?.querySelectorAll(".lyric-cell") || []).find((cell) => cell.textContent.startsWith("way"));
          ok("A chord that splits a word marks the syllable with a dash",
             !!brokenWord && dash === "-" && !!wordEnd && !wordEnd.classList.contains("has-word-break"),
             `found=${!!brokenWord} dash=${dash}`);
        }

        if (songId === "test-wildflower-road") {
          const allPairs = Array.from(pg?.querySelectorAll(".cl-pair") || []);
          const dcHeavenPair = allPairs.find((p) =>
            p.querySelector(".chord-cell")?.textContent?.trim() === "D/C" &&
            (p.querySelector(".lyric-cell")?.textContent || "").startsWith("harbor")
          );
          const cEndPair = allPairs.find((p) =>
            p.querySelector(".chord-cell")?.textContent?.trim() === "C" &&
            (p.querySelector(".lyric-cell")?.textContent || "").startsWith("se")
          );
          ok("Walkdown keeps D/C and C on their exact syllables",
             !!dcHeavenPair && !!cEndPair,
             `dcHeaven=${!!dcHeavenPair} cEnd=${!!cEndPair}`);
        }
      }
    }

    // 1c. Short songs stay at the standard size instead of growing to fill the page
    const standardSizes = [];
    for (const songId of ["test-morning-river", "test-harvest-table", "test-lantern-waltz", "test-wildflower-road"]) {
      doc.querySelector(`[data-select-song="${songId}"]`).click();
      await sleep(50);
      standardSizes.push(parseFloat(doc.querySelector(".sheet-page").style.getPropertyValue("--sheet-font-size")));
    }
    ok("Every sheet that fits uses the same 11pt text", standardSizes.every((pt) => pt === 11), standardSizes.join(", "));

    // 2. Verify chords stay over their syllables (.cl-pair has .chord-cell directly above .lyric-cell)
    const pairs = Array.from(doc.querySelectorAll(".sheet-page .cl-pair")).filter(
      (p) => p.querySelector("button.chord-cell") && p.querySelector(".lyric-cell")
    );
    ok("Chords-over-lyrics pairs rendered", pairs.length >= 15, `count=${pairs.length}`);
    if (pairs.length > 0) {
      const samplePair = pairs[0];
      const cr = samplePair.querySelector(".chord-cell").getBoundingClientRect();
      const lr = samplePair.querySelector(".lyric-cell").getBoundingClientRect();
      ok("Chord cell sits directly above its syllable (cr.bottom <= lr.top + 4 and left-aligned)",
         cr.bottom <= lr.top + 4 && Math.abs(cr.left - lr.left) < 4,
         `chord=${Math.round(cr.left)},${Math.round(cr.bottom)} lyric=${Math.round(lr.left)},${Math.round(lr.top)}`);
    }

    // 3. Verify Sidebar Margin Notes rail renders on sections
    const marginCards = doc.querySelectorAll(".sheet-page .margin-note-card");
    ok("Sidebar margin notes render alongside sections", marginCards.length >= 3, `count=${marginCards.length}`);

    // 4. Test switching to 2-Sheet (8.5x11") mode
    const btn2Sheet = doc.querySelector('[data-page-mode="2-sheet"]');
    btn2Sheet.click();
    await sleep(60);
    const pages2 = doc.querySelectorAll(".sheet-page");
    ok("2-Sheet mode splits song across 2 8.5x11 pages", pages2.length === 2, `pages=${pages2.length}`);
    const bothFit = Array.from(pages2).every((p) => p.scrollHeight <= p.clientHeight + 1);
    ok("Both pages in 2-Sheet mode fit within 8.5x11 height", bothFit);

    // Switch back to 1-Sheet
    doc.querySelector('[data-page-mode="1-sheet"]').click();
    await sleep(60);

    // 5. Test Transposition (+1 twice: G -> A)
    const upBtn = doc.getElementById("transpose-up-btn");
    upBtn.click();
    upBtn.click();
    await sleep(60);
    const deltaText = doc.getElementById("transpose-delta-badge")?.textContent || "";
    const firstChordText = doc.querySelector(".sheet-page button.chord-cell")?.textContent;
    ok("Transposing +2 semitones shifts Intro C -> D and updates delta badge (+2)",
       deltaText.startsWith("+2") && firstChordText === "D",
       `delta=${deltaText} firstChord=${firstChordText}`);

    // 6. Test adding/editing a Sidebar Margin Note via the inline modal
    const editNoteBtn = doc.querySelector("[data-edit-note='sec-1']");
    editNoteBtn.click();
    await sleep(50);
    const noteTextarea = doc.getElementById("sidebar-note-text");
    noteTextarea.value = "Start whisper-quiet, swell on line 4";
    doc.getElementById("sidebar-note-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await sleep(80);
    const updatedNotesText = doc.querySelector(".sheet-page")?.textContent || "";
    ok("Edited sidebar note persists and renders on the sheet",
       updatedNotesText.includes("Start whisper-quiet, swell on line 4"));

    // 6b. Test Uncluttered Sidebar Search Clear, Grouping & Filter Drawer (v0.3.0)
    const groupHeaders = doc.querySelectorAll("#song-library-list .library-group-header");
    const filterToggleBtn = doc.getElementById("toggle-filter-drawer-btn");
    const filterDrawer = doc.getElementById("library-filter-drawer");
    filterToggleBtn.click();
    await sleep(40);
    const drawerOpened = !!filterDrawer && !filterDrawer.hidden && getComputedStyle(filterDrawer).display !== "none";
    doc.querySelector('[data-pick-genre="country"]').click();
    await sleep(30);
    const countryCount = doc.querySelectorAll("#song-library-list .song-list-card").length;
    doc.querySelector("[data-clear-genre]").click();
    await sleep(30);
    ok("Genre filter narrows the list, and songs without a genre count as Worship",
       countryCount === 1 && doc.querySelectorAll("#song-library-list .song-list-card").length === 4 &&
       /Worship \(3\)/.test(doc.getElementById("library-filter-drawer").textContent),
       `country=${countryCount}`);
    doc.getElementById("toggle-filter-drawer-btn").click();
    await sleep(30);
    const searchInput = doc.getElementById("library-search");
    const searchClear = doc.getElementById("library-search-clear");
    searchInput.value = "Praise";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(40);
    const clearVisibleAfterType = !!searchClear && !searchClear.hidden && getComputedStyle(searchClear).display !== "none";
    searchClear.click();
    await sleep(40);
    const clearedSearchOk = searchInput.value === "";
    ok("Sidebar shows group dividers, filter drawer toggles, and search clear works",
       groupHeaders.length >= 1 && drawerOpened && clearVisibleAfterType && clearedSearchOk,
       `groups=${groupHeaders.length}, drawer=${drawerOpened}, clearVis=${clearVisibleAfterType}, cleared=${clearedSearchOk}`);

    // 7. Test Ugly Single-Line Paste Import via the Import Modal
    doc.getElementById("open-import-btn").click();
    await sleep(50);
    doc.getElementById("import-paste-text").value = UGLY_PASTE;
    await sleep(30);
    doc.getElementById("import-parse-free-btn").click();
    await sleep(60);
    // Editor modal opens with the parsed song
    const editorTitle = doc.getElementById("edit-song-title")?.value;
    const editorPro = doc.getElementById("edit-song-chordpro")?.value || "";
    ok("Ugly single-line paste populates editor with clean ChordPro",
       editorTitle === "Wildflower Road" && editorPro.includes("{start_of_chorus"),
       `title=${editorTitle}`);
    // Save the imported song
    doc.getElementById("song-editor-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await sleep(80);

    // 7b. Test 1-Tap Ideal Vocal Range Tip when importing a song outside ideal vocal keys (e.g. Key of C)
    doc.getElementById("open-import-btn").click();
    await sleep(50);
    const importTextarea = doc.querySelector("#import-sheet-modal textarea");
    importTextarea.value = "C Major Vocal Tip Song\nKey: C\n\n[C]Amazing [F]grace how [G]sweet the [C]sound";
    importTextarea.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(30);
    doc.getElementById("import-parse-free-btn").click();
    await sleep(60);
    const vocalTipEl = doc.getElementById("editor-vocal-range-tip");
    const applyIdealBtn = doc.getElementById("editor-apply-ideal-transpose");
    const keyBeforeIdeal = doc.getElementById("edit-song-key")?.value;
    const tipVisible = !!vocalTipEl && !vocalTipEl.hidden && getComputedStyle(vocalTipEl).display !== "none" && !!applyIdealBtn;
    if (applyIdealBtn) {
      applyIdealBtn.click();
      await sleep(40);
    }
    const keyAfterIdeal = doc.getElementById("edit-song-key")?.value;
    const proAfterIdeal = doc.getElementById("edit-song-chordpro")?.value || "";
    ok("Ideal Vocal Range Tip appears on C-major import and 1-tap transpose shifts key & chords",
       tipVisible && keyBeforeIdeal === "C" && keyAfterIdeal !== "C" && !proAfterIdeal.includes("[F]grace"),
       `tipVisible=${tipVisible}, before=${keyBeforeIdeal}, after=${keyAfterIdeal}`);
    win.confirm = () => true;
    doc.querySelector('#song-editor-modal [data-close-sheet="song-editor-modal"]')?.click();
    await sleep(40);

    // 7c. A long song continues on another page instead of being squeezed
    doc.getElementById("open-import-btn").click();
    await sleep(50);
    const longVerses = Array.from({ length: 12 }, (_, v) =>
      `{start_of_verse: Verse ${v + 1}}\n` +
      Array.from({ length: 6 }, (_, l) => `[G]Walking down road ${v + 1} the long [C]country mile ${l + 1} again [D]tonight with you`).join("\n") +
      "\n{end_of_verse}").join("\n\n");
    doc.getElementById("import-paste-text").value = `{title: Long Test Song}\n{key: G}\n\n${longVerses}`;
    doc.getElementById("import-parse-free-btn").click();
    await sleep(60);
    doc.getElementById("song-editor-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await sleep(160);
    const longPages = Array.from(doc.querySelectorAll(".sheet-page"));
    ok("A long song takes extra pages and keeps readable text",
       longPages.length >= 2 &&
       longPages.every((p) => p.scrollHeight <= p.clientHeight + 1) &&
       longPages.every((p) => parseFloat(p.style.getPropertyValue("--sheet-font-size")) >= 10.5),
       `pages=${longPages.length} font=${longPages[0]?.style.getPropertyValue("--sheet-font-size")}`);

    // 8. Test Vocal Key & Song Fit Analytics modal
    doc.getElementById("nav-analytics-btn").click();
    await sleep(60);
    const analyticsText = doc.getElementById("analytics-sheet-body")?.textContent || "";
    ok("Vocal Key Analytics computes #1 Money Singing Key and fit scores",
       (analyticsText.includes("G / Em") || analyticsText.includes("E / C#m") || analyticsText.includes("A / F#m")) && analyticsText.includes("% Fit"),
       analyticsText.slice(0, 140));
    doc.querySelector('[data-close-sheet="analytics-modal"]').click();
    await sleep(50);

    // 8b. On two-pane screens the song list and chord sheet scroll independently
    frame.style.height = "420px";
    win.dispatchEvent(new Event("resize"));
    await sleep(80);
    const listPane = doc.getElementById("song-library-list");
    const sheetPane = doc.getElementById("song-stage-container");
    const pageScroller = doc.scrollingElement;
    ok("Song list and chord sheet are separate scroll panes",
       listPane.scrollHeight > listPane.clientHeight && sheetPane.scrollHeight > sheetPane.clientHeight && pageScroller.scrollHeight <= pageScroller.clientHeight + 1,
       `list=${listPane.scrollHeight}/${listPane.clientHeight} sheet=${sheetPane.scrollHeight}/${sheetPane.clientHeight} page=${pageScroller.scrollHeight}/${pageScroller.clientHeight}`);
    listPane.scrollTop = 40;
    sheetPane.scrollTop = 0;
    await sleep(30);
    const listMovedAlone = listPane.scrollTop > 0 && sheetPane.scrollTop === 0;
    listPane.scrollTop = 0;
    sheetPane.scrollTop = 120;
    await sleep(30);
    ok("Scrolling one pane leaves the other in place", listMovedAlone && listPane.scrollTop === 0 && sheetPane.scrollTop > 0);
    listPane.scrollTop = 40;
    const keptListTop = listPane.scrollTop;
    const nextSongBtn = Array.from(doc.querySelectorAll("[data-select-song]")).find((b) => !b.closest(".is-selected"));
    nextSongBtn.click();
    await sleep(80);
    ok("Choosing a song keeps the list position and opens the sheet at the top",
       doc.getElementById("song-library-list").scrollTop === keptListTop && sheetPane.scrollTop === 0,
       `list=${doc.getElementById("song-library-list").scrollTop}/${keptListTop} sheet=${sheetPane.scrollTop}`);
    frame.style.height = "900px";
    win.dispatchEvent(new Event("resize"));
    await sleep(60);

    // 9. Viewport Responsive Smoke Tests at 360px, 390px, and 430px (SPEC 8 & 10)
    for (const vw of [360, 390, 430]) {
      frame.style.width = vw + "px";
      win.dispatchEvent(new Event("resize"));
      await sleep(80);
      ok(`Phone auto-detection at ${vw}px enables readable Scroll mode`,
         doc.body.dataset.device === "phone" && !!doc.querySelector("#song-stage-container .scroll-sheet"),
         `device=${doc.body.dataset.device}, scrollSheet=${!!doc.querySelector("#song-stage-container .scroll-sheet")}`);
      const scrollW = doc.documentElement.scrollWidth;
      const clientW = doc.documentElement.clientWidth;
      ok(`Viewport ${vw}px: no horizontal page overflow (scrollW=${scrollW} <= ${clientW + 1})`,
         scrollW <= clientW + 1,
         `scrollW=${scrollW} clientW=${clientW}`);

      // Verify all visible header navigation buttons have touch targets >= 40px
      const navBtns = Array.from(doc.querySelectorAll(".header-icon-btn"));
      const all40 = navBtns.every((b) => {
        const r = b.getBoundingClientRect();
        return r.width >= 39.5 && r.height >= 39.5 && r.right <= vw + 1;
      });
      ok(`Viewport ${vw}px: all header icon buttons >= 40px touch target and inside viewport`, all40);
    }

  } catch (err) {
    ok("Harness ran without uncaught error", false, err && err.stack || String(err));
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
    driver_file = ROOT / "__test_driver.html"
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
                "--virtual-time-budget=20000",
                f"http://127.0.0.1:{port}/__test_driver.html",
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
        print("FAIL: Headless Chrome did not post results.", file=sys.stderr)
        sys.exit(2)

    failed = [r for r in results if not r["pass"]]
    for r in results:
        status = "PASS" if r["pass"] else "FAIL"
        print(f"[{status}] {r['name']}" + (f" — {r['detail']}" if not r["pass"] else ""))
    print(f"\nrender_fit_and_viewport_test: {len(results) - len(failed)}/{len(results)} passed.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
