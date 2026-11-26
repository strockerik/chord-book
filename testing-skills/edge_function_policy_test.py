#!/usr/bin/env python3
"""Edge Function policy + Chord Net + Track A / Layout validation harness (no backend, no spend).

Verifies:
1. supabase/functions/import-sheet/{index,chord_net,layout,ug,pdf}.ts follow all House Index
   security, cost, and architecture policies.
2. Executes the real TypeScript logic from chord_net.ts, layout.ts, ug.ts, and pdf.ts
   in headless Chrome (no Deno required) covering Chord Net, unified chordsOf, UG [ch] tags
   and [tab] non-tab wrappers, Track A UG direct parsing + changed-chorus preservation,
   PDF section/chord-only extraction, realignToLayout, applyPlacementNotes, and restoreChangedChoruses.
"""

import html
import json
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
FUNC_DIR = ROOT / "supabase" / "functions" / "import-sheet"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def strip_ts(code: str) -> str:
    """Lightweight TypeScript-to-JS stripper for running our Edge Function modules in Chrome."""
    js = code
    js = re.sub(r"^\s*import\s+[\s\S]*?from\s+['\"][^'\"]+['\"];?\s*$", "", js, flags=re.M)
    js = re.sub(r"^\s*(?:export\s+)?type\s+\w+\s*=\s*\{[\s\S]*?\};?\s*$", "", js, flags=re.M)
    js = re.sub(r"^\s*(?:export\s+)?type\s+\w+\s*=\s*[^;\n]+;?\s*$", "", js, flags=re.M)
    js = re.sub(r"\bexport\s+(?=(?:const|let|var|async\s+function|function|class)\b)", "", js)
    js = re.sub(r"\s+as\s+(?:any\[\]|number\[\]|string\[\]|string\s*\|\s*null\b|const\b|string\b|number\b|boolean\b)", "", js)
    js = re.sub(r"\b(best|cur|first|m)\!", r"\1", js)
    js = re.sub(r"async function pdfExtract\([\s\S]*?\n\}\n", "", js)
    js = re.sub(r"async function pdfLayoutLines\([\s\S]*?\n\}\n", "", js)
    js = re.sub(r"\bnew\s+(Map|Set)<[^>()]+>\(", r"new \1(", js)

    def strip_param_list(params: str) -> str:
        out_params = []
        depth = 0
        cur = ""
        for ch in params:
            if ch in "([{<":
                depth += 1
            elif ch in ")]}>":
                depth -= 1
            if ch == "," and depth == 0:
                out_params.append(cur)
                cur = ""
            else:
                cur += ch
        if cur.strip():
            out_params.append(cur)
        cleaned = []
        for p in out_params:
            p = p.strip()
            if not p:
                continue
            eq_idx = -1
            d = 0
            for idx, ch in enumerate(p):
                if ch in "([{<":
                    d += 1
                elif ch in ")]}>":
                    d -= 1
                elif ch == "=" and d == 0 and (idx + 1 >= len(p) or p[idx + 1] != ">"):
                    eq_idx = idx
                    break
            if eq_idx != -1:
                lhs = re.sub(r"\??\s*:[\s\S]+$", "", p[:eq_idx].strip()).strip()
                rhs = p[eq_idx:].strip()
                cleaned.append(f"{lhs} {rhs}")
            else:
                lhs = re.sub(r"\??\s*:[\s\S]+$", "", p).strip()
                cleaned.append(lhs)
        return ", ".join(cleaned)

    out = []
    i = 0
    n = len(js)
    fn_re = re.compile(r"(?:async\s+)?function\s+\w+\s*\(")
    while i < n:
        m = fn_re.search(js, i)
        if not m:
            out.append(js[i:])
            break
        out.append(js[i:m.end()])
        depth = 1
        j = m.end()
        while j < n and depth > 0:
            if js[j] == "(":
                depth += 1
            elif js[j] == ")":
                depth -= 1
            j += 1
        params = js[m.end():j - 1]
        out.append(strip_param_list(params) + ")")
        k = j
        while k < n and js[k] in " \t\r\n":
            k += 1
        if k < n and js[k] == ":":
            k += 1
            td = 0
            while k < n:
                ch = js[k]
                if ch in "<([":
                    td += 1
                elif ch in ">)]":
                    td -= 1
                elif ch == "{":
                    prev_non_ws = js[j:k].rstrip()
                    if td > 0 or prev_non_ws.endswith((":", "|", "&", "<")):
                        bd = 1
                        k += 1
                        while k < n and bd > 0:
                            if js[k] == "{":
                                bd += 1
                            elif js[k] == "}":
                                bd -= 1
                            k += 1
                        continue
                    break
                k += 1
            out.append(" ")
            i = k
        else:
            i = j
    js = "".join(out)

    res = []
    idx = 0
    var_re = re.compile(r"\b(const|let|var)\s+(\w+)\s*:")
    while idx < len(js):
        m = var_re.search(js, idx)
        if not m:
            res.append(js[idx:])
            break
        res.append(js[idx:m.start()])
        res.append(f"{m.group(1)} {m.group(2)}")
        k = m.end()
        d = 0
        while k < len(js):
            ch = js[k]
            if ch in "<({[":
                d += 1
            elif ch in ">)}]":
                d -= 1
            elif d == 0 and (ch == ";" or (ch == "=" and (k + 1 >= len(js) or js[k + 1] != ">"))):
                break
            k += 1
        if k < len(js) and js[k] == "=":
            res.append(" ")
        idx = k
    js = "".join(res)

    arrow_re = re.compile(r"\(([^()\n]{1,180})\)(?:\s*:\s*[\w\[\]\s|<>]+)?\s*=>")
    def arrow_repl(m):
        inner = m.group(1)
        if ":" not in inner:
            return f"({inner}) =>"
        return f"({strip_param_list(inner)}) =>"
    js = arrow_re.sub(arrow_repl, js)
    return js


