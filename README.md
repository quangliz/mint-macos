# mint-macos

A macOS-style desktop for **Linux Mint Cinnamon**: a slim top bar, a Control
Center, a Notification Center with calendar, a dock and Spotlight-style search,
all installed with one script.

Tested on Linux Mint 22.3 with Cinnamon 6.6 (X11).

## Install

```bash
git clone git@github.com:quangliz/mint-macos.git ~/mint-macos
cd ~/mint-macos
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
| Mint menu, then the active app's name in bold and the window title (click: Hide / Close / Quit) | Weather, CPU · RAM · CPU temperature · GPU, the tray, the Control Center with battery %, and the clock |

### Liquid glass
The Control Center and the clock panel are frosted glass: a live, blurred view
of the windows and wallpaper behind them, with glossy panes on top. Cinnamon has
no built-in backdrop blur, so `glass.js` does it with a two-pass GLSL Gaussian
blur over clones of the windows, created only while a panel is open. If the
shader can't run, the panels fall back to the normal theme background.
The glass is dark or light to match the Cinnamon theme, and switches live
when you flip the Dark Mode tile.

### Weather
The current condition and temperature in the top bar. Click it for a glass
panel with feels-like, humidity and wind, a 12-hour strip and a 7-day forecast
with range bars. Data comes from [Open-Meteo](https://open-meteo.com) (free, no
account); the location is the one Night Light already detected, and the place
name comes from your timezone. Both can be set in the applet's settings.

### Control Center (the two-switches icon)
- Tiles: Wi-Fi, Bluetooth, Night Light, Do Not Disturb, Dark Mode, Power Mode
- Now Playing card for any MPRIS player (Spotify, browsers, VLC…) with album art and controls
- Brightness, volume and microphone sliders (click the icon to mute); a keyboard backlight slider on laptops that have one
- Wi-Fi network list and Bluetooth devices with connect switches
- Alert rows for pending updates and system reports, with an orange dot on the icon
- Battery %, plus automatic Power Saver on battery (restores your mode when plugged in)
- Phone tile and section when KDE Connect is installed (see below)
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
- Several notifications from one app collapse into a stack ("+2"); click to expand, with **Show less** and a per-app clear button
- **Up Next** card above the calendar with your next events this week
- No badge next to the clock (like macOS)

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
| Super+Shift+S, Shift+PrtSc | Screenshot of an area |
| PrtSc | Screenshot of the whole screen |
| Alt+PrtSc | Screenshot of the active window |
| Space (in Files) | Quick Look preview |

Screenshots work like on Windows: the image is copied to the clipboard and saved
to `~/Pictures/Screenshots`, and a notification offers **Open** and **Show in
folder**. Window buttons sit on the left in macOS order (close, minimize, maximize).

## Optional: NVIDIA GPU off until you need CUDA

On many NVIDIA laptops (especially with AMD CPUs) the NVIDIA driver can't power
the GPU off, so it idles at 3–4 W all the time. `gpu/` keeps the driver unloaded
at boot, which lets Linux cut power to the GPU slot completely, and loads it
only when you want CUDA (PyTorch, model training, `nvidia-smi`):

```bash
sudo ./gpu/install.sh      # once, then reboot
gpu status                 # Driver: not loaded · Power: powered off
gpu on                     # load the driver for CUDA work
gpu off                    # unload it; the GPU powers off again
```

The device monitor menu also has a **Turn GPU on for CUDA / Turn GPU off**
item. Only the compute parts of the driver are loaded, so running graphical
apps on the NVIDIA GPU ("Run with NVIDIA") isn't available in this setup.
Undo with `sudo ./gpu/uninstall.sh` and a reboot.

## Optional: macOS look (WhiteSur)

```bash
./theme/install.sh          # WhiteSur theme, icons, cursor, Inter font, lock screen clock
sudo ./login/install.sh     # login screen: blurred wallpaper, WhiteSur, Inter
```

`theme/install.sh` downloads [WhiteSur](https://github.com/vinceliuice/WhiteSur-gtk-theme)
(theme, icons and cursors) from its author's GitHub, builds it into `~/.themes`
and `~/.local/share/icons`, and switches Cinnamon, apps and window borders to
it, with the Inter font. The lock screen gets a large fixed clock above a
macOS-style date. The Dark Mode tile switches WhiteSur light/dark (theme and
icons together). Undo with `./theme/uninstall.sh` and `sudo ./login/uninstall.sh`.

## Optional: phone integration (KDE Connect)

```bash
./phone/install.sh
```

Installs KDE Connect and opens its ports if the firewall is on. Install the
KDE Connect app on your phone, then use **Control Center → Phone → Pair a
phone…**. You get your phone's notifications in the Notification Center,
clipboard sync, **Send files…**, **Ring phone** and **Browse phone files**.

## Layout of this repo

```
install.sh / uninstall.sh
applets/        Cinnamon applets (copied to ~/.local/share/cinnamon/applets)
  shared/       glass.js, linked into the applets that use it
plank/          Dock theme
ulauncher/      Search theme and the clipboard-history extension
bin/            Clipboard recorder, screenshot tool (snip), shortcut helper
gpu/            Optional: NVIDIA GPU off until needed (gpu on/off)
theme/          Optional: WhiteSur theme, icons, cursor, Inter font, lock screen
login/          Optional: macOS-style login screen (sudo)
phone/          Optional: KDE Connect phone integration
```

## Notes

- If something looks wrong after installing, restart Cinnamon once with **Ctrl+Alt+Esc**.
- The Notification Center's calendar is based on Cinnamon's own calendar applet,
  which is GPL-2.0-or-later, so this project uses the same license (see `LICENSE`).
