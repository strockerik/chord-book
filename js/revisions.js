// What's new (js/revisions.js)
// One entry per release, newest first, in plain words. The first entry must match APP_VERSION
// in js/core.js (testing-skills/melody_test.py checks it). Add a line here with every release.

export const REVISIONS = [
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
