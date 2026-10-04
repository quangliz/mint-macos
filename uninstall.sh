#!/usr/bin/env bash
# Undo install.sh: restore the settings saved by the most recent install
# (or a backup folder you pass in) and remove the files it added.
# Packages (plank, ulauncher, gnome-calendar) are left installed.
#
#     ./uninstall.sh
#     ./uninstall.sh ~/.local/share/mint-macos-backup/20261004-101500

set -euo pipefail

if [[ $EUID -eq 0 ]]; then
    echo "Run this as your normal user (not with sudo)." >&2
    exit 1
fi

BACKUP="${1:-$(cat "$HOME/.local/share/mint-macos-backup/LATEST" 2>/dev/null || true)}"
if [[ -z "$BACKUP" || ! -f "$BACKUP/org-cinnamon.dconf" ]]; then
    echo "No backup found. Pass the backup folder: ./uninstall.sh ~/.local/share/mint-macos-backup/<time>" >&2
    exit 1
fi
echo "Restoring settings from $BACKUP"

# Stop our background programs
pkill -f "$HOME/.local/bin/plank-keepalive" 2>/dev/null || true
pkill -x plank 2>/dev/null || true
pkill -f "python3 $HOME/.local/bin/cliphist-daemon.py" 2>/dev/null || true

# Settings
# Reset first: a dump only lists non-default keys, so loading alone would
# leave anything that was at its default before the install still changed.
dconf reset -f /org/cinnamon/
dconf load /org/cinnamon/ < "$BACKUP/org-cinnamon.dconf"
if [[ -s "$BACKUP/plank.dconf" ]]; then
    dconf reset -f /net/launchpad/plank/
    dconf load /net/launchpad/plank/ < "$BACKUP/plank.dconf"
fi
if [[ -s "$BACKUP/ibus-triggers.txt" ]]; then
    gsettings set org.freedesktop.ibus.general.hotkey triggers "$(cat "$BACKUP/ibus-triggers.txt")" || true
fi
if [[ -f "$BACKUP/ulauncher-settings.json" ]]; then
    cp "$BACKUP/ulauncher-settings.json" "$HOME/.config/ulauncher/settings.json"
fi

# Autostart entries: put back what existed before, remove what we added
for f in plank.desktop ulauncher.desktop cliphist.desktop; do
    if [[ -f "$BACKUP/autostart/$f" ]]; then
        cp "$BACKUP/autostart/$f" "$HOME/.config/autostart/$f"
    else
        rm -f "$HOME/.config/autostart/$f"
    fi
done

# Files we installed
rm -rf "$HOME/.local/share/cinnamon/applets/"{appname,clockcenter,controlcenter,devmon,weather}@quang
rm -rf "$HOME/.local/share/plank/themes/MacStyle"
rm -rf "$HOME/.config/ulauncher/user-themes/mac-dark"
rm -rf "$HOME/.local/share/ulauncher/extensions/com.quang.cliphist"
rm -f "$HOME/.local/bin/cliphist-daemon.py" "$HOME/.local/bin/plank-keepalive"
echo "Clipboard history kept at ~/.local/share/cliphist (delete it if you don't want it)."

# Restart Ulauncher so it drops the extension and theme
if pgrep -x ulauncher >/dev/null; then
    pkill -x ulauncher || true
    sleep 1
    [[ -f "$HOME/.config/autostart/ulauncher.desktop" ]] && (setsid env GDK_BACKEND=x11 /usr/bin/ulauncher --hide-window >/dev/null 2>&1 &)
fi

echo "Done. Restart Cinnamon (Ctrl+Alt+Esc) to finish."
