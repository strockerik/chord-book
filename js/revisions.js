// What's new (js/revisions.js)
// One entry per release, newest first, in plain words. The first entry must match APP_VERSION
// in js/core.js (testing-skills/melody_test.py checks it). Add a line here with every release.

export const REVISIONS = [
  { version: "0.7.4", date: "2026-11-27", notes: [
    "Melody lookups now send the sheet’s main chords (no lyrics) and check the original recording’s chords against them, so a minor song like Say It Ain’t So isn’t misread as a major key like Ab instead of Cm."
  ] },
  { version: "0.7.3", date: "2026-11-26", notes: [
    "Expanded the guitar chord fingering database with acoustic 2/4 chords, power chords, jazz/extended shapes, and curated slash voicings across every key.",
    "Fixed barre chord fret labels (like “4fr” on C#m and G#m) clipping on the left edge, and added full 5-fret diagram support.",
    "Added a Falsetto top note setting and one-tap John Mayer range preset (G2–G4 standard voice, falsetto up to D5) in My Keys."
  ] },
  { version: "0.7.2", date: "2026-11-26", notes: [
    "Editing the original recording shows the AI’s key in any spelling (Gb appears as F#), and the editor closes when you switch songs.",
    "Fixing a key label recalculates the range from the original whenever it came from the original, including one you entered yourself."
  ] },
  { version: "0.7.1", date: "2026-11-26", notes: [
    "Each song keeps the original recording’s key and notes next to this sheet’s range (More → Singing and tuning), so you can check the AI and fix it.",
    "Melody lookups use the key a recording actually sounds in: a song played half a step down is no longer off by a half step.",
    "A quiet hint when a sheet’s key label doesn’t match its chords, with a one-tap fix that keeps the range right.",
    "Older AI ranges are looked up again to fill in the original; ranges you set are never touched."
  ] },
  { version: "0.7.0", date: "2026-11-25", notes: [
    "Ultimate Guitar links are built straight from the page: every chord exactly where the site puts it, each chorus checked on its own, playing cues like “Palm muted” as notes.",
    "Anything messy (photos, screenshots, phone copies) still goes to the AI, now Claude Sonnet 5.5.",
    "Set list PDFs import more cheaply: the PDF is sent once and reused for each song."
  ] },
  { version: "0.6.6", date: "2026-11-25", notes: [
    "Range first: a song is judged by the notes it needs, not its key. Bad fit lists only songs you rated hard and songs whose notes run past your range.",
    "Suggested keys leave room at both ends of your range (up to a whole step), with the smallest move that does it.",
    "My Keys opens with your vocal range and Bad fit; it looks up missing melody ranges on its own."
  ] },
  { version: "0.6.5", date: "2026-11-25", notes: [
    "My Keys → Bad fit: one tap rewrites a song in the key that suits your voice (or takes the capo off), with Undo.",
    "Rewriting a song you rated hard clears that rating, since it was about the old key.",
    "Imports write out a chorus in full when the source sings it with different words or chords."
  ] },
  { version: "0.6.4", date: "2026-11-25", notes: [
    "Imports keep each chord on the right word when a line repeats a word (“…be, … be, … be”).",
    "A song you mark too high, too low, or 1–2★ always suggests a key, moving the way you said.",
    "A dot on More means a better key for your voice is waiting there."
  ] },
  { version: "0.6.3", date: "2026-11-25", notes: [
    "A House Index account is now required; “Use without signing in” is gone.",
    "With no signal at a gig, the person last signed in on the device still opens their saved songs."
  ] },
  { version: "0.6.2", date: "2026-11-25", notes: [
    "What’s new: tap the version number under You to see every release."
  ] },
  { version: "0.6.1", date: "2026-11-25", notes: [
    "Each song’s melody range also keeps the key of the original recording, shown under More."
  ] },
  { version: "0.6.0", date: "2026-11-24", notes: [
    "Melody range: each song keeps its lowest and highest sung notes. Set them under More, or let the AI look them up.",
    "My Keys shows your vocal range and a Bad fit list with the key that brings every note inside it.",
    "Repeated sections shorten to “Repeat Verse” only when a sheet needs the room.",
    "Phone toolbar fits on one row; capo tips stop at fret 5."
  ] },
  { version: "0.5.9", date: "2026-11-24", notes: ["Hide tabs button beside Capo, and smaller tab."] },
  { version: "0.5.8", date: "2026-11-24", notes: ["Tab runs full width inside two-column sheets; better page breaks; minor keys transpose correctly."] },
  { version: "0.5.7", date: "2026-11-24", notes: ["Full-width tab, an offer to rewrite new songs in your best key, and safer link and PDF imports."] },
  { version: "0.5.6", date: "2026-11-24", notes: ["Written-out repeats shorten on import; no gaps after short words."] },
  { version: "0.5.5", date: "2026-11-24", notes: ["Long lines fit on one page; photo chords placed by column."] },
  { version: "0.5.4", date: "2026-11-24", notes: ["Updates no longer mix old and new files; a fresh reload is offered if the app can’t start."] },
  { version: "0.5.3", date: "2026-11-24", notes: ["Two-column sheets line up in Safari; photos can be turned upright."] },
  { version: "0.5.2", date: "2026-11-24", notes: ["Imported chords land exactly where the source has them."] },
  { version: "0.5.1", date: "2026-11-24", notes: ["Import from links and whole set lists."] },
  { version: "0.5.0", date: "2026-11-24", notes: ["Messy pastes import cleanly; choruses are written out in full."] },
  { version: "0.4.9", date: "2026-11-23", notes: ["Auto-scroll matches each song; guitar tuning setting."] },
  { version: "0.4.8", date: "2026-11-23", notes: ["Every sheet uses the same readable layout and says “Chorus”."] },
  { version: "0.4.5", date: "2026-11-23", notes: ["Second design review; genre filter."] },
  { version: "0.4.4", date: "2026-11-23", notes: ["Empty message bar hidden."] },
  { version: "0.4.3", date: "2026-11-23", notes: ["A dash shows where a chord splits a word."] },
  { version: "0.4.2", date: "2026-11-23", notes: ["Song list and chord sheet scroll separately."] },
  { version: "0.4.1", date: "2026-11-23", notes: ["First release."] }
];
