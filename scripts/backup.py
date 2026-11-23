#!/usr/bin/env python3
"""Backup and restore script for The Chord Book (`cb_songs`, `cb_setlists`, `cb_setlist_items`, `cb_song_shares`).
Reads Project URL and Secret Key (`sb_secret_...`) from `notes.md` (same pattern as House Index).
Keeps the newest 8 backups in `backups/chord-book-YYYY-MM-DD.json`.
"""

import argparse
import datetime
import json
import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
NOTES = ROOT / "notes.md"
BACKUPS_DIR = ROOT / "backups"
TABLES = ["cb_songs", "cb_setlists", "cb_setlist_items", "cb_song_shares"]


def read_credentials():
    source = NOTES
    if not source.exists():
        # Fall back to Strock-Recipes/notes.md if present in parent Apps directory
        sibling_notes = ROOT.parent / "Strock-Recipes" / "notes.md"
        if sibling_notes.exists():
            source = sibling_notes
        else:
            sys.exit("Missing notes.md with Project URL and Secret Key.")
    text = source.read_text(encoding="utf-8")
    url_m = re.search(r"https://[a-z0-9]+\.supabase\.co", text)
    key_m = re.search(r"sb_secret_[A-Za-z0-9_-]+", text)
    if not url_m or not key_m:
        sys.exit("Could not find Supabase URL or sb_secret_... key in notes.md")
    return url_m.group(0), key_m.group(0)


def fetch_table(base_url, secret_key, table):
    req = urllib.request.Request(
        f"{base_url}/rest/v1/{table}?select=*",
        headers={
            "apikey": secret_key,
            "Authorization": f"Bearer {secret_key}",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def upsert_table(base_url, secret_key, table, rows):
    if not rows:
        return
    data = json.dumps(rows).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url}/rest/v1/{table}",
        data=data,
        method="POST",
        headers={
            "apikey": secret_key,
            "Authorization": f"Bearer {secret_key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()


def run_backup():
    base_url, secret_key = read_credentials()
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.date.today().isoformat()
    out_file = BACKUPS_DIR / f"chord-book-{today}.json"

    payload = {"backed_up_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "tables": {}}
    for t in TABLES:
        try:
            rows = fetch_table(base_url, secret_key, t)
            payload["tables"][t] = rows
            print(f"  {t}: {len(rows)} rows")
        except Exception as e:
            print(f"  {t}: skipped ({e})")
            payload["tables"][t] = []

    out_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Saved backup to {out_file}")

    # Prune older backups, keeping newest 8
    all_backups = sorted(BACKUPS_DIR.glob("chord-book-*.json"))
    for old in all_backups[:-8]:
        old.unlink()
        print(f"Pruned old backup {old.name}")


def run_restore(backup_path: pathlib.Path):
    base_url, secret_key = read_credentials()
    payload = json.loads(backup_path.read_text(encoding="utf-8"))
    tables = payload.get("tables", {})
    for t in TABLES:
        rows = tables.get(t, [])
        if rows:
            upsert_table(base_url, secret_key, t, rows)
            print(f"Restored {len(rows)} rows to {t}")


def main():
    parser = argparse.ArgumentParser(description="Backup or restore Chord Book tables from Supabase.")
    parser.add_argument("--restore", type=pathlib.Path, help="Path to backup JSON file to restore")
    args = parser.parse_args()
    if args.restore:
        run_restore(args.restore)
    else:
        run_backup()


if __name__ == "__main__":
    main()
