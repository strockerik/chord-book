# Chord Book — product and build spec

*Working name; rename freely. Written 2026-11-15 from The House Index (Strock-Recipes,
v1.9.2), whose foundation this app reuses.*

Chord Book stores guitar chord sheets, shows them cleanly on a phone or tablet,
transposes them, and uses AI to import and write new sheets. It is a private,
invitation-only web app for one person and the people they play with.

This spec is for whoever builds it (most likely Claude Code in a new repo). Read
sections 1–3 before writing code; section 13 is the build order.

---

## 1. Principles

These are what made House Index work. Keep them.

1. **No build step.** Plain HTML, CSS and JavaScript served by GitHub Pages; no Node,
   npm, bundler or framework on the dev machine. (House Index's dev Mac has no
   node/npm/docker/brew; the only tools are Python 3, Chrome, and a Deno binary used
   for type checks.)
2. **Supabase is the backend.** Postgres with row-level security on every table,
   email/password auth, Edge Functions for anything that needs a secret (AI keys).
3. **The browser never holds a secret.** `config.js` carries the URL and the
   *publishable* key only. AI keys live in Edge Function secrets; the database
   secret key lives in a gitignored `notes.md` for admin scripts.
4. **Every paid AI call is capped, checked, and logged.** Per-user daily caps that
   refuse the call if the cap can't be checked; one log row per model call with
   tokens.
5. **AI output is validated by code before the user sees it.** House Index runs an
   allergen net over generated recipes and repairs once; Chord Book runs a chord
   net (section 7.4).
6. **Undo, not "are you sure?".** Destructive actions keep the old rows in hand and
   offer Undo for a few seconds.
7. **Works offline at the gig.** The service worker caches the app and the signed-in
   user's songs; a set list marked for offline is fully cached.
8. **360 px is a real screen.** Every layout is tested at 360, 390 and 430 px.
9. **Tests run headless with no backend and no spend.** Paid checks are separate,
   small, and run only with the owner's OK.
10. **The README is the operating manual.** Setup SQL, deploy steps, decisions, and
    the reasons behind them.

---

## 2. What carries over from House Index

Copy the files listed, then rename. "Adapt" means the shape stays and the domain
changes.

### 2.1 Copy nearly as-is

