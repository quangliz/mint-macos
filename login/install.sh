#!/usr/bin/env bash
# macOS-style login screen (slick-greeter): blurred copy of your wallpaper,
# WhiteSur theme/icons/cursor, Inter font, no dot grid, compact clock.
#
#     sudo ./login/install.sh      (run from your desktop session)
#
# Undo: sudo ./login/uninstall.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo --preserve-env=HOME "$0" "$@"

USER_HOME="${SUDO_USER:+$(getent passwd "$SUDO_USER" | cut -d: -f6)}"
USER_HOME="${USER_HOME:-$HOME}"
CONF=/etc/lightdm/slick-greeter.conf
DEST=/usr/share/backgrounds/mint-macos
mkdir -p "$DEST"

# The greeter runs before login and can't read your home folder, so make a
# blurred, slightly darkened copy of the current wallpaper in a system folder.
uri="$(sudo -u "${SUDO_USER:-$USER}" gsettings get org.cinnamon.desktop.background picture-uri | tr -d "'")"
wall="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.unquote(urllib.parse.urlparse(sys.argv[1]).path))' "$uri")"
if [[ -f "$wall" ]]; then
    python3 - "$wall" "$DEST/login-blur.jpg" <<'PY'
import sys
from PIL import Image, ImageEnhance, ImageFilter
im = Image.open(sys.argv[1]).convert("RGB")
im.thumbnail((2560, 2560))
im = im.filter(ImageFilter.GaussianBlur(radius=max(im.size) / 60))
im = ImageEnhance.Brightness(im).enhance(0.85)
im.save(sys.argv[2], quality=92)
PY
    echo "Blurred wallpaper: $DEST/login-blur.jpg"
else
    echo "Wallpaper not found ($wall); keeping the greeter's default background."
fi

[[ -f "$CONF" && ! -f "$CONF.mint-macos.bak" ]] && cp "$CONF" "$CONF.mint-macos.bak"
theme=WhiteSur-Dark;  [[ -d "$USER_HOME/.themes/$theme" || -d /usr/share/themes/$theme ]] || theme=Mint-Y-Dark-Aqua
icons=WhiteSur-dark;  [[ -d "$USER_HOME/.local/share/icons/$icons" || -d /usr/share/icons/$icons ]] || icons=Mint-Y-Aqua
cursor=WhiteSur-cursors; [[ -d "$USER_HOME/.local/share/icons/$cursor" || -d /usr/share/icons/$cursor ]] || cursor=Bibata-Modern-Classic
font="Inter 11"; fc-list | grep -qi "Inter" || font="Ubuntu 11"

# The greeter only sees system-wide themes; copy ours over if they live in $HOME
for pair in "themes/$theme:$USER_HOME/.themes/$theme" "icons/$icons:$USER_HOME/.local/share/icons/$icons" \
            "icons/$cursor:$USER_HOME/.local/share/icons/$cursor"; do
    dst="/usr/share/${pair%%:*}"; src="${pair#*:}"
    [[ -d "$src" && ! -d "$dst" ]] && cp -r "$src" "$dst" && echo "Copied $(basename "$src") to $dst"
done

cat > "$CONF" <<CONF
# mint-macos: macOS-style login screen (undo: sudo ./login/uninstall.sh)
[Greeter]
background=$DEST/login-blur.jpg
draw-user-backgrounds=false
draw-grid=false
show-hostname=false
theme-name=$theme
icon-theme-name=$icons
cursor-theme-name=$cursor
font-name=$font
clock-format=%a %-d %b  %H:%M
CONF
echo "Wrote $CONF"
echo "Log out (or use Switch User) to see it; the lock screen is separate."
