#!/usr/bin/env bash
# Optional: macOS look — WhiteSur theme (apps, top bar, window borders), WhiteSur
# icons and cursor, the Inter font, and a macOS-style lock screen clock.
#
#     ./theme/install.sh            (asks for sudo once, for the build tools and font)
#     ./theme/install.sh --light    start in light mode (default: dark)
#
# WhiteSur is downloaded from its author's GitHub (vinceliuice) into
# ~/.cache/mint-macos and installed into ~/.themes and ~/.local/share/icons.
# Your previous look is saved; undo with ./theme/uninstall.sh
set -euo pipefail
[[ $EUID -ne 0 ]] || { echo "Run as your normal user (it asks for sudo itself)." >&2; exit 1; }

MODE=Dark; [[ "${1:-}" == "--light" ]] && MODE=Light
CACHE="$HOME/.cache/mint-macos"
SAVE="$HOME/.local/share/mint-macos-backup/look-before-theme.txt"
mode=$(echo "$MODE" | tr 'A-Z' 'a-z')

step() { printf '\n\033[1;36m==>\033[0m \033[1m%s\033[0m\n' "$*"; }

step "Installing build tools and the Inter font (sudo)"
need=()
for pkg in sassc libglib2.0-dev-bin libxml2-utils fonts-inter git; do
    dpkg -s "$pkg" >/dev/null 2>&1 || need+=("$pkg")
done
(( ${#need[@]} )) && sudo apt-get install -y "${need[@]}" || echo "    already installed"

step "Downloading WhiteSur"
mkdir -p "$CACHE"
for repo in WhiteSur-gtk-theme WhiteSur-icon-theme WhiteSur-cursors; do
    if [[ -d "$CACHE/$repo/.git" ]]; then git -C "$CACHE/$repo" pull -q --ff-only || true
    else git clone -q --depth 1 "https://github.com/vinceliuice/$repo.git" "$CACHE/$repo"; fi
    echo "    $repo $(git -C "$CACHE/$repo" log -1 --format='%h %cs')"
done

step "Building and installing (takes a minute)"
# The theme installer needs a terminal type for its progress animation
(cd "$CACHE/WhiteSur-gtk-theme" && TERM="${TERM:-xterm-256color}" ./install.sh -c light -c dark >/dev/null)
(cd "$CACHE/WhiteSur-icon-theme" && ./install.sh >/dev/null)
(cd "$CACHE/WhiteSur-cursors" && ./install.sh >/dev/null)
ls -d "$HOME/.themes/WhiteSur-$MODE" >/dev/null

step "Saving your current look to $SAVE"
mkdir -p "$(dirname "$SAVE")"
if [[ ! -f "$SAVE" ]]; then
    {
        for k in gtk-theme icon-theme cursor-theme font-name; do echo "org.cinnamon.desktop.interface $k $(gsettings get org.cinnamon.desktop.interface $k)"; done
        echo "org.cinnamon.theme name $(gsettings get org.cinnamon.theme name)"
        echo "org.cinnamon.desktop.wm.preferences theme $(gsettings get org.cinnamon.desktop.wm.preferences theme)"
        echo "org.cinnamon.desktop.wm.preferences titlebar-font $(gsettings get org.cinnamon.desktop.wm.preferences titlebar-font)"
        echo "org.gnome.desktop.interface font-name $(gsettings get org.gnome.desktop.interface font-name)"
        echo "org.nemo.desktop font $(gsettings get org.nemo.desktop font)"
        gsettings get org.x.apps.portal color-scheme >/dev/null 2>&1 &&
            echo "org.x.apps.portal color-scheme $(gsettings get org.x.apps.portal color-scheme)"
        for k in floating-widgets use-custom-format time-format date-format font-time font-date font-message; do
            echo "org.cinnamon.desktop.screensaver $k $(gsettings get org.cinnamon.desktop.screensaver $k)"
        done
    } > "$SAVE"
fi

step "Applying"
gsettings set org.cinnamon.desktop.interface gtk-theme "WhiteSur-$MODE"
gsettings set org.cinnamon.desktop.wm.preferences theme "WhiteSur-$MODE"
gsettings set org.cinnamon.theme name "WhiteSur-$MODE"
gsettings set org.cinnamon.desktop.interface icon-theme "WhiteSur-$mode"
gsettings set org.cinnamon.desktop.interface cursor-theme 'WhiteSur-cursors'
gsettings set org.cinnamon.desktop.interface font-name 'Inter 10'
gsettings set org.gnome.desktop.interface font-name 'Inter 10'
gsettings set org.cinnamon.desktop.wm.preferences titlebar-font 'Inter Semi-Bold 10'
gsettings set org.nemo.desktop font 'Inter 10'
scheme=$([[ $MODE == Dark ]] && echo prefer-dark || echo prefer-light)
gsettings set org.x.apps.portal color-scheme "$scheme" 2>/dev/null || true

# Lock screen: large fixed clock above a macOS-style date
S=org.cinnamon.desktop.screensaver
gsettings set $S floating-widgets false
gsettings set $S use-custom-format true
gsettings set $S time-format '%H:%M'
gsettings set $S date-format '%A, %-d %B'
gsettings set $S font-time 'Inter Display Semi-Bold 96'
gsettings set $S font-date 'Inter Medium 20'
gsettings set $S font-message 'Inter 14'

echo
echo "Done. The Dark Mode tile in the Control Center switches WhiteSur light/dark."
echo "Login screen too:  sudo ./login/install.sh"
