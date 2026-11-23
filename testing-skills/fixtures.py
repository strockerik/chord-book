"""Made-up songs for the headless tests, so no real lyrics live in this public repo."""

import json

PREFS = {
    "columns": "auto",
    "compact_chorus": False,
    "show_diagrams": False,
    "font_offset": 0,
    "accidental_pref": "auto",
}


def song(song_id, title, key, capo, tempo, time_signature, notes, sidebar_notes, chordpro):
    return {
        "id": song_id,
        "title": title,
        "artist": "The Porch Lights",
        "key": key,
        "capo": capo,
        "preferred_transpose": 0,
        "tempo": tempo,
        "time_signature": time_signature,
        "tuning": "E A D G B E",
        "tags": ["test", "acoustic"],
        "source": "Test fixture",
        "notes": notes,
        "is_favorite": True,
        "vocal_rating": 5,
        "vocal_comfort": "sweet_spot",
        "layout_prefs": {**PREFS, "page_mode": "1-sheet", "sidebar_notes": sidebar_notes},
        "created_at": "2026-11-21T16:00:00Z",
        "updated_at": "2026-11-21T16:00:00Z",
        "chordpro": chordpro,
    }


FIXTURE_SONGS = [
    song(
        "test-morning-river", "Morning River", "E", 0, 68, "3/8",
        "Form: V1 • Turn • V2 • CH • V3",
        {"sec-0": {"text": "Light waltz pulse", "kind": "cue"}, "sec-3": {"text": "Play the chorus twice", "kind": "dynamic"}},
        """{title: Morning River}
{artist: The Porch Lights}
{key: E}
{tempo: 68}
{time: 3/8}

{start_of_verse: Verse 1}
[E]Morning on the river, [G#m]mist upon the [A]water [B]slow
[E]Herons in the shallows
Where the [A]quiet currents [B]go
[F#m]Carry me down [C#m]to the bend where the [B]willows [E]grow
{end_of_verse}

{start_of_instrumental: Turnaround}
[E]   [E]   [F#m]   [C#m]   [A]
{end_of_instrumental}

{start_of_verse: Verse 2}
[E]Noon across the meadow, [G#m]swallows on the [A]summer [B]air
[E]Clover by the fences
And the [A]sun is every[B]where
[F#m]Carry me on [C#m]to the hill where the [B]road runs [E]bare
{end_of_verse}

{start_of_chorus: Chorus (2x)}
[E]Roll on, roll on, river [F#m]wide
[C#m]Take me to the other [A]side
[E]Every bend and every [F#m]stone
[C#m]Leads the weary [A]traveler [E]home
{end_of_chorus}

{start_of_verse: Verse 3}
[E]Evening on the river, [G#m]lanterns in the [A]window [B]glow
[E]Supper on the table
And the [A]fire burning [B]low
[F#m]Carry me home [C#m]to the place that I [B]used to [E]know
{end_of_verse}""",
    ),
    song(
        "test-harvest-table", "Harvest Table", "G", 0, 78, "4/4",
        "Chorus-first structure. Return to Chorus after each verse.",
        {"sec-0": {"text": "Steady pulse", "kind": "cue"}, "sec-1": {"text": "Sing at the top", "kind": "dynamic"}},
        """{title: Harvest Table}
{artist: The Porch Lights}
{key: G}
{tempo: 78}
{time: 4/4}

{start_of_intro: Intro}
[G]   [D]   [G]   [D]
{end_of_intro}

{start_of_chorus: Chorus}
[G]Pull a [Em]chair up to the [C]harvest [G]table [D/F#]
[Em]Pass the [D]bread [C]and fill the [Am]cups [D]again
[G]Everyone is [Em]welcome at the [C]harvest [G]table [D/F#]
[Em]Stay a [D]while [C]and call me [D]friend [G]
{end_of_chorus}

{start_of_verse: Verse 1}
[G]Apples in the [C]orchard [Em]falling
[C]Pumpkins on the [D]garden [Em]wall
[G]Neighbors down the [C]lane are [Em]calling
[C]Come and [D]gather, [Em]one and [D/F#]all
{end_of_verse}

{start_of_verse: Verse 2}
[G]Candles on the [C]window [Em]burning
[C]Boots beside the [D]kitchen [Em]door
[G]Children from the [C]fields re[Em]turning
[C]Always [D]room for [Em]just one [D/F#]more
{end_of_verse}

{start_of_verse: Verse 3}
[G]Stories by the [C]fire [Em]told
[C]Laughter down the [D]hallway [Em]rings
[G]Blankets for the [C]coming [Em]cold
[C]Thankful [D]for the [Em]simple [D/F#]things
{end_of_verse}""",
    ),
    song(
        "test-lantern-waltz", "Lantern Waltz", "C", 1, 112, "3/4",
        "C shapes with capo 1.",
        {"sec-0": {"text": "C shapes, capo 1", "kind": "key"}, "sec-1": {"text": "Warm and full", "kind": "dynamic"}},
        """{title: Lantern Waltz}
{artist: The Porch Lights}
{key: C}
{capo: 1}
{tempo: 112}
{time: 3/4}

{start_of_verse: Verse 1}
Light up the [C]lantern, [F]open the [C]door
Dance with me [Am]slowly a[D]cross the wood [G]floor
Fiddle is [C]playing, [F]stars are a[C]bove
Turn with the [Dm]music, [G]turn with my [C]love
{end_of_verse}

{start_of_chorus: Refrain}
One, two, three [C]turning, [F]round we [C]go
Candles are [Am]burning [D]soft and [G]low
One, two, three [C]turning, [F]round we [C]go
Home with the [Dm]lantern [G]all aglow [C]
{end_of_chorus}

{start_of_verse: Verse 2}
Snow on the [C]rooftop, [F]wind at the [C]pane
Hold me until the [Am]morning [D]comes a[G]gain
Fiddle is [C]fading, [F]embers are [C]red
Quiet the [Dm]lantern, [G]a[C]way to bed
{end_of_verse}""",
    ),
    song(
        "test-wildflower-road", "Wildflower Road", "G", 2, 76, "4/4",
        "All throughout the song you can play Cadd9 for C",
        {
            "sec-0": {"text": "Play Cadd9 for C throughout", "kind": "cue"},
            "sec-1": {"text": "Start quiet", "kind": "dynamic"},
            "sec-2": {"text": "Build slowly", "kind": "dynamic"},
            "sec-3": {"text": "Full open strum", "kind": "cue"},
        },
        """{title: Wildflower Road}
{artist: The Porch Lights}
{key: G}
{capo: 2}
{tempo: 76}
{time: 4/4}

{start_of_intro: Intro}
[C]   [G]   [C]   [G]
{end_of_intro}

{start_of_verse: Verse 1}
[G]Light the [G/B]way for [C]night, [G]Mary.
Walk the long dirt [C]road [Dsus4]back [D]home. [G]
Bring your old tin [D/E]cup and [Em]spoon,
Now [D]sing a[C]long,
And [Am7]wait [G/B]for the [Dsus4]morning. [D]
{end_of_verse}

{start_of_verse: Verse 2}
[G]Light the [G/B]lamp for [C]dawn, [G/B]Mary.
Walk the long pine [C]trail [Dsus4]back [D]home. [G]
Fold the quilt down [D/E]low to[Em7]night,
Now [D]all I [C]know,
Is [Am7]this old [G/B]porch and [Dsus4]evening! [D] [D/F#]
{end_of_verse}

{start_of_chorus: Chorus}
[G]Wildflower [D/F#]road,
[Am7]Winding [G/B]through the [C]hills.
[D]Hold me close [D/C]with [G/B]summer [C]rain,
We [Am7]ride [G/B]until [D]dawn! [D/F#]
[G]High and rolling [D/F#]on,
[Am7]River, [G/B]take me [C]home.
The [D]lantern of [D/C]harbor [G/B]lighthou[C]se (light[D]house)
{end_of_chorus}""",
    ),
]

