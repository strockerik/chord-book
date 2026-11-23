#!/bin/bash
# Weekly launchd backup on this Mac for The Chord Book:
# Runs scripts/backup.py every Sunday at 09:15 (or on next wake).
# Output goes to ~/Library/Logs/chord-book-backup.log.
#
#   bash scripts/launchd/install_backup_job.sh            install or update
#   bash scripts/launchd/install_backup_job.sh --remove   uninstall

LABEL="com.chordbook.backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$HOME/Library/Logs/chord-book-backup.log"
DOMAIN="gui/$(id -u)"

if [ "$1" = "--remove" ]; then
  launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null
  rm -f "$PLIST"
  echo "Removed the weekly Chord Book backup job."
  exit 0
fi
if [ -n "$1" ]; then echo "Usage: bash scripts/launchd/install_backup_job.sh [--remove]"; exit 1; fi

PY="$(command -v python3)"
if [ -z "$PY" ]; then echo "No python3 on your PATH."; exit 1; fi
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>$REPO/scripts/backup.py</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF
launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null
if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then echo "launchctl couldn't load $PLIST"; exit 1; fi
echo "Installed: a weekly Chord Book backup, Sundays 09:15, with $PY."
