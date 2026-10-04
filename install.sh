#!/usr/bin/env bash
# mint-macos — macOS-style desktop for Linux Mint Cinnamon.
#
# Run as your normal user from inside your desktop session:
#     ./install.sh               # full install (asks for sudo only to install packages)
#     ./install.sh --no-packages # skip apt; use what is already installed
#
# Everything you had before is saved to ~/.local/share/mint-macos-backup/<time>/
# and ./uninstall.sh puts it back.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_PACKAGES=1
for arg in "$@"; do
    case "$arg" in
        --no-packages) INSTALL_PACKAGES=0 ;;
        -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

APPLETS_DIR="$HOME/.local/share/cinnamon/applets"
SPICES_DIR="$HOME/.config/cinnamon/spices"
AUTOSTART="$HOME/.config/autostart"
BACKUP="$HOME/.local/share/mint-macos-backup/$(date +%Y%m%d-%H%M%S)"
UUIDS=(appname@quang clockcenter@quang controlcenter@quang devmon@quang)

step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m    ! %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- checks
if [[ $EUID -eq 0 ]]; then
    echo "Run this as your normal user (not with sudo). It asks for sudo itself when needed." >&2
    exit 1
fi
if [[ "${XDG_CURRENT_DESKTOP:-}" != *Cinnamon* ]]; then
    echo "This needs a Cinnamon desktop session (found: ${XDG_CURRENT_DESKTOP:-none})." >&2
    exit 1
fi
# (not "list-schemas | grep -q": grep quitting early fails the pipe under pipefail)
if ! gsettings get org.cinnamon enabled-applets >/dev/null 2>&1; then
    echo "Cinnamon settings not found; is this Linux Mint Cinnamon?" >&2
    exit 1
fi

# ---------------------------------------------------------------- backup
step "Backing up your current settings to $BACKUP"
mkdir -p "$BACKUP"
dconf dump /org/cinnamon/ > "$BACKUP/org-cinnamon.dconf"
dconf dump /net/launchpad/plank/ > "$BACKUP/plank.dconf" 2>/dev/null || true
gsettings get org.freedesktop.ibus.general.hotkey triggers > "$BACKUP/ibus-triggers.txt" 2>/dev/null || true
[[ -f "$HOME/.config/ulauncher/settings.json" ]] && cp "$HOME/.config/ulauncher/settings.json" "$BACKUP/ulauncher-settings.json"
mkdir -p "$BACKUP/autostart"
for f in plank.desktop ulauncher.desktop cliphist.desktop; do
    [[ -f "$AUTOSTART/$f" ]] && cp "$AUTOSTART/$f" "$BACKUP/autostart/"
done
echo "$BACKUP" > "$HOME/.local/share/mint-macos-backup/LATEST"
note "done"

