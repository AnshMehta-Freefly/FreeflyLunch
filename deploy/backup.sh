#!/usr/bin/env bash
#
# Back up Freefly Lunch session data to LOCAL timestamped snapshots.
#
# Each run tarballs data/ into $BACKUP_DIR, but only when something actually
# changed since the last snapshot, and prunes to the newest $KEEP snapshots.
#
# Session JSON contains secret tokens, so $BACKUP_DIR stays off the LAN and out
# of git. Default is ~/freefly-lunch-backups (outside the repo, survives a
# re-clone). To get off-machine safety, point BACKUP_DIR at a mounted drive or a
# synced cloud folder, e.g.:
#   BACKUP_DIR="$HOME/Dropbox/freefly-lunch-backups" deploy/backup.sh

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$REPO/data"
BACKUP_DIR="${BACKUP_DIR:-$HOME/freefly-lunch-backups}"
KEEP="${KEEP:-48}"

# Nothing to back up if there's no data yet.
[ -d "$DATA_DIR" ] || exit 0

mkdir -p "$BACKUP_DIR"

# Fingerprint the current data so we skip making identical snapshots.
hash="$(find "$DATA_DIR" -type f -name '*.json' -exec sha256sum {} + 2>/dev/null \
        | sort | sha256sum | cut -d' ' -f1)"
last_file="$BACKUP_DIR/.last-hash"
[ -f "$last_file" ] && [ "$hash" = "$(cat "$last_file")" ] && exit 0

stamp="$(date '+%Y%m%d-%H%M%S')"
tar -czf "$BACKUP_DIR/sessions-$stamp.tar.gz" -C "$REPO" data
echo "$hash" > "$last_file"

# Keep only the newest $KEEP snapshots.
ls -1t "$BACKUP_DIR"/sessions-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