FIXTURE_SONGS[3]["layout_prefs"]["genre"] = "country"

FIXTURE_SETLISTS = [{
    "id": "test-set-1",
    "name": "Test Set",
    "event_date": None,
    "notes": "",
    "offline": True,
    "created_at": "2026-11-21T10:00:00Z",
}]

FIXTURE_SETLIST_ITEMS = [
    {
        "id": f"test-item-{index}",
        "setlist_id": "test-set-1",
        "song_id": fixture["id"],
        "position": index,
        "transpose": 0,
        "capo": fixture["capo"],
        "notes": "",
    }
    for index, fixture in enumerate(FIXTURE_SONGS, 1)
]

UGLY_PASTE = (
    "Tuning: [E A D G B E](https://example.com/tuner)Capo:\n"
    "Wildflower Road - The Porch Lights (All throughout the song you can play Cadd9 for C) "
    "[Intro] C G C G "
    "[Verse] G G/B C G Light the way for night, Mary. C Dsus4 D G Walk the long dirt road back home. "
    "D/E Em Bring your old tin cup and spoon, D C Now sing along, Am7 G/B Dsus4 D And wait for morning. "
    "[Verse] G G/B C G/B Light the lamp for dawn, Mary. C Dsus4 D G Walk the long pine trail back home. "
    "D/E Em7 Fold the quilt down low tonight, D C Now all I know, Am7 G/B Dsus4 D D/F# Is this old porch and evening! "
    "[Chorus] G D/F# Wildflower road, Am7 G/B C Winding through the hills. D D/C G/B C Hold me close with summer rain, "
    "Am7 G/B D D/F# We ride until dawn! G D/F# High and rolling on, Am7 G/B C River, take me home. "
    "Am G/B C Wildflower road, Am G/B Dsus4 Wildflower road. Am G/B C Wildflower road, Am G/B D Wildflower road."
)


def fixture_boot_script():
    """JavaScript that stores the fixtures for the local book, then loads the app in the test iframe."""
    data = {
        "songs": FIXTURE_SONGS,
        "setlists": FIXTURE_SETLISTS,
        "setlist_items": FIXTURE_SETLIST_ITEMS,
        "use_local_book": True,
    }
    return (
        f"const __fixtures = {json.dumps(data, ensure_ascii=False)};\n"
        "localStorage.clear();\n"
        "for (const [key, value] of Object.entries(__fixtures)) {\n"
        "  localStorage.setItem(`cb:local:${key}`, JSON.stringify(value));\n"
        "}\n"
        f"const UGLY_PASTE = {json.dumps(UGLY_PASTE)};\n"
        'document.getElementById("app-frame").src = "/index.html";\n'
    )
