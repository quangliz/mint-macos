#!/usr/bin/env bash
# Optional: phone integration through KDE Connect (notifications, clipboard
# sync, sending files, ring/find phone). The Control Center shows a Phone tile
# once it is installed. Then install the KDE Connect app on your phone and use
# Control Center -> Phone -> Pair a phone…
#
#     ./phone/install.sh       (asks for sudo)
set -euo pipefail
[[ $EUID -ne 0 ]] || { echo "Run as your normal user (it asks for sudo itself)." >&2; exit 1; }

dpkg -s kdeconnect >/dev/null 2>&1 || sudo apt-get install -y kdeconnect

# KDE Connect talks on ports 1714-1764; open them only if the firewall is on
if systemctl is-active --quiet ufw && sudo ufw status | grep -q "Status: active"; then
    sudo ufw allow 1714:1764/udp >/dev/null
    sudo ufw allow 1714:1764/tcp >/dev/null
    echo "Firewall: opened ports 1714-1764 for KDE Connect"
fi

# start the background service now (it starts at login from then on)
daemon="$(dpkg -L kdeconnect | grep -m1 '/kdeconnectd$' || true)"
[[ -n "$daemon" ]] && ! pgrep -f kdeconnectd >/dev/null && (setsid "$daemon" >/dev/null 2>&1 &)
echo "Done. Install the KDE Connect app on your phone, then pair it from the Control Center."