def main():
    index_src = (FUNC_DIR / "index.ts").read_text(encoding="utf-8")
    chord_net_src = (FUNC_DIR / "chord_net.ts").read_text(encoding="utf-8")
    layout_src = (FUNC_DIR / "layout.ts").read_text(encoding="utf-8")
    ug_src = (FUNC_DIR / "ug.ts").read_text(encoding="utf-8")
    pdf_src = (FUNC_DIR / "pdf.ts").read_text(encoding="utf-8")
    all_src = "\n".join([index_src, chord_net_src, layout_src, ug_src, pdf_src])

    results = []

    def check(name, cond, detail=""):
        results.append({"name": name, "pass": bool(cond), "detail": str(detail)})

    # 1. Policy & Architecture checks
    check("Uses SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_PUBLISHABLE_KEYS" in index_src)
    check("No legacy SUPABASE_ANON_KEY or SERVICE_ROLE_KEY",
          "SUPABASE_ANON_KEY" not in all_src and "SUPABASE_SERVICE_ROLE_KEY" not in all_src)
    check("Enforces increment_ai_usage daily cap", 'rpc("increment_ai_usage"' in index_src)
    check("Fails closed with LIMIT_CHECK_FAILED",
          "LIMIT_CHECK_FAILED" in index_src and 'typeof capCount !== "number"' in index_src)
    check("Logs AI calls with token usage via log_ai_call",
          'rpc("log_ai_call"' in index_src and "p_input_tokens" in index_src and "p_cache_read_tokens" in index_src)
    check("Logs the caller's user id like House Index", "p_user_id: userId" in index_src)
    check("Returns genre, tuning, form, and tempo for the sheet",
          all(f in index_src for f in ("genre:", "tuning:", "form:", "tempo:")) and '"chorus_repeat"' in all_src)
    check("A repeated chorus may have no lines", 'sec.type === "chorus_repeat") continue' in chord_net_src)
    check("No real lyrics in the prompt (made-up examples only)",
          "Down the [D]river in the [A]morning" in index_src
          and not any(w in all_src for w in ("slit", "Fount", "Father's love", "dime a dozen", "Amazing grace")))
    check("Modularized into chord_net.ts, layout.ts, ug.ts, pdf.ts, index.ts",
          all((FUNC_DIR / name).exists() for name in ("chord_net.ts", "layout.ts", "ug.ts", "pdf.ts", "index.ts")))
    check("Unified chord check: no separate CHORD_TOKEN regex in pdf.ts",
          "CHORD_TOKEN" not in pdf_src and "isValidChordToken" in pdf_src)
    check("Uses Sonnet 5.5 with strict schemas, additionalProperties: false, and auto tool_choice",
          'MODEL_TEXT = "claude-sonnet-5-5"' in index_src
          and 'MODEL_VISION = "claude-sonnet-5-5"' in index_src
          and "strict: true" in index_src
          and "additionalProperties: false" in index_src
          and 'tool_choice: { type: "auto" }' in index_src
          and 'tool_choice: { type: "tool"' not in index_src)
    check("Supports optional CB_MELODY_MODEL secret for Haiku 5.5 melody trial",
          'Deno.env.get("CB_MELODY_MODEL")' in index_src and '"claude-haiku-5-5"' in index_src)
    check("Prompt-caches PDF document block for multi-song imports",
          'type: "document"' in index_src and 'cache_control: { type: "ephemeral" }' in index_src)
    check("Drops placement notes when exact source layout exists, keeps them for photos",
          "const withPlacement = layout.length === 0;" in index_src
          and "schemaFor(withSource, withPlacement)" in index_src
          and "if (withPlacement) applyPlacementNotes(sheet.sections);" in index_src)
    check("Puts chords back where the source has them before checking",
          "// ==== LAYOUT ====" in layout_src and index_src.count("tidySheet(attempt.toolInput);") == 2
          and "realignToLayout(sheet.sections, exact, isValidChordToken);" in index_src
          and "layoutFromSourceText(sheet.source_text, isValidChordToken)" in index_src
          and "sheet.monospaced === true" in index_src
          and "pdfExtract(bytes)" in index_src and "snapLayoutLine(l)" in index_src)
    check("Daily limit skips only accounts listed in the CB_UNLIMITED_EMAILS secret",
          'Deno.env.get("CB_UNLIMITED_EMAILS")' in index_src
          and "if (!unlimited) {" in index_src
          and "@" not in index_src.split("CB_UNLIMITED_EMAILS")[1][:400])
    check("A linked page with no chords is refused before any paid call",
          "chordLines < 4 && inlineChords < 6" in index_src
          and index_src.index("chordLines < 4") < index_src.index('rpc("increment_ai_usage"', index_src.index("const userContent")))
    check("Matches source lines only when their chords agree (a chorus in a new key stays)",
          "sameNames(" in layout_src and "sameRoots(" in layout_src and "Chorus in D" in index_src)
    melody = index_src[index_src.find('if (reqType === "melody")'):index_src.find("const userContent")]
    check("Melody lookup checks the daily limit, fails closed, logs usage, and sends only titles",
          "increment_ai_usage" in melody and "LIMIT_CHECK_FAILED" in melody and "log_ai_call" not in melody
          and 'logAiCall(supabase, "cb_melody"' in melody
          and "chordpro" not in melody and "MAX_MELODY_SONGS" in melody)
    check("Turns extended thinking off explicitly for Sonnet 5.5 and Haiku 5.5 calls",
          'thinking: { type: "between_tools" }' in index_src and 'thinking: { type: "disabled" }' in index_src
          and index_src.count("...noThinking(") >= 3)
    check("The repair turn sends the AI's reply back unchanged, with its real tool id",
          'role: "assistant", content: attempt.content' in index_src and "tool_use_id: attempt.toolId" in index_src
          and 'id: "repair_1"' not in index_src and "structuredClone(toolBlock.input)" in index_src)
    check("The melody lookup asks for the key the recording sounds in, the same pitch as its notes",
          "concert pitch" in index_src and "sounds in Cm" in index_src)
    check("A melody reply without the tool call is an error, not every song unknown",
          "The AI didn’t send the melody ranges back" in index_src)
    bundle = subprocess.run([sys.executable, str(ROOT / "scripts" / "bundle_import_sheet.py"), "--check"], capture_output=True, text=True)
    check("The one-file paste copy (supabase/paste/import-sheet.ts) matches the modules", bundle.returncode == 0, bundle.stdout.strip())
    check("Retries once when the AI is busy", "[429, 500, 502, 503, 529].includes(res.status)" in index_src and '"BUSY"' in index_src)
    check("Accepts A2 and Asus4-style chord names", "|6\\/9|69|6|5|4|2)?" in chord_net_src)
    check("Uses SSRF safety helpers (parseAllowedUrl, resolvesPublic, readCapped)",
          "parseAllowedUrl(" in index_src and "resolvesPublic(" in index_src and "readCapped(" in index_src)
    check("Supports text, multi-snip image, PDF document, and url modes",
          'reqType === "text"' in index_src and 'reqType === "image"' in index_src
          and 'reqType === "pdf"' in index_src and 'type: "document"' in index_src)

    # 2. Run real Chord Net + Layout + UG + PDF logic inside headless Chrome
    js_bundle = "\n".join([
        strip_ts(chord_net_src),
        strip_ts(layout_src),
        strip_ts(ug_src),
        strip_ts(pdf_src),
    ])

    page_html = f"""<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
window.onerror = (msg, src, line, col) => {{
  document.getElementById("out").textContent = JSON.stringify([{{ name: "JS syntax/runtime", pass: false, detail: msg + " @" + line + ":" + col }}]);
}};
</script><script>
{js_bundle}

const R = [];
function ok(name, cond, detail = "") {{
  R.push({{ name, pass: !!cond, detail: String(detail) }});
}}

// --- Chord Net checks ---
const goodSheet = {{
  title: "Wildflower Road",
  key: "G",
  capo: 2,
  sections: [
    {{
      type: "verse",
      label: "Verse 1",
      lines: [
        {{ text: "[G]Light the [G/B]way for [C]night, [G]Mary.", tab: false }},
        {{ text: "Walk the long dirt [C]road [Dsus4]back [D]home. [G]", tab: false }}
      ]
    }}
  ]
}};
ok("Chord Net accepts valid sheet", validateSheetOutput(goodSheet).length === 0);

const badChordsSheet = {{
  title: "Bad Sheet",
  key: "G",
  sections: [{{ type: "verse", label: "Verse 1", lines: [{{ text: "[G]Hello [Hmaj7]world [Verse 2]", tab: false }}] }}]
}};
const badProblems = validateSheetOutput(badChordsSheet);
ok("Chord Net rejects invalid chord tokens [Hmaj7] and [Verse 2]",
   badProblems.some(p => p.includes("Hmaj7") && p.includes("Verse 2")), JSON.stringify(badProblems));

const emptySecSheet = {{ title: "Empty Sec", key: "C", sections: [{{ type: "chorus", label: "Chorus", lines: [] }}] }};
ok("Chord Net rejects empty section", validateSheetOutput(emptySecSheet).some(p => p.includes("Empty section")));

// --- Step 1: Unified chordsOf accepts 6/9, Δ, -7, mmaj7 ---
const mkGlyphs = (str) => [...str].map((ch, idx) => ({{ ch, x: idx * 7, w: 7 }}));
const pdfAdvanced = chordsOf(mkGlyphs("C6/9   GΔ   Am7   D-7   Emmaj7"), isValidChordToken);
ok("PDF chordsOf unified with isValidChordToken accepts 6/9, Δ, -7, mmaj7",
   !!pdfAdvanced && pdfAdvanced.length === 5 && pdfAdvanced[0].chord === "C6/9" && pdfAdvanced[1].chord === "GΔ" && pdfAdvanced[3].chord === "D-7" && pdfAdvanced[4].chord === "Emmaj7",
   JSON.stringify(pdfAdvanced));

// --- Step 1 & 2: UG [ch] tags exact visual columns & [tab] wrappers NOT turned into guitar tab ---
const ugFakeHtml = '<div class="js-store" data-content="' + JSON.stringify({{
  store: {{
    page: {{
      data: {{
        tab: {{ song_name: "MORNING ROAD", artist_name: "River Band" }},
        tab_view: {{
          meta: {{ capo: 2, tonality: "G", tuning: {{ name: "Standard" }} }},
          wiki_tab: {{
            content: [
              "[Intro]",
              "[tab][ch]G[/ch]   [ch]D[/ch]   [ch]Em[/ch]   [ch]C[/ch][/tab]",
              "",
              "[Verse 1]",
              "[tab]        [ch]D[/ch]             [ch]A[/ch]             [ch]G[/ch]             [ch]D[/ch]",
              "Morning road, morning road, morning road, morning road[/tab]",
              "[tab][ch]D[/ch]                 [ch]A[/ch]              [ch]G[/ch]  [ch]D/F#[/ch] [ch]Em7[/ch] [ch]D[/ch]",
              "Walking down to the river, morning road[/tab]",
              "",
              "[Chorus]",
              "[tab][ch]G[/ch]            [ch]D[/ch]",
              "Carry me home tonight[/tab]",
              "[tab][ch]A[/ch]               [ch]D[/ch]",
              "Over the hill and far[/tab]",
              "",
              "[Chorus]",
              "[tab][ch]G[/ch]            [ch]D[/ch]",
              "Carry me home tonight[/tab]",
              "[tab][ch]A[/ch]                [ch]D[/ch]",
              "Under the stars we are[/tab]",
              "",
              "[Chorus]",
              "[tab][ch]G[/ch]            [ch]D[/ch]",
              "Carry me home tonight[/tab]",
              "[tab][ch]A[/ch]               [ch]D[/ch]",
              "Over the hill and far[/tab]",
              "",
              "[Solo]",
              "e|---3---5---7---|",
              "B|---3---5---8---|"
            ].join("\\n")
          }}
        }}
      }}
    }}
  }}
}}).replace(/"/g, "&quot;") + '"></div>';

const extracted = pageDataForImport(ugFakeHtml);
ok("UG extractor keeps [ch] tags in rawContent and strips [tab] wrappers",
   !!extracted.ug && extracted.ug.rawContent.includes("[ch]D/F#[/ch]") && !extracted.ug.rawContent.includes("[tab]"),
   extracted.ug?.rawContent?.slice(0, 120));

const ugDirect = parseUgDirect(extracted.ug);
ok("Track A UG direct parse achieves high confidence with Title Case title & capo",
   ugDirect.confidence === "high" && ugDirect.sheet.title === "Morning Road" && ugDirect.sheet.capo === 2,
   JSON.stringify({{ conf: ugDirect.confidence, reason: ugDirect.reason, title: ugDirect.sheet?.title }}));

const v1Line0 = ugDirect.sheet.sections.find(s => s.type === "verse")?.lines[0]?.text || "";
ok("UG [ch] tags place each chord on its own repeated word (no stacking)",
   v1Line0 === "Morning [D]road, morning [A]road, morning [G]road, morning [D]road",
   v1Line0);

const nonTabCount = ugDirect.sheet.sections.filter(s => s.type !== "tab").length;
const tabSecs = ugDirect.sheet.sections.filter(s => s.type === "tab");
ok("UG [tab] wrappers stay lyric/chord sections; only real e|-- lines become tab",
   nonTabCount >= 4 && tabSecs.length === 1 && tabSecs[0].lines.every(l => l.tab === true),
   JSON.stringify({{ nonTabCount, tabSecs }}));

const choruses = ugDirect.sheet.sections.filter(s => s.type === "chorus" || s.type === "chorus_repeat");
ok("Track A keeps changed second chorus in full and collapses identical third chorus",
   choruses.length === 3 && choruses[0].type === "chorus" && choruses[1].type === "chorus"
   && choruses[1].lines.map(l => l.text).join(" ").includes("Under the stars")
   && choruses[2].type === "chorus_repeat",
   JSON.stringify(choruses));

// --- Step 5: PDF column extraction preserves section headers & chord-only lines ---
const pdfItems = [
  {{ str: "Intro", x: 40, y: 100, width: 35, size: 11, mono: false }},
  {{ str: "G   D   Em   C", x: 40, y: 118, width: 110, size: 11, mono: true }},
  {{ str: "Verse 1", x: 40, y: 150, width: 45, size: 11, mono: false }},
  {{ str: "G          C           D", x: 40, y: 168, width: 160, size: 11, mono: true }},
  {{ str: "Walking down the long dirt road", x: 40, y: 182, width: 200, size: 11, mono: true }},
  {{ str: "Chorus", x: 40, y: 214, width: 45, size: 11, mono: false }},
  {{ str: "C          G           D", x: 40, y: 232, width: 160, size: 11, mono: true }},
  {{ str: "Carry me home before the night", x: 40, y: 246, width: 200, size: 11, mono: true }},
];
const colExt = extractColumnLines(pdfItems, isValidChordToken);
ok("PDF extractColumnLines preserves section names and chord-only lines",
   colExt.sectionHeaderCount === 3
   && colExt.structuredLines.includes("[Intro]")
   && colExt.structuredLines.includes("[G]   [D]   [Em]   [C]")
   && colExt.structuredLines.includes("[Verse 1]")
   && colExt.structuredLines.includes("[Chorus]")
   && colExt.layoutLines.length === 2,
   JSON.stringify(colExt));

// --- Existing layout / placement / changed-chorus regression checks ---
const stacked = {{ text: "[D]Morning [A]road, [G]morning road, [D]morning road, morning road", tab: false,
  placement: "D over road, A over road, G over road, D over road" }};
applyPlacementNotes([{{ lines: [stacked] }}]);
ok("applyPlacementNotes moves repeated-word anchors to each next appearance",
   stacked.text === "Morning [D]road, morning [A]road, morning [G]road, morning [D]road", stacked.text);

document.getElementById("out").textContent = JSON.stringify(R);
</script>"""

    with tempfile.TemporaryDirectory() as tmp:
        p = pathlib.Path(tmp) / "net.html"
        p.write_text(page_html, encoding="utf-8")
        dom = subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=2000", "--dump-dom", p.as_uri()],
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout

    out_m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not out_m or not out_m.group(1).strip():
        print("FAIL: Chrome did not run Edge Function tests:\n", dom, file=sys.stderr)
        sys.exit(2)

    results.extend(json.loads(html.unescape(out_m.group(1))))
    failed = [r for r in results if not r["pass"]]
    for r in results:
        status = "PASS" if r["pass"] else "FAIL"
        print(f"[{status}] {r['name']}" + (f" — {r['detail']}" if not r["pass"] else ""))
    print(f"\nedge_function_policy_test: {len(results) - len(failed)}/{len(results)} passed.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
