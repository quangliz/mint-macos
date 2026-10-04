# mint-macos

A macOS-style desktop for **Linux Mint Cinnamon**: a slim top bar, a Control
Center, a Notification Center with calendar, a dock and Spotlight-style search,
all installed with one script.

Tested on Linux Mint 22.3 with Cinnamon 6.6 (X11).

## Install

```bash
git clone git@github.com:quangliz/cinnamon-macos.git ~/cinnamon-macos
cd ~/cinnamon-macos
./install.sh
```

Run it as your normal user in your desktop session. It asks for `sudo` only to
install `plank`, `ulauncher` (from its official PPA) and `gnome-calendar`, and
only if they're missing. Use `./install.sh --no-packages` to skip that step.

Before changing anything, it saves your current settings to
`~/.local/share/mint-macos-backup/<time>/`. Running it again is safe; it
updates everything in place.

## Undo

```bash
./uninstall.sh
```

This restores the settings from the most recent backup, removes the applets,
themes and autostart entries, and leaves the packages installed. Restart
Cinnamon afterwards with **Ctrl+Alt+Esc**.

## What you get

### Top bar
| Left | Right |
|---|---|
| Mint menu, then the active app's name in bold (click: Hide / Close / Quit) | CPU · RAM · CPU temperature · GPU, the tray, the Control Center with battery %, and the clock |

### Liquid glass
The Control Center and the clock panel are frosted glass: a live, blurred view
of the windows and wallpaper behind them, with glossy panes on top. Cinnamon has
no built-in backdrop blur, so `glass.js` does it with a two-pass GLSL Gaussian
blur over clones of the windows, created only while a panel is open. If the
shader can't run, the panels fall back to the normal theme background.
The glass is dark or light to match the Cinnamon theme, and switches live
when you flip the Dark Mode tile.

### Control Center (the two-switches icon)
- Tiles: Wi-Fi, Bluetooth, Night Light, Do Not Disturb, Dark Mode, Power Mode
- Now Playing card for any MPRIS player (Spotify, browsers, VLC…) with album art and controls
- Brightness, volume and microphone sliders (click the icon to mute); a keyboard backlight slider on laptops that have one
- Wi-Fi network list and Bluetooth devices with connect switches
- Alert rows for pending updates and system reports, with an orange dot on the icon
- Battery %, plus automatic Power Saver on battery (restores your mode when plugged in)
- Lock, Suspend, Log out, Power off, Settings

It also hides tray icons it replaces (Blueman, Update Manager, System Reports).

### Device monitor
CPU per core, memory, swap, temperatures, network, disk, battery, and an NVIDIA
section with CUDA version, VRAM, power, running CUDA processes and the PRIME GPU
mode (shown only when `nvidia-smi` is available). It never wakes a sleeping GPU.

### Clock & Notification Center (click the clock)
- Notifications as rounded cards (app icon, title, message, relative time); click to open the app, hover for ✕, **Clear All**
- Calendar card; click a day to see its events, with **Open Calendar** for GNOME Calendar
- Shortcuts: **Super+N** to open, **Shift+Super+C** to clear all

### Dock
Plank at the bottom with zoom on hover, running-app dots and a rounded dark
theme. Right-click an icon → **Keep in Dock** to pin it.

### Search and clipboard history
- **Super+Space** opens Ulauncher (Spotlight-style theme): apps, calculator (`12*7`), files (`~/`)
- Type **`cb`** in search to see recently copied text; Enter copies it again.
  The recorder keeps the last 100 text clips in `~/.local/share/cliphist/`
  (private to your user) and skips passwords that password managers mark as secret.

### Shortcuts and hot corners
| | |
|---|---|
| Super+Space | Search |
| Ctrl+Space / Shift+Ctrl+Space | Switch keyboard layout / input method |
| Ctrl+↑ | Mission Control (all windows) |
| Ctrl+↓ | All workspaces |
| Bottom-left corner | Mission Control |
| Bottom-right corner | Show Desktop |

## Layout of this repo

```
install.sh / uninstall.sh
applets/        Cinnamon applets (copied to ~/.local/share/cinnamon/applets)
plank/          Dock theme
ulauncher/      Search theme and the clipboard-history extension
bin/            Clipboard recorder (runs at login)
```

## Notes

- If something looks wrong after installing, restart Cinnamon once with **Ctrl+Alt+Esc**.
- The Notification Center's calendar is based on Cinnamon's own calendar applet,
  which is GPL-2.0-or-later, so this project uses the same license (see `LICENSE`).
