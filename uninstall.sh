#!/usr/bin/env bash
# Undo install.sh: put back the settings it changed, as saved by the first
# install (or in a backup folder you pass in), and remove the files it added.
# Settings it doesn't touch are left as they are now. If theme/ was
# installed, that is undone too. Packages (plank, ulauncher, gnome-calendar)
# are left installed.
#
#     ./uninstall.sh
#     ./uninstall.sh ~/.local/share/mint-macos-backup/20261004-101500

set -euo pipefail

if [[ $EUID -eq 0 ]]; then
    echo "Run this as your normal user (not with sudo)." >&2
    exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_ROOT="$HOME/.local/share/mint-macos-backup"
BACKUP="${1:-$(cat "$BACKUP_ROOT/LATEST" 2>/dev/null || true)}"
if [[ -z "$BACKUP" || ! -f "$BACKUP/org-cinnamon.dconf" ]]; then
    echo "No backup found. Pass the backup folder: ./uninstall.sh ~/.local/share/mint-macos-backup/<time>" >&2
    exit 1
fi

# Optional macOS look first, so the restore below has the last word on
# Cinnamon's own settings
if [[ -f "$BACKUP_ROOT/look-before-theme.txt" ]]; then
    echo "Undoing the WhiteSur look (theme/install.sh)"
    "$REPO/theme/uninstall.sh"
fi

echo "Restoring settings from $BACKUP"

# Stop our background programs
pkill -f "$HOME/.local/bin/plank-keepalive" 2>/dev/null || true
pkill -x plank 2>/dev/null || true
pkill -f "python3 $HOME/.local/bin/cliphist-daemon.py" 2>/dev/null || true

# Settings: put back only the keys install.sh changes, so anything you've
# changed since (wallpaper, keyboard layouts, your own shortcuts…) stays.
# A key missing from the backup was at its default then, so it's reset.
python3 - "$BACKUP/org-cinnamon.dconf" <<'PY'
import configparser, subprocess, sys
KEYS = {   # section of the /org/cinnamon/ dump -> keys install.sh sets
    "/": ["enabled-applets", "panels-enabled", "panels-height", "panels-autohide", "panel-zone-icon-sizes",
          "panel-zone-symbolic-icon-sizes", "panel-zone-text-sizes", "hotcorner-layout"],
    "desktop/keybindings/wm": ["switch-input-source", "switch-input-source-backward",
                               "switch-to-workspace-down", "switch-to-workspace-up"],
    "desktop/keybindings/media-keys": ["screenshot", "screenshot-clip", "window-screenshot",
                                       "window-screenshot-clip", "area-screenshot", "area-screenshot-clip"],
    "desktop/wm/preferences": ["button-layout"],
}
saved = configparser.RawConfigParser(strict=False)
saved.optionxform = str
saved.read(sys.argv[1])
for section, keys in KEYS.items():
    for key in keys:
        path = "/org/cinnamon/" + ("" if section == "/" else section + "/") + key
        if saved.has_option(section, key):
            subprocess.run(["dconf", "write", path, saved.get(section, key)], check=True)
        else:
            subprocess.run(["dconf", "reset", path], check=True)
PY
if [[ -s "$BACKUP/plank.dconf" ]]; then
    dconf reset -f /net/launchpad/plank/
    dconf load /net/launchpad/plank/ < "$BACKUP/plank.dconf"
fi
if [[ -s "$BACKUP/ibus-triggers.txt" ]]; then
    gsettings set org.freedesktop.ibus.general.hotkey triggers "$(cat "$BACKUP/ibus-triggers.txt")" || true
fi
if [[ -s "$BACKUP/gnome-button-layout.txt" ]]; then
    gsettings set org.gnome.desktop.wm.preferences button-layout "$(cat "$BACKUP/gnome-button-layout.txt")" || true
fi
if [[ -f "$BACKUP/ulauncher-settings.json" ]]; then
    mkdir -p "$HOME/.config/ulauncher"
    cp "$BACKUP/ulauncher-settings.json" "$HOME/.config/ulauncher/settings.json"
fi

# A backup taken on a desktop that already had mint-macos (set up by hand, or
# an older install that saved a new backup on every run) brings our own
# settings back. Reset whatever install.sh sets that is still in place to
# Linux Mint's default; with a clean backup none of this matches.
scrub() {   # schema key value-as-install.sh-sets-it
    if [[ "$(gsettings get "$1" "$2" 2>/dev/null)" == "$3" ]]; then
        gsettings reset "$1" "$2" && echo "    reset $1 $2"
    fi
    return 0
}
if gsettings get org.cinnamon enabled-applets | grep -q "@quang"; then
    echo "    the backup still lists mint-macos applets; going back to Mint's default panel"
    for k in enabled-applets panels-enabled panels-height panels-autohide \
             panel-zone-icon-sizes panel-zone-symbolic-icon-sizes panel-zone-text-sizes; do
        gsettings reset org.cinnamon "$k"
    done
