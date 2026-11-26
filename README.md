# The Chord Book — Operating Manual & Setup Guide

*Built on the foundation of The House Index (`Strock-Recipes` v1.9.2). Shares the existing House Index Supabase project (`cb_` tables) and deploys from its own GitHub repository via GitHub Pages.*

---

## 1. Architecture Overview

| Layer | Implementation |
|---|---|
| **Frontend** | Plain HTML, CSS, and native ES modules (`js/*.js`). Zero build step, no Node/npm bundler. |
| **Typography** | Self-hosted `Fraunces` (titles), `Public Sans` (lyrics & UI), and `IBM Plex Mono` bold (chords & tabs) under SIL OFL in `fonts/`. |
| **Backend** | Shared House Index Supabase project (`config.js`), using `cb_songs`, `cb_setlists`, `cb_setlist_items`, `cb_song_shares`, and `cb_song_revisions` so it never collides with recipe or bottle tables. |
| **8.5×11" Sheet Engine** | `js/fit.js` starts every song at a standard **11pt** and never enlarges text to fill space. If a song doesn't fit, it tries two columns, slightly snugger spacing, printing repeated choruses once, wrapped lines, and at most 10.5pt text. If it still doesn't fit, it continues on another page rather than being squeezed. Screen and print share these rules. |
| **Multi-Modal Import** | `js/chordpro.js` + `js/ai.js` + `supabase/functions/import-sheet/index.ts` handles: (1) pasted text of any kind (AI when signed in, free on-device formatting otherwise, including phone copies of chord sites), (2) 1–6 overlapping screenshot snips (paste with `Cmd+V` or drag/drop), (3) phone camera photos, and (4) uploaded PDFs. After any change to `index.ts`, paste it into the Supabase dashboard again to redeploy. |
| **Sidebar Margin Notes** | Dedicated right-hand margin rail on every section for dynamic cues (*"Start quiet and get louder over this verse"*, *"Key change here"*), editable inline with one tap and stored in both ChordPro `{note: ...}` directives and `layout_prefs.sidebar_notes`. |
| **Vocal Key Analytics** | `js/analytics.js` computes each song's **Concert Sounding Pitch Key** ($\text{Written Shapes Key} + \text{Preferred Transpose} + \text{Capo}$), ranks your best singing tonal centers (`A / F#m`, `G / Em`, etc.), and recommends keys and capo positions for new songs. |
| **Melody Range** | `js/melody.js` keeps each song's lowest and highest sung notes (set by hand under More, or looked up by the AI from the best-known recording, whose key is saved too) against the written key, so transpose, capo, and tuning move them. My Keys works out your vocal range from the songs you sing well (or the range you set), flags songs whose notes run past it under Bad fit, and suggests the key that brings every note inside. |

---

## 2. Deploy Steps (Shared Supabase + New GitHub Repo)

