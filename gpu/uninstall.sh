#!/usr/bin/env bash
# Undo gpu/install.sh: the NVIDIA driver loads at boot again (normal on-demand mode).
set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo "$0" "$@"
rm -f /etc/modprobe.d/nvidia-cuda-on-demand.conf /etc/udev/rules.d/80-nvidia-unbound-pm.rules /usr/local/bin/gpu
update-initramfs -u
echo "Done. Reboot to load the NVIDIA driver at boot again."
