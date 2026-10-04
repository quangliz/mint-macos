#!/usr/bin/env bash
# Undo theme/install.sh: restore the look saved before it ran.
# (WhiteSur files stay in ~/.themes and ~/.local/share/icons; delete them if you like.)
set -euo pipefail
SAVE="$HOME/.local/share/mint-macos-backup/look-before-theme.txt"
[[ -f "$SAVE" ]] || { echo "Nothing to restore ($SAVE not found)." >&2; exit 1; }
while read -r schema key value; do
    gsettings set "$schema" "$key" "$value" || echo "could not restore $schema $key"
done < "$SAVE"
rm -f "$SAVE"
echo "Previous look restored."