fi
WM=org.cinnamon.desktop.keybindings.wm
scrub $WM switch-input-source "['<Primary>space', 'XF86Keyboard']"
scrub $WM switch-input-source-backward "['<Shift><Primary>space', '<Shift>XF86Keyboard']"
scrub $WM switch-to-workspace-down "['<Control><Alt>Down', '<Control>Up']"
scrub $WM switch-to-workspace-up "['<Control><Alt>Up', '<Alt>F1', '<Control>Down']"
scrub org.cinnamon hotcorner-layout "['expo:false:0', 'scale:false:0', 'scale:true:100', 'desktop:true:100']"
for k in screenshot screenshot-clip window-screenshot window-screenshot-clip area-screenshot area-screenshot-clip; do
    scrub org.cinnamon.desktop.keybindings.media-keys "$k" "@as []"
done
scrub org.cinnamon.desktop.wm.preferences button-layout "'close,minimize,maximize:'"
scrub org.gnome.desktop.wm.preferences button-layout "'close,minimize,maximize:'"
scrub org.freedesktop.ibus.general.hotkey triggers "['<Control>space']"
"$REPO/bin/set-shortcut" --remove "Ulauncher (Spotlight)" "Screenshot: area (snip)" \
    "Screenshot: screen" "Screenshot: window" | sed 's/^/    /' || true

# Autostart entries: put back what existed before, remove what we added.
# One of ours in the backup (same contaminated-backup case) isn't put back:
# it would start programs removed below.
for f in plank.desktop ulauncher.desktop cliphist.desktop; do
    saved="$BACKUP/autostart/$f"
    if [[ -f "$saved" ]] && ! grep -qE "macOS-style dock|Spotlight-style launcher|Records copied text|/\.local/bin/" "$saved"; then
        cp "$saved" "$HOME/.config/autostart/$f"
    else
        rm -f "$HOME/.config/autostart/$f"
    fi
done

# Files we installed, plus the applets' settings, caches and saved state
UUIDS=(appname@quang clockcenter@quang controlcenter@quang devmon@quang weather@quang)
for uuid in "${UUIDS[@]}"; do
    rm -rf "$HOME/.local/share/cinnamon/applets/$uuid" "$HOME/.config/cinnamon/spices/$uuid"
done
rm -rf "$HOME/.cache/controlcenter-art" "$HOME/.local/state/controlcenter"
[[ -n "${XDG_RUNTIME_DIR:-}" ]] && rm -rf "$XDG_RUNTIME_DIR/clockcenter"
rm -rf "$HOME/.local/share/plank/themes/MacStyle"
rm -rf "$HOME/.config/ulauncher/user-themes/mac-dark"
rm -rf "$HOME/.local/share/ulauncher/extensions/com.quang.cliphist"
rm -f "$HOME/.local/bin/cliphist-daemon.py" "$HOME/.local/bin/plank-keepalive" "$HOME/.local/bin/snip"
echo "Clipboard history kept at ~/.local/share/cliphist (delete it if you don't want it)."

# The next install takes a fresh backup; the old folders stay in $BACKUP_ROOT
rm -f "$BACKUP_ROOT/LATEST"

# Restart Ulauncher so it drops the extension and theme
if pgrep -x ulauncher >/dev/null; then
    pkill -x ulauncher || true
    sleep 1
    [[ -f "$HOME/.config/autostart/ulauncher.desktop" ]] && (setsid env GDK_BACKEND=x11 /usr/bin/ulauncher --hide-window >/dev/null 2>&1 &)
fi

# Optional parts that need sudo: list the ones that look installed
extras=()
grep -qs "mint-macos" /etc/lightdm/slick-greeter.conf && extras+=("sudo $REPO/login/uninstall.sh   # login screen")
[[ -x /usr/local/bin/gpu ]] && extras+=("sudo $REPO/gpu/uninstall.sh     # NVIDIA power-off (then reboot)")
dpkg -s kdeconnect >/dev/null 2>&1 && extras+=("$REPO/phone/uninstall.sh          # KDE Connect firewall rules (and the app, if you want)")
if (( ${#extras[@]} )); then
    echo
    echo "Optional parts still installed (these ask for sudo):"
    printf '    %s\n' "${extras[@]}"
fi

echo
echo "Done. Restart Cinnamon (Ctrl+Alt+Esc) to finish."
