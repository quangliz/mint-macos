#!/usr/bin/env bash
# Optional, for NVIDIA laptops used for CUDA work: keep the NVIDIA GPU fully
# powered off at boot and turn it on only when needed with "gpu on".
#
#     sudo ./gpu/install.sh     then reboot
#
# Undo with: sudo ./gpu/uninstall.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || exec sudo "$0" "$@"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Installing the 'gpu' command to /usr/local/bin"
install -m 755 "$HERE/gpu" /usr/local/bin/gpu

echo "==> Not loading the NVIDIA driver at boot"
cat > /etc/modprobe.d/nvidia-cuda-on-demand.conf <<'CONF'
# mint-macos gpu: the NVIDIA driver is not loaded automatically, so the GPU
# stays powered off. "gpu on" loads the compute parts for CUDA.
blacklist nvidia
blacklist nvidia_uvm
blacklist nvidia_modeset
blacklist nvidia_drm
# The display parts are never needed for CUDA; loading them would let the
# desktop hold the GPU and stop "gpu off" from unloading it.
install nvidia_drm /bin/true
install nvidia_modeset /bin/true
CONF

echo "==> Letting the GPU power down while no driver is loaded"
cat > /etc/udev/rules.d/80-nvidia-unbound-pm.rules <<'RULES'
# mint-macos gpu: allow runtime power management of the NVIDIA GPU even with
# no driver bound, so its PCIe slot can be powered off (D3cold).
ACTION=="add", SUBSYSTEM=="pci", ATTR{vendor}=="0x10de", ATTR{class}=="0x03[0-9]*", ATTR{power/control}="auto"
RULES

if command -v prime-select >/dev/null && [[ "$(prime-select query)" == "intel" ]]; then
    echo "==> Switching PRIME from 'intel' to 'on-demand' (this setup replaces it)"
    prime-select on-demand
fi

echo "==> Rebuilding the boot image (takes a minute)"
update-initramfs -u

echo
echo "Done. Reboot, then run:  gpu status   (expect: Driver not loaded, Power powered off)"
echo "For CUDA work:  gpu on      When finished:  gpu off"