| From House Index | What it gives Chord Book | Change |
|---|---|---|
| `index.html` head | CSP `<meta>`, viewport, manifest, theme color, self-hosted font links | App name, colors |
| `fonts/` + `@font-face` block in `style.css` | Fraunces, Public Sans, IBM Plex Mono (Latin + Latin Ext, OFL) | None. IBM Plex Mono is the chord and tab face |
| `style.css` tokens and components | Palette tokens, buttons (`solid-btn`, `ghost-btn`, `link-btn`), chips, sheets (`grocery-panel` pattern), toasts, captions under header icons | Rename classes off "grocery"; new accent colors |
| `vendor/supabase-2.118.0.min.js` | supabase-js, same-origin (CSP-friendly) | None |
| `config.js` pattern | `SUPABASE_URL` + publishable key | New project's values |
| `sw.js` | Network-first shell (4 s timeout), per-user data cache that never caches anonymous reads, wipe on sign-out, self-hosted font precache | Cache names; add an "offline set list" prefetch (section 6.9) |
| Auth gate (sign-in only, Forgot password, set-new-password form, Resend confirmation) | Invitation-only accounts | Copy verbatim |
| Sheet handling (focus in, focus back, Escape closes the top one, `inert` page behind) | Accessible modal sheets | Copy verbatim |
| `toast()`, `toastAction(msg, "Undo", fn)`, `toastError()` | Feedback and Undo | Copy verbatim |
| `esc()`, `userKey()`, `loadLocal()`/`saveLocal()` | XSS-safe templating, per-user local storage | Copy verbatim |
| Offline banner + queued writes | Edits made offline are sent when the connection returns | Queue song edits and set-list ticks |
| Version pill (`APP_VERSION`) | Which build is on the phone | Start at 0.1 |
| Edge Function scaffolding | Publishable-key helper, CORS, `json()`, signed-in check, `LIMIT_CHECK_FAILED`, `logAiCall`, `strictify` + forced-tool `runTool`, SSRF-safe fetch (`parseAllowedUrl`, `resolvesPublic`, `readCapped`) | Copy into each function (dashboard deploys can't share a `_shared/` folder) |
| SQL patterns | Usage table + `increment_*_usage` function, `ai_calls` + `log_ai_call` (with `p_user_id` for service-role callers), `profiles` + `my_people()`, shares + `private.*` helper functions (avoid RLS recursion) | Section 4 |
| `scripts/backup_recipes.py`, `scripts/launchd/install_backup_job.sh`, `supabase/sql/export_schema.sql` | Weekly off-Supabase backups, schema in version control | Table lists |
| Test harnesses (`testing-skills/`) | Headless Chrome against a Proxy-based Supabase stub that honors `.eq()`, `.in()`, `.single()`/`.maybeSingle()`, `.rpc()`; viewport test at 360/390/430; offline + CSP test; Edge Function policy test | Section 10 |

### 2.2 Adapt (same idea, new domain)

| House Index | Chord Book |
|---|---|
| Recipe | Song (a chord sheet) |
| Kitchen / Bar sections | Songs / Set lists |
| Servings scaling | Transpose (semitones) and capo |
| Original / US / Metric toggle | Original / Transposed / Capo shapes, plus Nashville numbers |
| Cook mode (full screen, wake lock, step by step) | Performance mode (full screen, wake lock, auto-scroll, pedal turns) |
| Meal plan | Set list |
| Send a recipe or the week's plan (self-contained HTML page) | Send a song or set list (self-contained HTML page, print-ready) |
| `extract-recipe` (paste text, photos with a note, link) | `import-sheet` |
| `generate-recipe` (ideas, then the full recipe) | `write-song` |
| `recipe-coach` (troubleshoot / adjust, `get_recipe` lookup) | `song-coach` (explain / rework, `get_song` lookup) |
| Allergen net (repair once, then refuse) | Chord net (section 7.4) |
| Recipe shares (`recipe_shares`, "Shared by …") | Song shares, for bandmates |

### 2.3 Leave behind

Bottles and ratings catalog, King Soopers, grocery engine, pantry inventory, drink
pairing, meal-plan grocery merge.

### 2.4 Lessons House Index learned the hard way

Each was a real bug or risk found in review. Build these in from the start.

- **Turn off public sign-up** in Supabase (Authentication → "Allow new users to sign
  up" → off) and have no sign-up link in the app. Add people from the dashboard.
- **Profiles are private.** No `using (true)` select policy on `profiles`. Names for
  sharing come from a `my_people()` function (section 4).
- **Caps fail closed** and every paid path has one, including "ideas" and "options"
  steps, which had none.
- **The publishable and secret keys only.** No legacy anon or service-role JWT keys
  anywhere.
- **Never wipe user data to rebuild it.** Merge, then offer Undo (House Index's meal
  plan "Create grocery list" deleted the list).
- **Undo restores everything a delete cascaded:** the row under its own id, plus
  its shares and set-list entries.
- **Per-account local storage** for anything personal (House Index's coach history
  wasn't, and showed on a shared device).
- **SQL goes into the editor straight from a file,** never through a chat window.
  Chat formatting turned `count(*)` into `count()` and joined lines after `--`
  comments.
- **Precompute anything expensive** a list reads on every open (House Index's bottle
  scores went from 0.55 s to 0.15 s as a materialized view).
- **Start with native ES modules** (`<script type="module">`, `import()` for features
  opened rarely). House Index grew one 8,000-line script that could no longer be
  split safely.

---

## 3. Architecture

### 3.1 Stack

| Layer | Choice |
|---|---|
| Hosting | GitHub Pages from `main` (a push deploys) |
| Front end | Vanilla JS as native ES modules, one CSS file, self-hosted fonts |
| Backend | A **new** Supabase project (see decision D2) |
| Server code | Supabase Edge Functions (Deno/TypeScript), paste-deployed in the dashboard |
| AI | Anthropic API from Edge Functions only |
| Offline | Service worker + per-user data cache |
| Type checks | `deno check` on every function before handing it over |
| Tests | Python + headless Chrome harnesses; `deno check`; `pglast` for SQL syntax |

### 3.2 Repo layout

```
index.html              page shell, CSP, auth gate, sheets
config.js               SUPABASE_URL + publishable key (public by design)
sw.js                   service worker
style.css               tokens, components, layouts
fonts/                  woff2 + OFL licenses
vendor/                 supabase-js (vendored)
js/
  core.js               boot, auth, toasts, sheets, storage, offline queue
  chords.js             chord grammar, transpose, capo, Nashville (pure, no DOM)
  chordpro.js           ChordPro parse/serialize, chords-over-lyrics import (pure)
  render.js             song → HTML (chords over lyrics), diagrams (SVG)
  library.js            song list, search, tags, sharing
  song.js               song view, transpose/capo toggle, editor
  perform.js            performance mode (loaded on demand)
  setlists.js           set lists (loaded on demand)
  ai.js                 import / write / coach sheets (loaded on demand)
  send.js               send a song or set list as a page (loaded on demand)
supabase/
  functions/<name>/index.ts
  sql/                  one file per release (v0.1-part1.sql …)
  schema.sql            exported live schema
scripts/
  backup.py             backup / restore
  launchd/install_backup_job.sh
testing-skills/         harnesses (section 10)
README.md
.gitignore              notes.md, backups/, data/, *.local
```

`chords.js` and `chordpro.js` stay free of DOM and network code so they can be
tested in isolation and imported by the Edge Functions as plain logic.

### 3.3 Keys and environments

- `config.js`: project URL and **publishable** key (`sb_publishable_…`). Public.
- Edge Function secrets: `ANTHROPIC_API_KEY`. Supabase provides
  `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS` to every function.
- `notes.md` (gitignored): `Project URL:`, `Secret Key: sb_secret_…`,
  `TEST_EMAIL=`, `TEST_PASSWORD=` (a test account for automated checks).
- Never print or commit anything from `notes.md`. Never run admin scripts against
  production from an automated session; the owner runs them.

### 3.4 Deploy flow

1. SQL: the owner pastes `supabase/sql/<release>.sql` into the SQL editor.
2. Edge Functions: the owner pastes each changed `index.ts` into the dashboard.
3. App: `git push origin main`; GitHub Pages serves it within a minute or two.
4. The app must work during every intermediate state (new app code before new SQL;
   functions deployed before or after). Use fallbacks the way House Index's
   `loadProfiles()` falls back until `my_people()` exists.

---

## 4. Data model

All tables in `public`, RLS on. `user_id` defaults to `auth.uid()`.

### 4.1 Tables

```sql
-- One chord sheet. The ChordPro text is the source of truth; everything else is
-- metadata for listing, searching and sorting.
create table public.songs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null,
  artist text,
  chordpro text not null,               -- canonical sheet (section 5)
  key text,                             -- written key, e.g. 'G', 'Em', 'Bb'
  capo int not null default 0 check (capo between 0 and 12),
  tempo int check (tempo between 20 and 300),
  time_signature text,                  -- '4/4', '3/4', '6/8'
  tuning text not null default 'standard',
  duration_sec int,                     -- for auto-scroll
  tags text[] not null default '{}',
  source text,                          -- where it came from (URL, "photo", "AI", free text)
  notes text,
  is_favorite boolean not null default false,
  preferred_transpose int not null default 0 check (preferred_transpose between -11 and 11),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.setlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  event_date date,
  notes text,
  offline boolean not null default false,   -- keep fully cached on this account's devices
  created_at timestamptz not null default now()
);

create table public.setlist_items (
  id uuid primary key default gen_random_uuid(),
  setlist_id uuid not null references public.setlists(id) on delete cascade,
  song_id uuid not null references public.songs(id) on delete cascade,
  position int not null,
  transpose int not null default 0 check (transpose between -11 and 11),  -- per-gig key
  capo int check (capo between 0 and 12),
  notes text,
  unique (setlist_id, position)
);

create table public.song_shares (
  song_id uuid not null references public.songs(id) on delete cascade,
  shared_with_user_id uuid not null references auth.users(id) on delete cascade,
  shared_by_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (song_id, shared_with_user_id)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  prefs jsonb not null default '{}'::jsonb,   -- font size, chord style, flats/sharps, left-handed diagrams
  created_at timestamptz not null default now()
);

-- AI caps and the call log: the House Index shapes.
create table public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_date date not null,
  kind text not null,                        -- 'import', 'write', 'ideas', 'coach'
  count int not null default 0,
  primary key (user_id, usage_date, kind)
);
create table public.ai_calls (
  user_id uuid not null references auth.users(id) on delete cascade,
  task text not null, model text not null, valid boolean not null,
  latency_ms int, escalated boolean not null default false,
  input_tokens int, output_tokens int, cache_read_tokens int,
  created_at timestamptz not null default now()
);
```

Add an `updated_at` trigger on `songs`, and indexes on `songs (user_id, title)`,
`setlist_items (setlist_id, position)`, and a trigram index on `songs.title` for
search (`pg_trgm`).

### 4.2 Policies and helpers

- `songs`: owner has full access. Recipients can select via
  `private.song_shared_with_me(id)`.
- `song_shares`: the owner manages them, with `private.owns_song(song_id)` in the
  `with check`. Recipients can select their own rows.
- `setlists`, `setlist_items`: owner only. `setlist_items` checks ownership through
  `private.owns_setlist(setlist_id)`.
- `profiles`: each account reads and updates only its own row.
- `ai_usage`: users can select their own rows. `ai_calls` has no policies (written
  only by `log_ai_call`).
- Functions, copied from House Index with names changed:
  - `increment_ai_usage(kind, limit)` returns the new count or `-1`.
  - `log_ai_call(...)` takes `p_user_id`, honored only for the service role.
  - `my_people()` returns you plus everyone you share songs with, and everyone who
    shares with you.
  - `lookup_user_id_by_email(email)` is used for sharing (sign-up is closed, so
    this can't be used to probe accounts at scale).
  - `private.owns_song`, `private.song_shared_with_me` and `private.owns_setlist`
    are `security definer`, `search_path = ''`, `stable`. The schema needs
    `grant usage on schema private to authenticated`.

### 4.3 Revisions (later)

`song_revisions (song_id, chordpro, created_at)`, written on each save, keeping the
last 20. Use it for "Restore an earlier version" and as the safety net for AI
rewrites.

---

## 5. The song format: ChordPro

ChordPro is the standard plain-text chord sheet format. Store the sheet as
ChordPro and render from it.

### 5.1 Supported subset

```
{title: Wildflower Road}
{artist: Erik Strock}
{key: G}
{capo: 2}
{tempo: 96}
{time: 4/4}

{start_of_verse: Verse 1}
[G]Walking down the [C]wildflower [G]road
[Em]Sun on my [C]shoulders, [D]light on the [G]load
{end_of_verse}

{start_of_chorus}
[C]Oh, the [G]long way [D]home
{end_of_chorus}

{comment: Let it ring}
{start_of_tab}
e|-----0-----|
B|---1---1---|
{end_of_tab}

{define: Dsus4 base-fret 1 frets x x 0 2 3 3}
```

- **Metadata:** `title` (`t`), `subtitle`/`artist` (`st`), `key`, `capo`, `tempo`,
  `time`, `duration`.
- **Sections:** `start_of_verse`/`sov`, `start_of_chorus`/`soc`,
  `start_of_bridge`/`sob`, `start_of_tab`/`sot` (shown verbatim in monospace), each
  with its `end_of_…`. An optional label follows the colon.
- **`{chorus}`** repeats the last chorus by reference.
- **`{comment: …}`** (`c`) is a performer note.
- **`{define: …}`** is a custom chord shape.
- **Unknown directives are kept and ignored**, so nothing is lost on a round trip.

### 5.2 Parsing (`chordpro.js`)

- `parse(text) → { meta, sections: [{ type, label, lines: [{ segments: [{ chord, lyric }] } | { tab } | { comment }] }] }`
- `serialize(model) → text` must round-trip `parse()` exactly for supported input.
  Test with a corpus of sheets.
- `fromChordsOverLyrics(text) → chordpro` imports the format most sheets on the web
  use, with chords on their own line above the lyrics:
  - A line is a **chord line** when every token parses as a chord (section 5.3) or
    is a bar or repeat mark (`|`, `x2`, `N.C.`).
  - Merge each chord line into the lyric line below it by **column position**, so
    `[C]` goes before the character under the chord's first letter. Pad short
    lyric lines with spaces.
  - A chord line with no lyric line under it becomes an instrumental line of chords
    only.
  - Section headers like `[Verse]`, `Chorus:` or `INTRO` become sections.
  - This is deterministic and free. AI is only the fallback for messy input
    (section 7).

### 5.3 Chord grammar (`chords.js`)

```
chord   = root quality? ("/" bass)?
root    = [A-G] ("#" | "b")?
bass    = [A-G] ("#" | "b")?
quality = the rest, kept as written: m, min, -, maj7, M7, Δ, 7, 9, 11, 13, sus2, sus4,
          add9, add11, 6, 69, m6, m7, m9, m7b5, ø, dim, °, dim7, aug, +, 5, 7#9, 7b9, …
```

- `parseChord("F#m7b5/A") → { root: "F#", quality: "m7b5", bass: "A" }`. The quality
  is opaque text: transposing never rewrites it.
- `isChord(token)` accepts the grammar plus `N.C.`, and rejects ordinary words
  ("A" in a lyric line is ambiguous; it's only a chord inside `[ ]` or on a chord
  line).
- **Spelling:** convert note names to pitch classes 0–11, then back using the
  target key's preference:
  - **Flats** for keys F, Bb, Eb, Ab, Db, Gb and Dm, Gm, Cm, Fm, Bbm, Ebm.
  - **Sharps** for all other keys.
  - **The user can override** this (always sharps, always flats).

---

## 6. Features

MVP is everything not marked *later*.

### 6.1 Library

- A list of songs with title, artist, key and tags. Search covers title, artist,
  tags and lyric text.
- Sort by A–Z, recently played, recently added or key.
- Favorites and a tag filter sheet, with the House Index filter-sheet pattern and
  active-filter chips.
- Show "Shared by …" on songs others shared with you, with a separate "Shared"
  view as in House Index.
- The first-run empty state offers paste, photo, or write with AI.

### 6.2 Song view (clean reading)

- **Chords over lyrics.** Each `{chord, lyric}` segment is an inline-block column,
  with the chord on top and the lyric fragment below:
  - Lines wrap naturally on narrow screens and chords stay over their syllable.
    This is the core rendering technique; never place chords with absolute pixel
    offsets.
  - A chord with no lyric under it gets a minimum width so neighbouring chords
    don't collide.
- **Section labels and spacing.** Choruses are visually distinct (an indent or a
  rule), and comments are italic.
- **Tabs** render verbatim in IBM Plex Mono with horizontal scroll inside the block.
  The page itself never scrolls sideways.
- **Display options**, remembered per account:
  - Font size, in steps.
  - Chords inline or above.
  - Lyrics only, or chords only, the latter for rhythm players with a lead sheet
    in their head.
  - Left-handed diagrams.
- **Chord diagram strip:** every distinct chord in the song, in the order first
  played, as SVG (section 6.4). Tap a chord in the sheet to see its diagram.

### 6.3 Transpose and capo

- **Toggle:** Original | Transposed | Capo, like House Index's units toggle. It
  changes the display only; "Save in this key" rewrites the stored sheet, with
  Undo.
- **Transpose:** ±1 semitone steps, or pick a target key. The written key follows,
  and chords are re-spelled for the new key (section 5.3).
- **Capo:**
  - Given the sounding key and a capo fret, show the shapes you play. Shapes key =
    sounding key − capo.
  - **Suggest capo positions** that turn the song into open-chord shapes (C, G, D,
    A, E, Am, Em, Dm). For example, Bb with capo 3 plays as G shapes.
- **Nashville numbers** (later): show each chord as a degree of the key (1, 4, 5,
  6m, 2m), with slash chords as `1/3`.
- **Per set list:** a song's transpose and capo can differ per gig
  (`setlist_items`).

### 6.4 Chord diagrams

- An SVG drawn from a fret string, e.g. `x32010` = C, plus an optional finger
  string and base fret. Mark open and muted strings and barres.
- **Built-in library** of common open and barre voicings for standard tuning:
  - majors, minors, 7, maj7, m7, sus2, sus4, add9, dim and aug on every root;
  - movable E- and A-shape barres generated for any root.
- **`{define:}`** in the sheet overrides the library for that song.
- **Unknown chord:** show the name with a "no diagram" placeholder, never a wrong
  shape.
- Later: alternate tunings (DADGAD, open G, drop D) and ukulele.

### 6.5 Editing

- **Plain ChordPro editor** (textarea, monospace) with a live preview below on
  phones and beside it on tablets.
- **Inline chord insert:** tap a word to place a chord there, or pick from the
  song's chords and recent chords.
- **Validation as you type:**
  - unknown chords are underlined;
  - unclosed sections are flagged;
  - an unknown directive gets a notice.
- **Unsaved-changes guard on close.** House Index's "Discard changes?" is one of the
  few dialogs worth keeping.

### 6.6 Import

| Path | How | Cost |
|---|---|---|
| Paste ChordPro | Parse | Free |
| Paste chords-over-lyrics text | `fromChordsOverLyrics` | Free |
| Paste messy text (inline chords in parentheses, tabs mixed in) | `import-sheet` AI | Capped |
| Photo(s) of a printed or handwritten sheet, with an optional note ("only the second song") | `import-sheet` vision | Capped |
| Link | Fetch only if robots.txt allows Claude's agents; many chord sites forbid scraping and block bots, so the paste path is the main one | Capped |

Every import lands in the editor for review before saving, as House Index's AI
import does.

### 6.7 AI: write and rework

See section 7. In the app:

- **Write a song.** The user describes mood, style, key, tempo, structure,
  difficulty ("no barre chords") and an optional theme. They get **three ideas**
  first (title + one line + progression), pick one, and get the full sheet.
- **Rework this sheet:** simplify ("open chords only"), reharmonize ("jazzier
  chorus"), change feel ("make it a waltz"), or add a bridge. The result opens as a
  **draft beside the original**; saving replaces the sheet, with Undo, and the old
  version goes to revisions.
- **Ask about this song (coach):**
  - It explains the progression ("why does the E7 work here?") and suggests capo or
    voicings.
  - It gives practice tips, and can compare with another of your songs through the
    `get_song` lookup.

### 6.8 Set lists

- Create, order (drag, or move up/down buttons for accessibility), and add or remove
  songs, with a per-gig key and capo for each.
- **Perform the set:** performance mode runs through the songs in order.
- **Send the set list** as a self-contained page (or print to PDF), in the order
  played with each song's key. Reuse House Index's send-the-week page pattern.

### 6.9 Performance mode

- **Display:** full screen, Screen Wake Lock, a large type scale, and a dark stage
  theme option.
- **Auto-scroll:**
  - The speed comes from `duration_sec`, or from tempo and the number of bars when
    known.
  - Tap to pause or resume; speed has +/− controls.
  - A count-in delay before the scroll starts.
- **Page turns:**
  - Tap zones: the right third goes forward, the left third goes back.
  - Bluetooth page-turner pedals send `PageDown`/`ArrowRight`/`Space` and
    `PageUp`/`ArrowLeft`.
  - Swipe also works.
- **Landscape on a tablet:** two columns (CSS columns), with sections kept whole
  where possible.
- **Next song:** in a set list, show the next song's title and key at the bottom.
- **Offline:** a set list marked offline prefetches every song in it, and the
  service worker data cache keeps them for that account.

### 6.10 Sharing and backup

- **Share a song** with a bandmate by email, using the House Index `recipe_shares`
  pattern. Recipients can view it and "Copy to my book".
- **Send a song** outside the app as a self-contained HTML page with chords and
  diagrams, print-ready.
- **Back up:**
  - In the app: download your songs as a ChordPro `.zip`, or a JSON export.
  - Admin script: a weekly backup on the Mac via launchd, keeping the newest 8.

---

## 7. AI layer

### 7.1 Edge Functions

| Function | Does | Model (start) | Cap / day |
|---|---|---|---|
| `import-sheet` | Messy text, photos (+ note) or a link → a structured sheet | Haiku-class for text; Sonnet-class for photos | 20 |
| `write-song` | `mode: ideas` → 3 ideas; `mode: full` → a sheet; `mode: rework` → a revised sheet | Haiku-class | ideas 60, full and rework 20 |
| `song-coach` | Multi-turn explain / rework, with a `get_song` tool | Sonnet-class | 20 |

Use the models House Index proved for these jobs: Haiku 4.5 with strict tool use
for text, and Sonnet 4.6 for vision and the coach. A/B newer models against a fixed
test set before switching, as House Index did with Haiku 5.5 (that test was rolled
back). Two API facts from House Index:

- **Strict tool schemas** are supported on Haiku 4.5, not on Sonnet 4.6.
- **The newest Sonnet and Opus models reject forced `tool_choice`.** On those,
  ask for the tool with `tool_choice: auto`, or use structured outputs.

### 7.2 Request rules (copied from House Index)

1. Check the caller is signed in, before anything paid.
2. Validate input before the cap, so bad requests don't use quota.
3. Check the cap right before the paid call. If the cap can't be checked, refuse with
   "Couldn't check today's limit — try again in a minute."
4. Use a forced tool with a JSON schema. Retry once without `strict` if the strict
   schema is rejected (that 400 isn't billed).
5. Handle `stop_reason` `refusal` and `max_tokens` with plain messages.
6. Run the chord net (section 7.4) and repair once.
7. Log every model call: `logAiCall(client, task, model, valid, ms, {usage})`.
8. Always reply HTTP 200 with `{ result } | { error }`, so the browser reads either.
9. Keep CORS `*`. Auth is a bearer token, not a cookie, so restricting CORS adds
   nothing.

### 7.3 Output schema (the tool input)

```json
{
  "title": "string",
  "artist": "string | null",
  "key": "string",
  "capo": 0,
  "tempo": 96,
  "time_signature": "4/4",
  "sections": [
    { "type": "verse|chorus|bridge|intro|outro|instrumental|tab",
      "label": "string | null",
      "lines": [ { "text": "lyric text with [C]inline [G]chords", "tab": false } ] }
  ],
  "notes": "string | null"
}
```

The function serializes this to ChordPro with `chordpro.js` logic, so the client
always receives valid ChordPro plus the model's notes.

### 7.4 The chord net

Like House Index's allergen net: code checks the AI's work, and a failure gets one
repair request.

- **Every chord in `[ ]` must parse** (section 5.3). Unknown tokens fail.
- **Key and chords must agree.** If the stated key's tonic chord never appears, or
  most chords sit outside the key and its common borrowings, flag it. Only refuse if
  the repair also fails.
- **Sections must be complete:** non-empty lines, no empty sections, at most 200
  lines.
- **Constraints must hold:**
  - "no barre chords" means only chords with an open voicing in the built-in library;
  - "in G" means the key field is G;
  - "capo 2" means capo is 2.
- **Write mode never reproduces existing lyrics** (section 11). Lyrics must be
  original. If the request names a real song, give chords and structure only, with
  `[lyrics: your own]` placeholders.

On failure, send one repair request that names the exact problems. If it still
fails, return a plain error that says what went wrong.

### 7.5 Prompts

- **Write for a guitarist at home:** playable, singable, simple by default; say when
  something needs a barre chord.
- **Use the user's own words in notes,** never prompt jargon. House Index leaked
  "Tier-2" into recipe notes.
- **Import is a transcription:**
  - don't "improve" chords;
  - flag guesses in `notes` ("unclear chord in bar 3, read as Am");
  - follow the user's note on which song to take from a page.
- **The coach gets the song's ChordPro and the list of the user's song titles.**
  It calls `get_song` only when it needs another song's content (at most 2 lookups
  per turn), and caches the system prompt across turns.

### 7.6 Cost

House Index measured a full app run of about 29 calls at roughly $0.35–0.40. Chord
Book should cost a few cents per import or song. Keep the README spend query:
tokens by task and month, with a price table.

---

## 8. UX and design

- **Design tokens:** House Index's paper, ink, faint and line colors. Pick a new
  accent (a deep blue, or an amber "stage" color).
- **Type:**
  - Fraunces for titles.
  - Public Sans for lyrics and UI; lyrics run large and readable.
  - IBM Plex Mono for chords and tabs, bold so chords stand out from lyrics.
- **Header:** app name, then icon buttons with captions underneath: Songs, Set
  lists, Guide, You. One meaning per icon, unlike House Index's 🛒.
- **Contrast:** at least 4.5:1 for text, including faint text and chords on tinted
  backgrounds.
- **Touch targets:** at least 40 px, and nothing overflows at 360 px.
- **Sheets:** focus moves in, the page behind is inert, Escape closes the top one,
  and focus returns to whatever opened it.
- **Undo** for delete song, remove from set list, clear set list, and save over a
  sheet.
- **Toasts** are a live region, and Undo stays clickable while a sheet is open
  (toasts sit outside the inert regions).
- **Dark mode:** a full token set under `prefers-color-scheme: dark`, plus the stage
  theme in performance mode.
- **Guide sheet:** a short in-app feature tour, as in House Index.

---

## 9. Security checklist

- [ ] Sign-ups disabled in Supabase; no sign-up UI.
- [ ] RLS on every table; anonymous reads return nothing (test it live).
- [ ] `profiles` private; names via `my_people()`.
- [ ] Every paid path capped; caps fail closed; the Edge Function policy test
      enforces both.
- [ ] Every AI call logged with tokens.
- [ ] `esc()` on every interpolated value; URLs validated as `http(s)` before they
      become links; no `innerHTML` of model output without escaping.
- [ ] CSP with no inline scripts, same-origin fonts, and `connect-src` limited to the
      Supabase project.
- [ ] Link import: `parseAllowedUrl` + `resolvesPublic` (DNS check, re-checked after
      redirects) + `readCapped` (5 MB).
- [ ] Publishable/secret keys only; nothing secret in the repo (it's public for
      GitHub Pages).
- [ ] Per-account local storage keys (`hi:<user>:…` pattern); wipe the data cache on
      sign-out.

---

## 10. Testing

Each House Index harness has a Chord Book counterpart. All run headless with no
backend and no spend, and every suite must pass before a push.

| Harness | Checks |
|---|---|
| `chords_test.py` | Grammar (every quality above), transpose round trips (12 steps return the original), sharp/flat spelling by key, slash chords, capo shapes and suggestions, Nashville numbers |
| `chordpro_test.py` | Parse/serialize round trip over a corpus; chords-over-lyrics import (column alignment, chord-only lines, section headers, tabs untouched) |
| `render_smoke_test.py` | Chords stay over their syllables; wrapping at 360 px doesn't separate a chord from its lyric; tab blocks scroll inside, never the page |
| `viewport_smoke_test.py` | 360/390/430 px: no page overflow, touch targets at least 40 px, header captions fit, performance-mode controls reachable |
| `perform_test.py` | Wake lock requested and released; pedal keys turn pages; auto-scroll pauses on tap; next-song footer in a set list |
| `behaviour_test.py` | In-memory Supabase that keeps state: delete + Undo restores shares and set-list rows; "Save in this key" + Undo; offline edits are queued, then sent |
| `offline_csp_test.py` | CSP has no violations; an offline set list opens with no network |
| `edge_function_policy_test.py` | Every paid function has caps, refuses when a cap fails, logs its calls, uses no legacy keys, and link import goes through the safety helpers |
| `chord_net_test.py` | Runs the real net from the function source on good and bad AI outputs |
| `deno check` | Every function type-checks before it's handed over |
| `pglast` | Every `supabase/sql/*.sql` parses |

**Paid checks** need the owner's OK. They sign in as the test account with the
publishable key and run a fixed set:

- import a messy paste, two photos and a link;
- write ideas, then a full song, then rework it to open chords;
- three coach turns, including a `get_song` lookup.

Compare against the last run and save a `_summary.md` in a gitignored
`ai_test_runs/`.

---

## 11. Copyright and terms

- **The app is private:** invitation-only, with sharing limited to named people.
  Users store sheets they own or transcribed for personal use.
- **AI writing creates original lyrics.** It must not reproduce lyrics of existing
  songs. For a named song it may suggest chords and structure only (section 7.4).
- **Imports transcribe what the user provides,** such as a photo of their own sheet
  or a paste. The app doesn't crawl chord sites; many forbid scraping, and robots.txt
  is checked before any link is fetched.
- **Fonts are OFL,** and their license files ship with them.

---

## 12. Operations

- **README:** setup SQL by release, deploy steps, decisions with reasons, harness list,
  and the spend query.
- **`supabase/sql/<release>.sql`:** the owner runs it, and every file is safe to run
  twice.
- **`supabase/schema.sql`:** re-export after each SQL change with `export_schema.sql`.
  Paste the result straight into the file.
- **Backups:**
  - `scripts/backup.py` saves songs, set lists, shares and profiles to
    `backups/chord-book-YYYY-MM-DD.json`, keeping the newest 8.
  - The weekly launchd job runs it.
  - `--restore` puts songs back, using the same id and staying idempotent.
- **Versioning:** `APP_VERSION` (shown in the footer pill) goes up with each release;
  bump the service worker's `VERSION` when cached files change shape.

---

## 13. Build plan

Each milestone is releasable, ends with all harnesses passing, and gets pushed.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Foundation lift.** New repo and Supabase project. Copy section 2.1 and strip House Index features. Sign-in only, empty library, service worker, fonts, CSP, test stub and harness runner. | Owner can sign in on a phone; offline shell loads; CSP and viewport tests pass |
| M1 | **Songs.** Tables + RLS (v0.1 SQL), `chords.js`, `chordpro.js`, library, song view, editor, paste import (ChordPro + chords-over-lyrics), delete with full Undo, backup script | 20 real sheets pasted in and readable at 360 px; round-trip corpus passes |
| M2 | **Transpose, capo, diagrams.** Toggle, key picker, capo suggestions, SVG diagrams, "Save in this key" + Undo, display preferences | Every song transposes through 12 keys and back unchanged; diagrams for all built-in chords |
| M3 | **Performance mode + set lists.** Wake lock, auto-scroll, pedal keys, two-column landscape, set lists with per-gig key, offline set list, send set list | A full set plays through offline with a pedal on a tablet |
| M4 | **AI import.** `import-sheet` (messy text, photos with note, link), caps, logging, chord net, review-before-save | A first paid check passes; import costs logged |
| M5 | **AI writing and coach.** `write-song` (ideas → full, rework), `song-coach` with `get_song`, revisions table | Paid check passes; rework never overwrites without Undo |
| M6 | **Sharing + polish.** Song shares, `my_people()`, send a song, guide sheet, dark and stage themes, Nashville numbers | Bandmate account sees "Shared by …" and can copy |

After M3 the app is fully useful without AI. M4 and M5 add AI on top.

---

## 14. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| D1 | Name | Pick before M0 (repo name, page title, manifest) |
| D2 | Same Supabase project as House Index, or a new one? | **New project** (free plan allows two). Separate keys, separate data, nothing House Index does can break Chord Book. One login across both apps isn't worth the coupling |
| D3 | Public repo (free GitHub Pages) or private (Pages needs a paid plan)? | Public, like House Index. Nothing private lives in the repo |
| D4 | Instruments | Guitar, standard tuning first; alternate tunings and ukulele later |
| D5 | AI daily caps | Defaults in section 7.1; adjust after a month of the spend query |
| D6 | Bandmate sharing in v1? | In M6, after the solo app is solid |
| D7 | Import from chord websites by link? | Paste-first. Fetch links only where robots.txt allows; never scrape sites that forbid it |
