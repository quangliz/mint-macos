#!/usr/bin/env bash
# Undo login/install.sh. (Themes copied to /usr/share are left in place.)
set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo "$0" "$@"
CONF=/etc/lightdm/slick-greeter.conf
if [[ -f "$CONF.mint-macos.bak" ]]; then mv "$CONF.mint-macos.bak" "$CONF"; else rm -f "$CONF"; fi
rm -rf /usr/share/backgrounds/mint-macos
echo "Login screen restored."