### Step 1: Run the Database SQL Migration in Your Existing Supabase Dashboard
1. Open your House Index Supabase project dashboard → **SQL Editor**.
2. Open [supabase/sql/v0.1-init.sql](file:///Users/erikstrock/Desktop/myStuff/Apps/Chord-Book/supabase/sql/v0.1-init.sql) directly from disk, copy its contents, paste into the SQL Editor, and click **Run**.
   - This creates `cb_songs`, `cb_setlists`, `cb_setlist_items`, `cb_song_shares`, `cb_song_revisions`, and their `private.cb_*` RLS policies. It is 100% idempotent and does not alter any House Index tables.

### Step 2: Deploy the `import-sheet` Edge Function (for Snips, Camera Photos, PDFs & AI Align)
1. In your Supabase dashboard → **Edge Functions** → click **Deploy a new function** → name it `import-sheet`.
2. Paste the contents of [supabase/functions/import-sheet/index.ts](file:///Users/erikstrock/Desktop/myStuff/Apps/Chord-Book/supabase/functions/import-sheet/index.ts) and deploy.
   - Because it shares your House Index project, `ANTHROPIC_API_KEY`, `SUPABASE_PUBLISHABLE_KEYS`, `increment_ai_usage`, and `log_ai_call` are already configured and ready.

### Step 3: Push to Your New GitHub Repository & Enable GitHub Pages
1. Create a new public repository on GitHub (e.g., `Chord-Book`).
2. Push this folder:
   ```bash
   git init
   git add .
   git commit -m "Chord Book v0.1 Beta"
   git branch -M main
   git remote add origin https://github.com/<your-username>/Chord-Book.git
   git push -u origin main
   ```
3. On GitHub → **Settings → Pages** → set Source to **Deploy from a branch (`main` / `/ (root)`)**.
4. In Supabase → **Authentication → URL Configuration → Redirect URLs**, add `https://<your-username>.github.io/Chord-Book/**` so password reset links work for Chord Book too.

---

## 3. Running the Headless Test Suite (No Backend, No Spend)

Run all 4 test harnesses anytime from the terminal:

```bash
python3 testing-skills/chords_test.py
python3 testing-skills/chordpro_test.py
python3 testing-skills/edge_function_policy_test.py
python3 testing-skills/melody_test.py
python3 testing-skills/import_layout_test.py   # needs Deno; skips without it
python3 testing-skills/render_fit_test.py
python3 testing-skills/behaviour_test.py
```

| Harness | What It Verifies |
|---|---|
| [chords_test.py](file:///Users/erikstrock/Desktop/myStuff/Apps/Chord-Book/testing-skills/chords_test.py) | 70 checks: every chord quality in SPEC 5.3, non-chord word rejection, 12-semitone transpose round-trips, key-based sharp/flat spelling, capo math & suggestions, Nashville numbers, SVG chord voicings, and tonal center grouping. |
| [chordpro_test.py](file:///Users/erikstrock/Desktop/myStuff/Apps/Chord-Book/testing-skills/chordpro_test.py) | 16 checks: lossless ChordPro `parse`/`serialize` round-trip, standard 2-line chords-over-lyrics alignment, and a collapsed single-line paste. |
| [edge_function_policy_test.py](file:///Users/erikstrock/Desktop/myStuff/Apps/Chord-Book/testing-skills/edge_function_policy_test.py) | 10 checks: publishable key helper, daily caps failing closed (`LIMIT_CHECK_FAILED`), `log_ai_call` token logging, SSRF URL helpers, and live execution of the `==== CHORD NET ====` block in headless Chrome. |
| [melody_test.py](file:///Users/erikstrock/Desktop/myStuff/Apps/Chord-Book/testing-skills/melody_test.py) | 27 checks: What's new lists the current release; melody notes and the original recording's key are saved; notes follow capo, transpose, tuning, and a rewritten key; an AI range from the recording maps onto the sheet; octave choice for a melody written for another voice; your range from the songs you sing well; key advice and Bad fit that bring every note inside your range. |
| [import_layout_test.py](file:///Users/erikstrock/Desktop/myStuff/Apps/Chord-Book/testing-skills/import_layout_test.py) | 6 checks (Deno): chords stay on the right one of a repeated word, a correct AI line is kept, and a line the AI stacked or padded with a repeated ending goes back to the source layout. |
| [render_fit_test.py](file:///Users/erikstrock/Desktop/myStuff/Apps/Chord-Book/testing-skills/render_fit_test.py) | 18 checks: `1-Sheet (8.5×11")` and `2-Sheet (8.5×11")` auto-fit engine (`scrollHeight <= clientHeight`), chord-over-syllable alignment, sidebar margin note editing, transposition, ugly paste import UI flow, vocal key analytics, and 360px/390px/430px responsive viewports. |
| [behaviour_test.py](file:///Users/erikstrock/Desktop/myStuff/Apps/Chord-Book/testing-skills/behaviour_test.py) | 15 checks: per-song saved settings + Undo, Rewrite in Key + Undo, Delete Song + Undo, full-screen Stage Performance Mode + auto-scroll, Set Lists, Service Worker registration, and zero CSP violations. |
| [ai_import_live_test.py](file:///Users/erikstrock/Desktop/myStuff/Apps/Chord-Book/testing-skills/ai_import_live_test.py) | **Paid, opt-in (`--spend`).** Signs in as the House Index test account and sends every file in the git-ignored `House Index Test/` folder (photos, screenshots, PDFs, text copies, links) through the deployed `import-sheet`. Grades each sheet against the goals and against the owner's finished copies where they exist, then saves the songs to the test account (tag `import-test`) for review. |

---

## 3b. Songs, Privacy & UI Conventions (v0.4)

**Song lyrics stay out of this repo.** The repo and site are public, so new sheets live only in Supabase behind row-level security. `Chords to Add/` is git-ignored, including the private `Chord Book - Load Into Supabase.sql` file that creates the tables and loads the song library. That file is safe to run twice and never deletes or overwrites a song.

**Signed in, Supabase is the source of truth.** Signed out, the app uses a separate on-device book and sends no song data requests. A failed load shows "Couldn't load your songs", never an empty library.

**Keep these when changing the UI:**
- The song screen has Key, Capo, Play, and More. Everything else belongs in the More sheet.
- Key, capo, and view changes save themselves. There is no Save button.
- The editor asks before discarding unsaved work, and an imported sheet counts as unsaved.
- Touch targets are at least 44px, and form fields are 16px on touch screens so iOS doesn't zoom.
- Sheets are read while playing and singing. They start at 11pt, never go below 10.5pt, and never grow to fill a page. A long song takes another page.
- Every sheet uses the same format: title, artist, key, capo, a `Form:` line, and labeled sections.
- Tab is for learning a part, not for singing along: a tab block always spans the full page width (the verses and choruses around it may still use two columns), and all tab blocks in a song share one size that makes the widest block fill the page width (7.5 to 10pt). "Hide tabs", beside Capo on songs that have tab, leaves tab out on screen, in Play, and in print, and is saved per song. Tab songs may run up to 8 pages.
- Before adding a page, the fit tries other page breaks, since a repeated chorus counts in full but may print as "Repeat Chorus".
- Choruses are written out every time they're sung. Only when a song won't fit on one page does the fit print a repeat as "Repeat Chorus". "Hide repeated choruses" in More does that on purpose.
- Paste import is one button, and it also takes a link to a chord page. A set list PDF (or photos of several songs) adds every song. Signed in, `import-sheet` reads the paste with Sonnet 4.6 and returns the title, artist, genre, tuning, tempo, Form, and aligned sections. Signed out, or if the AI can't be reached, `smartImportText` formats it on the device, including chord sites copied on a phone (Chordie, AZChords), where each chord and word lands on its own line.
- Genre stays broad: Worship, Country & Folk, Rock & Alternative, and Pop & Other. It's stored in `layout_prefs.genre`, and a song without one is Worship.
- Auto-scroll is one steady speed per song: `js/timing.js` estimates length from BPM, time signature, the `Form:` line, intros, interludes, and repeats, then Play divides the current screen distance by that length.
- Tuning is one of Standard, Half step down, Drop D, or Other. Half step down lowers every "Sounds in" key and vocal suggestion by one semitone.
- On the Play screen, chords ignore taps so page turns always work. A pedal press at the end of a song moves to the next one.

---

## 4. AI Spend Query (Shared with House Index)

Run this in the Supabase SQL Editor to see your monthly Chord Book AI token usage and cost alongside House Index:

```sql
select
  to_char(date_trunc('month', created_at), 'YYYY-MM') as month,
  task,
  model,
  count(*) as calls,
  sum(input_tokens) as in_tokens,
  sum(output_tokens) as out_tokens,
  round(
    sum(
      case
        when model like '%sonnet%' then (coalesce(input_tokens,0) * 3.0 + coalesce(output_tokens,0) * 15.0) / 1e6
        else (coalesce(input_tokens,0) * 0.8 + coalesce(output_tokens,0) * 4.0) / 1e6
      end
    )::numeric, 4
  ) as est_usd
from public.ai_calls
where task like 'cb_%'
group by 1, 2, 3
order by 1 desc, 2;
```