# ---------------------------------------------------------------- packages
if [[ $INSTALL_PACKAGES -eq 1 ]]; then
    step "Installing packages (sudo)"
    need=()
    have plank || need+=(plank)
    have gnome-calendar || need+=(gnome-calendar)
    if ! have ulauncher; then
        note "adding the official Ulauncher PPA (ppa:agornostal/ulauncher)"
        sudo add-apt-repository -y ppa:agornostal/ulauncher
        need+=(ulauncher)
    fi
    if (( ${#need[@]} )); then
        sudo apt-get update
        sudo apt-get install -y "${need[@]}"
    else
        note "plank, ulauncher and gnome-calendar are already installed"
    fi
else
    step "Skipping packages (--no-packages)"
fi
for cmd in plank ulauncher; do
    have "$cmd" || warn "$cmd is not installed; that part will not work until it is"
done

# ---------------------------------------------------------------- applets
step "Installing Cinnamon applets"
mkdir -p "$APPLETS_DIR"
for uuid in "${UUIDS[@]}"; do
    rm -rf "${APPLETS_DIR:?}/$uuid"
    cp -r "$REPO/applets/$uuid" "$APPLETS_DIR/"
    note "$uuid"
done

# ---------------------------------------------------------------- panel layout
step "Setting up the macOS-style top bar"
# One 28px top bar. Applet ids for our own applets are fixed; stock ones keep
# the ids Mint ships with so their settings files are reused.
gsettings set org.cinnamon panels-enabled "['1:0:top']"
gsettings set org.cinnamon panels-height "['1:28']"
gsettings set org.cinnamon panels-autohide "['1:false']"
gsettings set org.cinnamon panel-zone-icon-sizes '[{"panelId": 1, "left": 0, "center": 0, "right": 18}]'
gsettings set org.cinnamon panel-zone-symbolic-icon-sizes '[{"panelId": 1, "left": 16, "center": 16, "right": 16}]'
gsettings set org.cinnamon panel-zone-text-sizes '[{"panelId": 1, "left": 0.0, "center": 0.0, "right": 0.0}]'
gsettings set org.cinnamon enabled-applets "[
  'panel1:left:0:menu@cinnamon.org:0',
  'panel1:left:1:appname@quang:17',
  'panel1:right:0:devmon@quang:15',
  'panel1:right:1:systray@cinnamon.org:3',
  'panel1:right:2:xapp-status@cinnamon.org:4',
  'panel1:right:3:removable-drives@cinnamon.org:7',
  'panel1:right:4:printers@cinnamon.org:6',
  'panel1:right:5:keyboard@cinnamon.org:8',
  'panel1:right:6:favorites@cinnamon.org:9',
  'panel1:right:8:controlcenter@quang:16',
  'panel1:right:20:clockcenter@quang:18'
]"
note "Mint menu + app name on the left; monitor, tray, Control Center and clock on the right"

# If our applets were already running (re-install), reload them so new code is used.
for uuid in "${UUIDS[@]}"; do
    dbus-send --session --dest=org.Cinnamon.LookingGlass --type=method_call \
        /org/Cinnamon/LookingGlass org.Cinnamon.LookingGlass.ReloadExtension \
        string:"$uuid" string:APPLET >/dev/null 2>&1 || true
done

# ---------------------------------------------------------------- dock (Plank)
if have plank; then
    step "Setting up the Plank dock"
    mkdir -p "$HOME/.local/share/plank/themes"
    rm -rf "$HOME/.local/share/plank/themes/MacStyle"
    cp -r "$REPO/plank/themes/MacStyle" "$HOME/.local/share/plank/themes/"

    # Pin the apps that exist on this machine (a copy in ~/.local wins over /usr)
    launchers="$HOME/.config/plank/dock1/launchers"
    mkdir -p "$launchers"
    items=()
    for app in nemo firefox org.gnome.Terminal com.anthropic.Claude; do
        for dir in "$HOME/.local/share/applications" /usr/share/applications; do
            if [[ -f "$dir/$app.desktop" ]]; then
                printf '[PlankDockItemPreferences]\nLauncher=file://%s/%s.desktop\n' "$dir" "$app" > "$launchers/$app.dockitem"
                items+=("'$app.dockitem'")
                break
            fi
        done
    done
    P=/net/launchpad/plank/docks/dock1/
    dconf write ${P}dock-items "[$(IFS=,; echo "${items[*]}")]"
    dconf write ${P}theme "'MacStyle'"
    dconf write ${P}position "'bottom'"
    dconf write ${P}alignment "'center'"
    dconf write ${P}icon-size 48
    dconf write ${P}zoom-enabled true
    dconf write ${P}zoom-percent 160
    dconf write ${P}hide-mode "'none'"
    dconf write ${P}show-dock-item false
    dconf write ${P}tooltips-enabled true
    # Plank 0.11 can crash on internal assertions; this wrapper restarts it
    mkdir -p "$HOME/.local/bin"
    install -m 755 "$REPO/bin/plank-keepalive" "$HOME/.local/bin/plank-keepalive"
    mkdir -p "$AUTOSTART"
    cat > "$AUTOSTART/plank.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Plank
Comment=macOS-style dock (restarted automatically if it crashes)
Exec=$HOME/.local/bin/plank-keepalive
Icon=plank
X-GNOME-Autostart-enabled=true
EOF
    note "dock with ${#items[@]} pinned apps, zoom on hover"
fi

# ---------------------------------------------------------------- Ulauncher + clipboard
if have ulauncher; then
    step "Setting up Spotlight-style search (Ulauncher) and clipboard history"
    mkdir -p "$HOME/.config/ulauncher/user-themes" "$HOME/.local/share/ulauncher/extensions" "$HOME/.local/bin"
    rm -rf "$HOME/.config/ulauncher/user-themes/mac-dark" "$HOME/.local/share/ulauncher/extensions/com.quang.cliphist"
    cp -r "$REPO/ulauncher/user-themes/mac-dark" "$HOME/.config/ulauncher/user-themes/"
    cp -r "$REPO/ulauncher/extensions/com.quang.cliphist" "$HOME/.local/share/ulauncher/extensions/"
    install -m 755 "$REPO/bin/cliphist-daemon.py" "$HOME/.local/bin/cliphist-daemon.py"
    mkdir -p "$HOME/.local/share/cliphist" && chmod 700 "$HOME/.local/share/cliphist"

    # Ulauncher's own hotkey can't see Super in Cinnamon, so Super+Space is a
    # Cinnamon shortcut (below) and Ulauncher's is parked on an unused combo.
    python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.config/ulauncher/settings.json")
try:
    s = json.load(open(p))
except (OSError, ValueError):
    s = {}
s.update({"hotkey-show-app": "<Primary><Shift><Super>F12", "theme-name": "mac-dark",
          "show-indicator-icon": False, "render-on-screen": "mouse-pointer-monitor"})
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump(s, open(p, "w"), indent=4)
PY
    mkdir -p "$AUTOSTART"
    cat > "$AUTOSTART/ulauncher.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Ulauncher
Comment=Spotlight-style launcher (Super+Space)
Exec=env GDK_BACKEND=x11 /usr/bin/ulauncher --hide-window
Icon=ulauncher
X-GNOME-Autostart-enabled=true
EOF
    cat > "$AUTOSTART/cliphist.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Clipboard History
Comment=Records copied text for Ulauncher (type "cb")
Exec=python3 $HOME/.local/bin/cliphist-daemon.py
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
    note "Super+Space opens search; type 'cb' for clipboard history"
fi

# ---------------------------------------------------------------- shortcuts & hot corners
step "Keyboard shortcuts and hot corners"
# Keyboard layout / input method: Ctrl+Space (frees Super+Space for search)
gsettings set org.cinnamon.desktop.keybindings.wm switch-input-source "['<Primary>space', 'XF86Keyboard']"
gsettings set org.cinnamon.desktop.keybindings.wm switch-input-source-backward "['<Shift><Primary>space', '<Shift>XF86Keyboard']"
gsettings set org.freedesktop.ibus.general.hotkey triggers "['<Control>space']" 2>/dev/null || true
# Mission Control: Ctrl+Up = all windows (Scale), Ctrl+Down = all workspaces (Expo)
gsettings set org.cinnamon.desktop.keybindings.wm switch-to-workspace-down "['<Control><Alt>Down', '<Control>Up']"
gsettings set org.cinnamon.desktop.keybindings.wm switch-to-workspace-up "['<Control><Alt>Up', '<Alt>F1', '<Control>Down']"
# Hot corners: bottom-left = Mission Control, bottom-right = Show Desktop
gsettings set org.cinnamon hotcorner-layout "['expo:false:0', 'scale:false:0', 'scale:true:100', 'desktop:true:100']"

# Super+Space -> ulauncher-toggle, as a Cinnamon custom shortcut (reuse ours if present)
python3 - <<'PY'
import ast, subprocess
def get(schema, key):
    return ast.literal_eval(subprocess.check_output(["gsettings", "get", schema, key], text=True).strip().replace("@as ", ""))
base = "/org/cinnamon/desktop/keybindings/custom-keybindings/"
names = get("org.cinnamon.desktop.keybindings", "custom-list")
mine = None
for n in names:
    cmd = subprocess.run(["dconf", "read", base + n + "/command"], capture_output=True, text=True).stdout.strip()
    if cmd == "'ulauncher-toggle'":
        mine = n
if mine is None:
    i = 0
    while f"custom{i}" in names:
        i += 1
    mine = f"custom{i}"
    names.append(mine)
subprocess.run(["dconf", "write", base + mine + "/name", "'Ulauncher (Spotlight)'"], check=True)
subprocess.run(["dconf", "write", base + mine + "/command", "'ulauncher-toggle'"], check=True)
subprocess.run(["dconf", "write", base + mine + "/binding", "['<Super>space']"], check=True)
subprocess.run(["gsettings", "set", "org.cinnamon.desktop.keybindings", "custom-list", str(names)], check=True)
PY
note "Super+Space search · Ctrl+Space keyboard · Ctrl+Up/Down Mission Control · bottom corners"

# ---------------------------------------------------------------- start things now
step "Starting the dock, search and clipboard recorder"
# Stop the wrapper first, or it would restart the Plank we are about to kill
pkill -f "$HOME/.local/bin/plank-keepalive" 2>/dev/null || true
pkill -x plank 2>/dev/null || true
sleep 1
have plank && (setsid "$HOME/.local/bin/plank-keepalive" >/dev/null 2>&1 &)
if have ulauncher; then
    pgrep -x ulauncher >/dev/null && pkill -x ulauncher || true
    sleep 1
    (setsid env GDK_BACKEND=x11 /usr/bin/ulauncher --hide-window >/dev/null 2>&1 &)
    pgrep -f "python3 $HOME/.local/bin/cliphist-daemon.py" >/dev/null || \
        (setsid python3 "$HOME/.local/bin/cliphist-daemon.py" >/dev/null 2>&1 &)
fi

# Smaller Mint menu icon for the slim top bar (file exists once the menu has loaded)
sleep 2
menu_cfg="$SPICES_DIR/menu@cinnamon.org/0.json"
if [[ -f "$menu_cfg" ]]; then
    python3 - "$menu_cfg" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
if "menu-icon-size" in d:
    d["menu-icon-size"]["value"] = 18
    json.dump(d, open(p, "w"), indent=4)
PY
fi

step "Done"
cat <<EOF
    Top bar: Mint menu · app name · CPU/RAM/temp/GPU · Control Center (battery %) · clock
    Click the clock for notifications + calendar; the two-switches icon for Control Center.
    Super+Space: search   ·   'cb' in search: clipboard history
    Undo everything:  $REPO/uninstall.sh
    Your previous settings: $BACKUP

    If something looks off, restart Cinnamon once with Ctrl+Alt+Esc.
EOF
