#!/usr/bin/env bash
# Undo phone/install.sh: close the firewall ports it opened. KDE Connect
# itself stays installed unless you pass --remove-app (you may have had it
# before). Pair settings live in ~/.config/kdeconnect.
#
#     ./phone/uninstall.sh [--remove-app]
set -euo pipefail
[[ $EUID -ne 0 ]] || { echo "Run as your normal user (it asks for sudo itself)." >&2; exit 1; }

if systemctl is-active --quiet ufw && sudo ufw status | grep -q "1714:1764"; then
    sudo ufw delete allow 1714:1764/udp >/dev/null || true
    sudo ufw delete allow 1714:1764/tcp >/dev/null || true
    echo "Firewall: closed ports 1714-1764"
fi
if [[ "${1:-}" == "--remove-app" ]]; then
    pkill -f kdeconnectd 2>/dev/null || true
    sudo apt-get remove -y kdeconnect
fi
echo "Done. The Phone tile disappears once KDE Connect is removed."
