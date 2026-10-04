const Applet = imports.ui.applet;
const Glass = require('./glass');
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const Interfaces = imports.misc.interfaces;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Cvc = imports.gi.Cvc;
const Mainloop = imports.mainloop;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const XApp = imports.gi.XApp;

// Tray icons we fold into the Control Center as alert rows (macOS keeps
// these in System Settings rather than the menu bar).
const ALERT_APPS = {
    "mintupdate.py": { icon: "software-update-available-symbolic", cmd: "mintupdate" },
    "mintreport":    { icon: "dialog-warning-symbolic",            cmd: "mintreport" },
};

const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";
const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
  </interface>
</node>`);
const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
  <interface name="org.freedesktop.UPower">
    <property name="OnBattery" type="b" access="read"/>
  </interface>
</node>`);
const MprisAppProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="Identity" type="s" access="read"/>
  </interface>
</node>`);

const ACCENT = "#1f9ede";  // Mint-Y-Aqua accent, shared with the theme sliders and the clock panel

// Run a command asynchronously; callback(ok, stdout)
function run(argv, callback) {
    try {
        let proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        proc.communicate_utf8_async(null, null, (p, res) => {
            let ok = false, out = "";
            try {
                let [, stdout] = p.communicate_utf8_finish(res);
                out = stdout || "";
                ok = p.get_successful();
            } catch (e) {}
            if (callback) callback(ok, out);
        });
    } catch (e) {
        if (callback) callback(false, "");
    }
}

function themeExists(name) {
    for (let dir of [GLib.get_home_dir() + "/.themes", GLib.get_home_dir() + "/.local/share/themes", "/usr/share/themes"])
        if (GLib.file_test(`${dir}/${name}`, GLib.FileTest.IS_DIR)) return true;
    return false;
}

// Split a `nmcli -t` line on unescaped colons
function nmSplit(line) {
    let out = [], cur = "";
    for (let i = 0; i < line.length; i++) {
        if (line[i] === "\\" && i + 1 < line.length) { cur += line[++i]; continue; }
        if (line[i] === ":") { out.push(cur); cur = ""; continue; }
        cur += line[i];
    }
    out.push(cur);
    return out;
}

// A macOS-style toggle tile: round icon + title + subtitle
class Tile {
    constructor(iconName, title, onClick) {
        this.actor = new St.Button({ reactive: true, can_focus: true, track_hover: true, x_expand: true });
        // Left-align tile contents so icons line up in a column
        let box = new St.BoxLayout({ vertical: false, style: "spacing: 10px;", x_expand: true,
                                     x_align: imports.gi.Clutter.ActorAlign.FILL });
        this.iconBin = new St.Bin({ style: "border-radius: 99px; padding: 7px;" });
        this.icon = new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: 16 });
        this.iconBin.set_child(this.icon);
        let labels = new St.BoxLayout({ vertical: true, y_align: imports.gi.Clutter.ActorAlign.CENTER });
        this.title = new St.Label({ text: title, style: "font-weight: bold;" });
        this.sub = new St.Label({ text: "", style: "font-size: 8.5pt; opacity: 0.75;" });
        labels.add_child(this.title);
        labels.add_child(this.sub);
        box.add_child(this.iconBin);
        box.add_child(labels);
        this.actor.set_child(box);
        this.actor.x_fill = true;
        this.actor.connect("clicked", onClick);
        this.actor.connect("notify::hover", () => this._style());
        this.active = false;
        this._style();
    }

    set(active, subtitle, iconName) {
        this.active = active;
        if (subtitle !== undefined) this.sub.text = subtitle;
        if (iconName) this.icon.icon_name = iconName;
        this._style();
    }

    _style() {
        let bg = this.actor.hover ? "rgba(255,255,255,0.17)" : "rgba(255,255,255,0.10)";
        this.actor.style = `background-color: ${bg}; border: 1px solid rgba(255,255,255,0.10); border-radius: 16px; padding: 8px 10px; width: 150px;`;
        this.iconBin.style = "border-radius: 99px; padding: 7px; " +
            (this.active ? `background-color: ${ACCENT}; color: white;` : "background-color: rgba(255,255,255,0.14);");
    }
}

class ControlCenter extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.set_applet_icon_symbolic_path(metadata.path + "/icon-symbolic.svg");
        this.set_applet_tooltip("Control Center");
        this._alertDot = new St.Label({ text: "●", visible: false, y_align: Clutter.ActorAlign.CENTER,
                                        style: "color: #ff9f0a; font-size: 8pt; padding: 0 3px 0 4px;" });
        // The label sits inside its own bin; put the dot just before that bin
        let labelBin = this._applet_label.get_parent();
        this.actor.insert_child_below(this._alertDot, labelBin.get_parent() === this.actor ? labelBin : null);
        this._updatePanelBattery();
        this._watchPowerSource();
        this._batteryTimer = Mainloop.timeout_add_seconds(30, () => { this._updatePanelBattery(); return true; });

        // We provide Bluetooth controls, so tell Cinnamon to hide Blueman's
        // tray icon (same mechanism the stock network/sound applets use).
        this.uuid = metadata.uuid;
        imports.ui.main.systrayManager.registerTrayIconReplacement("blueman", this.uuid);
        for (let role in ALERT_APPS) imports.ui.main.systrayManager.registerTrayIconReplacement(role, this.uuid);

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        // Frosted glass sheet behind the content; falls back to the theme if unavailable
        this._glass = new Glass.GlassBackdrop(this.menu, { radius: 20 });
        if (this._glass.active)
            this.menu.box.style = "background-color: rgba(26,26,32,0.38); border: 1px solid rgba(255,255,255,0.14);" +
                                  " border-radius: 20px; padding: 10px 6px;";

        this.nightSettings = new Gio.Settings({ schema_id: "org.cinnamon.settings-daemon.plugins.color" });
        this.notifSettings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.notifications" });
        this.ifaceSettings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" });
        this.cinnThemeSettings = new Gio.Settings({ schema_id: "org.cinnamon.theme" });
        let src = Gio.SettingsSchemaSource.get_default();
        this.portalSettings = src.lookup("org.x.apps.portal", true) ? new Gio.Settings({ schema_id: "org.x.apps.portal" }) : null;
        this.gnomeIface = src.lookup("org.gnome.desktop.interface", true) ? new Gio.Settings({ schema_id: "org.gnome.desktop.interface" }) : null;

        this._buildTiles();
        this._buildMedia();
        this._buildSliders();
        this._buildLists();
        this._buildFooter();

        this.signals = [
            [this.nightSettings, this.nightSettings.connect("changed::night-light-enabled", () => this._refreshNight())],
            [this.notifSettings, this.notifSettings.connect("changed::display-notifications", () => this._refreshDnd())],
            [this.ifaceSettings, this.ifaceSettings.connect("changed::gtk-theme", () => this._refreshDark())],
        ];

        this.menu.connect("open-state-changed", (m, open) => { if (open) this._refreshAll(); });
        this._refreshAll();
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        if (this._glass) this._glass.destroy();
        imports.ui.main.systrayManager.unregisterTrayIconReplacement(this.uuid);
        if (this._batteryTimer) Mainloop.source_remove(this._batteryTimer);
        if (this._upower && this._upowerId) this._upower.disconnect(this._upowerId);
        if (this._statusMonitor) {
            for (let id of this._monitorIds) this._statusMonitor.disconnect(id);
            for (let name of Array.from(this._alerts.keys())) this._untrackAlert(name);
            this._statusMonitor = null;
        }
        for (let [obj, id] of this.signals) obj.disconnect(id);
        if (this._mixer) this._mixer.close();
        if (this._nameWatchId) Gio.DBus.session.signal_unsubscribe(this._nameWatchId);
        for (let name of Array.from(this.players.keys())) this._removePlayer(name);
    }

    // ---------- Now Playing (MPRIS) ----------
    _buildMedia() {
        this.players = new Map();   // bus name -> { player, app, lastActive, propId }

        let card = new St.BoxLayout({ vertical: false, x_expand: true,
            style: "background-color: rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.10); border-radius: 16px; padding: 10px; spacing: 12px;" });
        this.mediaArt = new St.Bin({ style: "width: 52px; height: 52px; border-radius: 8px; background-color: rgba(128,128,128,0.3);" });
        card.add_child(this.mediaArt);

        let text = new St.BoxLayout({ vertical: true, x_expand: true, reactive: true, track_hover: true,
                                      y_align: Clutter.ActorAlign.CENTER });
        this.mediaTitle = new St.Label({ style: "font-weight: bold;" });
        this.mediaArtist = new St.Label({ style: "font-size: 9pt; opacity: 0.7;" });
        for (let l of [this.mediaTitle, this.mediaArtist]) {
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            text.add_child(l);
        }
        // Clicking the track brings the player window forward
        text.connect("button-release-event", () => {
            let p = this._currentPlayer();
            if (p && p.app) { p.app.RaiseRemote(() => {}); this.menu.close(); }
            return Clutter.EVENT_STOP;
        });
        card.add_child(text);

        let controls = new St.BoxLayout({ vertical: false, style: "spacing: 2px;", y_align: Clutter.ActorAlign.CENTER });
        let mkBtn = (icon, action) => {
            let b = new St.Button({ reactive: true, track_hover: true,
                child: new St.Icon({ icon_name: icon, icon_type: St.IconType.SYMBOLIC, icon_size: 18 }) });
            let style = () => b.style = "padding: 6px; border-radius: 99px;" +
                (b.hover ? " background-color: rgba(128,128,128,0.3);" : "");
            b.connect("notify::hover", style);
            style();
            b.connect("clicked", () => { let p = this._currentPlayer(); if (p && p.player) action(p.player); });
            controls.add_child(b);
            return b;
        };
        this.mediaPrev = mkBtn("media-skip-backward-symbolic", pl => pl.PreviousRemote(() => {}));
        this.mediaPlay = mkBtn("media-playback-start-symbolic", pl => pl.PlayPauseRemote(() => {}));
        this.mediaNext = mkBtn("media-skip-forward-symbolic", pl => pl.NextRemote(() => {}));
        card.add_child(controls);

        this.mediaItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false, hover: false });
        this.mediaItem.addActor(card, { span: -1, expand: true });
        this.menu.addMenuItem(this.mediaItem);
        this.mediaItem.actor.hide();

        // Track players appearing and disappearing on the session bus
        this._nameWatchId = Gio.DBus.session.signal_subscribe("org.freedesktop.DBus", "org.freedesktop.DBus",
            "NameOwnerChanged", "/org/freedesktop/DBus", null, Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                let [name, oldOwner, newOwner] = params.deep_unpack();
                if (!name.startsWith(MPRIS_PREFIX)) return;
                if (newOwner) this._addPlayer(name); else this._removePlayer(name);
            });
        Gio.DBus.session.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ListNames",
            null, null, Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    let [names] = conn.call_finish(res).deep_unpack();
                    names.filter(n => n.startsWith(MPRIS_PREFIX)).forEach(n => this._addPlayer(n));
                } catch (e) {}
            });
    }

    _addPlayer(name) {
        if (this.players.has(name)) return;
        let entry = { lastActive: 0 };
        this.players.set(name, entry);
        entry.app = new MprisAppProxy(Gio.DBus.session, name, MPRIS_PATH, () => {});
        new PlayerProxy(Gio.DBus.session, name, MPRIS_PATH, (proxy, error) => {
            if (error || this.players.get(name) !== entry) return;
            entry.player = proxy;
            let touch = () => { if (proxy.PlaybackStatus === "Playing") entry.lastActive = Date.now(); };
            touch();
            entry.propId = proxy.connect("g-properties-changed", () => { touch(); this._updateMedia(); });
            this._updateMedia();
        });
    }

    _removePlayer(name) {
        let entry = this.players.get(name);
        if (!entry) return;
        if (entry.player && entry.propId) entry.player.disconnect(entry.propId);
        this.players.delete(name);
        this._updateMedia();
    }

    // Prefer what is playing now, then whatever played most recently
    _currentPlayer() {
        let best = null;
        for (let e of this.players.values()) {
            if (!e.player) continue;
            let score = (e.player.PlaybackStatus === "Playing" ? 1e15 : 0) + e.lastActive;
            if (!best || score > best.score) best = { e, score };
        }
        return best ? best.e : null;
    }

    _updateMedia() {
        let p = this._currentPlayer();
        let meta = {};
        if (p) {
            let raw = p.player.Metadata || {};
            for (let k in raw) meta[k] = raw[k] instanceof GLib.Variant ? raw[k].deep_unpack() : raw[k];
        }
        let title = meta["xesam:title"];
        if (!p || !title) { this.mediaItem.actor.hide(); return; }
        this.mediaItem.actor.show();

        let artist = meta["xesam:artist"];
        if (Array.isArray(artist)) artist = artist.join(", ");
        this.mediaTitle.text = title;
        this.mediaArtist.text = artist || meta["xesam:album"] || (p.app && p.app.Identity) || "";
        let playing = p.player.PlaybackStatus === "Playing";
        this.mediaPlay.child.icon_name = playing ? "media-playback-pause-symbolic" : "media-playback-start-symbolic";
        this.mediaPrev.opacity = p.player.CanGoPrevious === false ? 90 : 255;
        this.mediaNext.opacity = p.player.CanGoNext === false ? 90 : 255;
        this._setArt(meta["mpris:artUrl"] || "");
    }

    _setArt(url) {
        if (url === this._artUrl) return;
        this._artUrl = url;
        let base = "width: 52px; height: 52px; border-radius: 8px;";
        let fallback = () => {
            this.mediaArt.style = base + " background-color: rgba(128,128,128,0.3);";
            this.mediaArt.set_child(new St.Icon({ icon_name: "audio-x-generic-symbolic", icon_type: St.IconType.SYMBOLIC, icon_size: 24 }));
        };
        let apply = path => {
            if (this._artUrl !== url) return;
            this.mediaArt.set_child(null);
            this.mediaArt.style = base + ` background-image: url("${path}"); background-size: cover;`;
        };
        if (!url) { fallback(); return; }
        if (url.startsWith("file://")) { apply(GLib.filename_from_uri(url)[0]); return; }
        if (!/^https?:\/\//.test(url)) { fallback(); return; }

        // Remote cover art (e.g. Spotify): download once into the cache
        let dir = GLib.build_filenamev([GLib.get_user_cache_dir(), "controlcenter-art"]);
        let path = GLib.build_filenamev([dir, GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1) + ".jpg"]);
        if (GLib.file_test(path, GLib.FileTest.EXISTS)) { apply(path); return; }
        fallback();
        GLib.mkdir_with_parents(dir, 0o755);
        run(["curl", "-sfL", "--max-time", "10", "-o", path, url], ok => { if (ok) apply(path); });
    }

    // ---------- tiles ----------
    _buildTiles() {
        this.wifiTile = new Tile("network-wireless-symbolic", "Wi-Fi", () => this._toggleWifi());
        this.btTile = new Tile("bluetooth-active-symbolic", "Bluetooth", () => this._toggleBt());
        this.nightTile = new Tile("night-light-symbolic", "Night Light", () =>
            this.nightSettings.set_boolean("night-light-enabled", !this.nightSettings.get_boolean("night-light-enabled")));
        this.dndTile = new Tile("notifications-disabled-symbolic", "Do Not Disturb", () =>
            this.notifSettings.set_boolean("display-notifications", !this.notifSettings.get_boolean("display-notifications")));
        this.darkTile = new Tile("weather-clear-night-symbolic", "Dark Mode", () => this._toggleDark());
        this.powerTile = new Tile("power-profile-balanced-symbolic", "Power Mode", () => this._cyclePower());

        let grid = new St.BoxLayout({ vertical: true, style: "spacing: 8px; padding: 4px 0;", x_expand: true });
        let tiles = [this.wifiTile, this.btTile, this.nightTile, this.dndTile, this.darkTile, this.powerTile];
        for (let i = 0; i < tiles.length; i += 2) {
            let row = new St.BoxLayout({ vertical: false, style: "spacing: 8px;", x_expand: true });
            row.add_child(tiles[i].actor);
            if (tiles[i + 1]) row.add_child(tiles[i + 1].actor);
            grid.add_child(row);
        }
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false, hover: false });
        item.addActor(grid, { span: -1, expand: true });
        this.menu.addMenuItem(item);
    }

    _refreshWifi() {
        run(["nmcli", "-t", "-f", "WIFI", "radio"], (ok, out) => {
            let on = out.trim() === "enabled";
            if (!on) { this.wifiTile.set(false, "Off", "network-wireless-disabled-symbolic"); return; }
            run(["nmcli", "-t", "-f", "ACTIVE,SSID,SIGNAL", "dev", "wifi"], (ok2, out2) => {
                let cur = out2.split("\n").map(nmSplit).find(f => f[0] === "yes");
                this.wifiTile.set(true, cur ? cur[1] : "Not connected",
                    cur ? "network-wireless-signal-" + this._signalName(Number(cur[2])) + "-symbolic" : "network-wireless-offline-symbolic");
            });
        });
    }

    _signalName(s) {
        return s >= 80 ? "excellent" : s >= 55 ? "good" : s >= 30 ? "ok" : s > 5 ? "weak" : "none";
    }

    _toggleWifi() {
        let target = this.wifiTile.active ? "off" : "on";
        this.wifiTile.set(!this.wifiTile.active, target === "on" ? "Turning on…" : "Off");
        run(["nmcli", "radio", "wifi", target], () => Mainloop.timeout_add_seconds(target === "on" ? 4 : 1, () => {
            this._refreshWifi(); this._refreshWifiList(); return false;
        }));
    }

    _refreshBt() {
        run(["bluetoothctl", "show"], (ok, out) => {
            let on = /Powered:\s*yes/.test(out);
            if (!ok || !out.trim()) { this.btTile.set(false, "Unavailable", "bluetooth-disabled-symbolic"); return; }
            if (!on) { this.btTile.set(false, "Off", "bluetooth-disabled-symbolic"); return; }
            run(["bluetoothctl", "devices", "Connected"], (ok2, out2) => {
                let names = out2.split("\n").filter(l => l.startsWith("Device ")).map(l => l.split(" ").slice(2).join(" "));
                this.btTile.set(true, names.length ? names.join(", ") : "On", "bluetooth-active-symbolic");
            });
        });
    }

    _toggleBt() {
        let turnOn = !this.btTile.active;
        this.btTile.set(turnOn, turnOn ? "Turning on…" : "Off");
        let cmd = turnOn ? "rfkill unblock bluetooth; sleep 1; bluetoothctl power on" : "bluetoothctl power off";
        run(["sh", "-c", cmd], () => { this._refreshBt(); this._refreshBtList(); });
    }

    _refreshNight() {
        let on = this.nightSettings.get_boolean("night-light-enabled");
        let mode = this.nightSettings.get_string("night-light-schedule-mode");
        this.nightTile.set(on, on ? (mode === "auto" ? "Sunset to sunrise" : mode === "manual" ? "Scheduled" : "On") : "Off",
            on ? "night-light-symbolic" : "night-light-disabled-symbolic");
    }

    _refreshDnd() {
        let dnd = !this.notifSettings.get_boolean("display-notifications");
        this.dndTile.set(dnd, dnd ? "On" : "Off");
    }

    _darkVariant(name, wantDark) {
        if (wantDark) {
            if (/-Dark/.test(name)) return name;
            let m = name.match(/^(Mint-[A-Z])(-.*)?$/);
            return m ? `${m[1]}-Dark${m[2] || ""}` : name + "-dark";
        }
        return name.replace(/-Dark/, "").replace(/-dark$/, "");
    }

    _refreshDark() {
        let dark = /dark/i.test(this.ifaceSettings.get_string("gtk-theme"));
        this.darkTile.set(dark, dark ? "On" : "Off");
    }

    _toggleDark() {
        let wantDark = !this.darkTile.active;
        let gtk = this._darkVariant(this.ifaceSettings.get_string("gtk-theme"), wantDark);
        let cinn = this._darkVariant(this.cinnThemeSettings.get_string("name"), wantDark);
        if (themeExists(gtk)) this.ifaceSettings.set_string("gtk-theme", gtk);
        if (themeExists(cinn)) this.cinnThemeSettings.set_string("name", cinn);
        if (this.portalSettings) this.portalSettings.set_string("color-scheme", wantDark ? "prefer-dark" : "default");
        if (this.gnomeIface) try { this.gnomeIface.set_string("color-scheme", wantDark ? "prefer-dark" : "default"); } catch (e) {}
        this._refreshDark();
    }

    _refreshPower() {
        run(["powerprofilesctl", "get"], (ok, out) => {
            let p = out.trim();
            if (!ok || !p) { this.powerTile.actor.hide(); return; }
            let label = { "power-saver": "Power Saver", "balanced": "Balanced", "performance": "Performance" }[p] || p;
            this.powerTile.set(p !== "balanced", label, `power-profile-${p}-symbolic`);
        });
    }

    _cyclePower() {
        run(["powerprofilesctl", "list"], (ok, out) => {
            let avail = ["power-saver", "balanced", "performance"].filter(p => out.includes(p + ":"));
            run(["powerprofilesctl", "get"], (ok2, cur) => {
                let next = avail[(avail.indexOf(cur.trim()) + 1) % avail.length];
                run(["powerprofilesctl", "set", next], () => this._refreshPower());
            });
        });
    }

    // ---------- sliders ----------
    _makeSlider(iconName, label) {
        let slider = new PopupMenu.PopupSliderMenuItem(0);
        // 30px wide, like the tile icon circles, so icons share one column
        let btn = new St.Button({ reactive: true, style: "padding: 0 0 0 10px; width: 30px;" });
        let icon = new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: 16 });
        btn.set_child(icon);
        slider.removeActor(slider._slider);
        slider.pct = new St.Label({ text: "", style: "min-width: 3.4em; text-align: right; font-size: 9pt;",
                                    y_align: imports.gi.Clutter.ActorAlign.CENTER });
        let box = new St.BoxLayout({ vertical: false, x_expand: true, style: "spacing: 10px;" });
        slider._slider.x_expand = true;
        box.add_child(btn);
        box.add_child(slider._slider);
        box.add_child(slider.pct);
        slider.addActor(box, { span: -1, expand: true });
        slider.icon = icon;
        slider.button = btn;
        return slider;
    }

    _buildSliders() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Display brightness via cinnamon-settings-daemon
        this.bright = this._makeSlider("display-brightness-symbolic");
        this.bright.actor.hide();
        this.menu.addMenuItem(this.bright);
        Interfaces.getDBusProxyAsync("org.cinnamon.SettingsDaemon.Power.Screen", (proxy, error) => {
            if (error) return;
            this.brightProxy = proxy;
            proxy.GetPercentageRemote((b, err) => {
                if (err) return;
                this.bright.actor.show();
                this._setBrightUi(b);
            });
            proxy.connectSignal("Changed", () => { if (!this.brightDragging) this._refreshBright(); });
        });
        this.bright.connect("drag-begin", () => this.brightDragging = true);
        this.bright.connect("drag-end", () => this.brightDragging = false);
        this.bright.connect("value-changed", (s, v) => {
            let pct = Math.max(1, Math.round(v * 100));
            this.bright.pct.text = pct + "%";
            if (this.brightProxy) this.brightProxy.SetPercentageRemote(pct, () => {});
        });

        // Output volume via the PulseAudio/PipeWire mixer
        this.vol = this._makeSlider("audio-volume-high-symbolic");
        this.menu.addMenuItem(this.vol);
        this.vol.button.connect("clicked", () => { if (this._sink) this._sink.change_is_muted(!this._sink.is_muted); });
        this.vol.connect("value-changed", (s, v) => {
            if (!this._sink) return;
            this._sink.volume = v * this._mixer.get_vol_max_norm();
            this._sink.push_volume();
            if (this._sink.is_muted && v > 0) this._sink.change_is_muted(false);
            this._setVolUi();
        });

        // Microphone: the icon is the mute button, the slider sets input level
        this.mic = this._makeSlider("audio-input-microphone-symbolic");
        this.mic.actor.hide();
        this.menu.addMenuItem(this.mic);
        this.mic.button.connect("clicked", () => { if (this._source) this._source.change_is_muted(!this._source.is_muted); });
        this.mic.connect("value-changed", (s, v) => {
            if (!this._source) return;
            this._source.volume = v * this._mixer.get_vol_max_norm();
            this._source.push_volume();
            if (this._source.is_muted && v > 0) this._source.change_is_muted(false);
            this._setMicUi();
        });

        // Keyboard backlight; stays hidden on laptops without one
        this.kbd = this._makeSlider("keyboard-brightness-symbolic");
        this.kbd.actor.hide();
        this.menu.addMenuItem(this.kbd);
        Interfaces.getDBusProxyAsync("org.cinnamon.SettingsDaemon.Power.Keyboard", (proxy, error) => {
            if (error) return;
            proxy.GetPercentageRemote((b, err) => {
                if (err) return;   // "Keyboard backlight control is not supported"
                this.kbdProxy = proxy;
                this.kbd.actor.show();
                this._setKbdUi(b);
            });
            proxy.connectSignal("Changed", () => { if (!this.kbdDragging) this._refreshKbd(); });
        });
        this.kbd.connect("drag-begin", () => this.kbdDragging = true);
        this.kbd.connect("drag-end", () => this.kbdDragging = false);
        this.kbd.connect("value-changed", (s, v) => {
            let pct = Math.round(v * 100);
            this.kbd.pct.text = pct + "%";
            if (this.kbdProxy) this.kbdProxy.SetPercentageRemote(pct, () => {});
        });

        this._mixer = new Cvc.MixerControl({ name: "Control Center" });
        this._mixer.connect("state-changed", () => {
            if (this._mixer.get_state() === Cvc.MixerControlState.READY) { this._bindSink(); this._bindSource(); }
        });
        this._mixer.connect("default-sink-changed", () => this._bindSink());
        this._mixer.connect("default-source-changed", () => this._bindSource());
        this._mixer.open();
    }

    _bindSink() {
        if (this._sink && this._sinkIds) for (let id of this._sinkIds) this._sink.disconnect(id);
        this._sink = this._mixer.get_default_sink();
        if (!this._sink) return;
        this._sinkIds = [
            this._sink.connect("notify::volume", () => this._setVolUi(true)),
            this._sink.connect("notify::is-muted", () => this._setVolUi(true)),
        ];
        this._setVolUi(true);
    }

    _bindSource() {
        if (this._source && this._sourceIds) for (let id of this._sourceIds) this._source.disconnect(id);
        this._source = this._mixer.get_default_source();
        if (!this._source) { this.mic.actor.hide(); return; }
        this.mic.actor.show();
        this._sourceIds = [
            this._source.connect("notify::volume", () => this._setMicUi(true)),
            this._source.connect("notify::is-muted", () => this._setMicUi(true)),
        ];
        this._setMicUi(true);
    }

    _setMicUi(moveSlider) {
        if (!this._source) return;
        let v = this._source.volume / this._mixer.get_vol_max_norm();
        let muted = this._source.is_muted;
        if (moveSlider) this.mic.setValue(Math.min(1, v));
        this.mic.pct.text = muted ? "muted" : Math.round(v * 100) + "%";
        this.mic.icon.icon_name = muted ? "microphone-sensitivity-muted-symbolic" : "audio-input-microphone-symbolic";
    }

    _refreshKbd() {
        if (this.kbdProxy) this.kbdProxy.GetPercentageRemote((b, err) => { if (!err) this._setKbdUi(b); });
    }

    _setKbdUi(b) {
        this.kbd.setValue(b / 100);
        this.kbd.pct.text = b + "%";
    }

    _setVolUi(moveSlider) {
        if (!this._sink) return;
        let v = this._sink.volume / this._mixer.get_vol_max_norm();
        let muted = this._sink.is_muted;
        if (moveSlider) this.vol.setValue(Math.min(1, v));
        this.vol.pct.text = muted ? "muted" : Math.round(v * 100) + "%";
        this.vol.icon.icon_name = muted || v === 0 ? "audio-volume-muted-symbolic" :
            v < 0.34 ? "audio-volume-low-symbolic" : v < 0.67 ? "audio-volume-medium-symbolic" : "audio-volume-high-symbolic";
    }

    _refreshBright() {
        if (this.brightProxy) this.brightProxy.GetPercentageRemote((b, err) => { if (!err) this._setBrightUi(b); });
    }

    _setBrightUi(b) {
        this.bright.setValue(b / 100);
        this.bright.pct.text = b + "%";
    }

    // ---------- network / bluetooth lists ----------
    _buildLists() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.wifiMenu = new PopupMenu.PopupSubMenuMenuItem("Wi-Fi networks");
        this.menu.addMenuItem(this.wifiMenu);
        this.btMenu = new PopupMenu.PopupSubMenuMenuItem("Bluetooth devices");
        this.menu.addMenuItem(this.btMenu);
        this._smoothSubmenu(this.wifiMenu, this.btMenu);
        this._smoothSubmenu(this.btMenu, this.wifiMenu);

        // System alerts (updates, system reports) — rows appear only when needed
        this.alertSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this.alertSection);
        this._alerts = new Map();   // name -> { proxy, ids }
        this._statusMonitor = new XApp.StatusIconMonitor();
        this._monitorIds = [
            this._statusMonitor.connect("icon-added", (m, proxy) => this._trackAlert(proxy)),
            this._statusMonitor.connect("icon-removed", (m, proxy) => this._untrackAlert((proxy.name || "").toLowerCase())),
        ];

        this.batteryItem = new PopupMenu.PopupMenuItem("");
        this.batteryItem.connect("activate", () => Util.spawnCommandLine("cinnamon-settings power"));
        this.menu.addMenuItem(this.batteryItem);
    }

    // Replace the stock expand/collapse with a gentler ease, and close the
    // sibling section first so only one list is open at a time.
    _smoothSubmenu(item, sibling) {
        let sub = item.menu;
        let animOn = () => imports.ui.main.wm.desktop_effects_menus;
        let setArrow = p => { if (sub._arrow) sub._arrow.rotation_angle_z = p * 90; };
        sub.open = (animate) => {
            if (sub.isOpen) return;
            sibling.menu.close(animate);
            sub.isOpen = true;
            sub.actor.show();
            if (!animate || !animOn()) { setArrow(1); sub.emit("open-state-changed", true); return; }
            let nat = this._naturalHeight(sub);
            sub.actor.remove_all_transitions();
            sub.actor.height = 0;
            sub.actor.opacity = 0;
            sub.actor.ease({
                height: nat, opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onUpdate: () => setArrow(nat ? sub.actor.height / nat : 1),
                onComplete: () => { sub.actor.set_height(-1); setArrow(1); sub.emit("open-state-changed", true); },
            });
        };
        sub.close = (animate) => {
            if (!sub.isOpen) return;
            sub.isOpen = false;
            if (!animate || !animOn()) {
                sub.actor.remove_all_transitions();
                sub.actor.hide(); sub.actor.set_height(-1); sub.actor.opacity = 255; setArrow(0);
                sub.emit("open-state-changed", false);
                return;
            }
            let start = sub.actor.height;
            sub.actor.remove_all_transitions();
            sub.actor.height = start;
            sub.actor.ease({
                height: 0, opacity: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onUpdate: () => setArrow(start ? sub.actor.height / start : 0),
                onComplete: () => {
                    sub.actor.hide(); sub.actor.set_height(-1); sub.actor.opacity = 255; setArrow(0);
                    sub.emit("open-state-changed", false);
                },
            });
        };
    }

    // Measure at the menu's real width with styles resolved; measuring an
    // unstyled, freshly shown submenu under-reports and makes the ease jump.
    _naturalHeight(sub) {
        sub.actor.set_height(-1);
        sub.actor.ensure_style();
        let walk = a => { if (a.ensure_style) a.ensure_style(); a.get_children().forEach(walk); };
        walk(sub.box);
        let width = this.menu.box.width || -1;
        let [, nat] = sub.actor.get_preferred_height(width);
        return nat;
    }

    // Rebuild a submenu only when its contents changed; if it is open,
    // ease from the old height to the new one instead of jumping.
    _setList(sub, signature, build) {
        if (sub._signature === signature) return;
        sub._signature = signature;
        let animate = sub.isOpen && imports.ui.main.wm.desktop_effects_menus;
        let oldH = animate ? sub.actor.height : 0;
        sub.removeAll();
        build();
        if (!animate) return;
        let nat = this._naturalHeight(sub);
        sub.actor.remove_all_transitions();
        sub.actor.opacity = 255;
        sub.actor.height = oldH;
        sub.actor.ease({
            height: nat, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onComplete: () => { sub.actor.set_height(-1); if (sub._arrow) sub._arrow.rotation_angle_z = 90; },
        });
    }

    _refreshWifiList(rescan) {
        // Ask the radio directly; the tile state may not have loaded yet
        run(["nmcli", "-t", "-f", "WIFI", "radio"], (ok, out) => {
            if (out.trim() !== "enabled") { this._fillWifiList(null); return; }
            run(["nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "dev", "wifi", "list", "--rescan", rescan ? "auto" : "no"], (ok2, out2) => {
                let seen = new Set();
                // Sort first so the in-use access point wins when one SSID has several APs
                let nets = out2.split("\n").filter(l => l.trim()).map(nmSplit)
                    .sort((a, b) => (b[0] === "*") - (a[0] === "*") || Number(b[2]) - Number(a[2]))
                    .filter(f => f[1] && !seen.has(f[1]) && seen.add(f[1]))
                    .slice(0, 12)
                    .map(([inUse, ssid, signal, sec]) => ({
                        inUse: inUse === "*", ssid,
                        icon: `network-wireless-signal-${this._signalName(Number(signal))}${sec && sec !== "--" ? "-secure" : ""}-symbolic`,
                    }));
                this._fillWifiList(nets);
            });
        });
    }

    _fillWifiList(nets) {
        let sub = this.wifiMenu.menu;
        this._setList(sub, JSON.stringify(nets), () => {
            if (!nets) sub.addMenuItem(new PopupMenu.PopupMenuItem("Wi-Fi is off", { reactive: false }));
            else if (!nets.length) sub.addMenuItem(new PopupMenu.PopupMenuItem("No networks found", { reactive: false }));
            for (let n of nets || []) {
                let item = new PopupMenu.PopupIconMenuItem((n.inUse ? "✓ " : "") + n.ssid, n.icon, St.IconType.SYMBOLIC);
                item.connect("activate", () => {
                    if (n.inUse) return;
                    this.wifiTile.set(true, "Connecting…");
                    // Works for saved/open networks; new secured ones need a password, so open settings
                    run(["nmcli", "dev", "wifi", "connect", n.ssid], (ok) => {
                        if (!ok) Util.spawnCommandLine("cinnamon-settings network");
                        this._refreshWifi();
                        this._refreshWifiList(false);
                    });
                });
                sub.addMenuItem(item);
            }
            this._addSettingsLink(sub, "Network settings…", "cinnamon-settings network");
        });
    }

    _refreshBtList() {
        run(["sh", "-c", "bluetoothctl show | grep -q 'Powered: yes' && echo ON; echo ---; bluetoothctl devices Paired; echo ---; bluetoothctl devices Connected"], (ok, out) => {
            let [power, paired, connected] = out.split("---");
            let parse = s => (s || "").split("\n").filter(l => l.startsWith("Device ")).map(l => {
                let p = l.split(" ");
                return { mac: p[1], name: p.slice(2).join(" ") };
            });
            let conn = new Set(parse(connected).map(d => d.mac));
            let devs = /ON/.test(power) ? parse(paired).map(d => ({ ...d, on: conn.has(d.mac) })) : null;
            let sub = this.btMenu.menu;
            this._setList(sub, JSON.stringify(devs), () => {
                if (!devs) sub.addMenuItem(new PopupMenu.PopupMenuItem("Bluetooth is off", { reactive: false }));
                else if (!devs.length) sub.addMenuItem(new PopupMenu.PopupMenuItem("No paired devices", { reactive: false }));
                for (let d of devs || []) {
                    let item = new PopupMenu.PopupSwitchMenuItem(d.name, d.on);
                    item.connect("toggled", (it, state) => {
                        run(["bluetoothctl", state ? "connect" : "disconnect", d.mac], () => { this._refreshBt(); this._refreshBtList(); });
                    });
                    sub.addMenuItem(item);
                }
                this._addSettingsLink(sub, "Bluetooth settings…", "blueman-manager");
            });
        });
    }

    _addSettingsLink(sub, text, cmd) {
        sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        let item = new PopupMenu.PopupMenuItem(text);
        item.connect("activate", () => Util.spawnCommandLine(cmd));
        sub.addMenuItem(item);
    }

    _trackAlert(proxy) {
        // Names are matched case-insensitively, like Cinnamon's tray roles ("mintUpdate.py")
        let key = (proxy.name || "").toLowerCase();
        if (!ALERT_APPS[key] || this._alerts.has(key)) return;
        let ids = ["notify::visible", "notify::tooltip-text"].map(sig => proxy.connect(sig, () => this._renderAlerts()));
        this._alerts.set(key, { proxy, ids });
        this._renderAlerts();
    }

    _untrackAlert(name) {
        let e = this._alerts.get(name);
        if (!e) return;
        for (let id of e.ids) e.proxy.disconnect(id);
        this._alerts.delete(name);
        this._renderAlerts();
    }

    _renderAlerts() {
        this.alertSection.removeAll();
        let count = 0;
        for (let [name, e] of this._alerts) {
            if (!e.proxy.visible) continue;
            let text = (e.proxy.tooltip_text || name).split("\n")[0];
            let item = new PopupMenu.PopupIconMenuItem(text, ALERT_APPS[name].icon, St.IconType.SYMBOLIC);
            item.connect("activate", () => Util.spawnCommandLine(ALERT_APPS[name].cmd));
            this.alertSection.addMenuItem(item);
            count++;
        }
        this._alertCount = count;
        this._updatePanelBattery();
    }

    // Power Saver on battery; back to the previous mode when plugged in.
    // Only reacts to plug/unplug, so a mode picked by hand is left alone.
    _watchPowerSource() {
        if (!GLib.find_program_in_path("powerprofilesctl")) return;
        new UPowerProxy(Gio.DBus.system, "org.freedesktop.UPower", "/org/freedesktop/UPower", (proxy, error) => {
            if (error) return;
            this._upower = proxy;
            this._onBattery = proxy.OnBattery;
            this._upowerId = proxy.connect("g-properties-changed", () => {
                let onBattery = proxy.OnBattery;
                if (onBattery === this._onBattery) return;
                this._onBattery = onBattery;
                if (onBattery) {
                    run(["powerprofilesctl", "get"], (ok, out) => {
                        this._profileOnAC = out.trim() || "balanced";
                        if (this._profileOnAC !== "power-saver")
                            run(["powerprofilesctl", "set", "power-saver"], () => this._refreshPower());
                    });
                } else {
                    let back = this._profileOnAC || "balanced";
                    run(["powerprofilesctl", "set", back], () => this._refreshPower());
                }
                this._updatePanelBattery();
            });
        });
    }

    _readBattery() {
        let base = ["BAT0", "BAT1", "BAT2"].map(b => "/sys/class/power_supply/" + b).find(p => GLib.file_test(p + "/capacity", GLib.FileTest.EXISTS));
        if (!base) return null;
        let read = f => { try { return new TextDecoder().decode(GLib.file_get_contents(base + "/" + f)[1]).trim(); } catch (e) { return ""; } };
        return { cap: Number(read("capacity")), status: read("status") };
    }

    // "99%" beside the icon; a bolt while charging, red when low
    _updatePanelBattery() {
        let b = this._readBattery();
        if (this._alertDot) this._alertDot.visible = !!this._alertCount;
        if (!b) { this.hide_applet_label(true); return; }
        this.hide_applet_label(false);
        let charging = b.status === "Charging";
        let text = (charging ? "⚡" : "") + b.cap + "%";
        this.set_applet_label(text);
        this._applet_label.style = !charging && b.cap <= 20 ? "color: #ff5f57;" : "";

        this.set_applet_tooltip(`Control Center\nBattery ${b.cap}% — ${b.status}`);
    }

    _refreshBattery() {
        this._updatePanelBattery();
        let base = ["BAT0", "BAT1", "BAT2"].map(b => "/sys/class/power_supply/" + b).find(p => GLib.file_test(p + "/capacity", GLib.FileTest.EXISTS));
        if (!base) { this.batteryItem.actor.hide(); return; }
        let read = f => { try { return new TextDecoder().decode(GLib.file_get_contents(base + "/" + f)[1]).trim(); } catch (e) { return ""; } };
        let cap = Number(read("capacity")), status = read("status");
        this.batteryItem.label.text = `Battery ${cap}% — ${status}`;
    }

    // ---------- footer ----------
    _buildFooter() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        let row = new St.BoxLayout({ vertical: false, style: "spacing: 6px;", x_expand: true });
        let buttons = [
            ["preferences-system-symbolic", "Settings", "cinnamon-settings"],
            ["system-lock-screen-symbolic", "Lock", "cinnamon-screensaver-command --lock"],
            ["weather-clear-night-symbolic", "Suspend", "systemctl suspend"],
            ["system-log-out-symbolic", "Log out", "cinnamon-session-quit --logout"],
            ["system-shutdown-symbolic", "Power off", "cinnamon-session-quit --power-off"],
        ];
        for (let [icon, tip, cmd] of buttons) {
            let b = new St.Button({ reactive: true, track_hover: true, x_expand: true,
                style: "border-radius: 99px; padding: 8px; background-color: rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.10);" });
            b.set_child(new St.Icon({ icon_name: icon, icon_type: St.IconType.SYMBOLIC, icon_size: 16 }));
            b.connect("notify::hover", () => b.style = "border-radius: 99px; padding: 8px; background-color: " +
                (b.hover ? "rgba(255,255,255,0.20); border: 1px solid rgba(255,255,255,0.10);" : "rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.10);"));
            this._addTipAbove(b, tip);
            b.connect("clicked", () => { this.menu.close(); Util.spawnCommandLine(cmd); });
            row.add_child(b);
        }
        let item = new PopupMenu.PopupBaseMenuItem({ reactive: false, activate: false, hover: false });
        item.addActor(row, { span: -1, expand: true });
        this.menu.addMenuItem(item);
    }

    // The stock tooltip opens below the pointer, which is off-screen for a
    // menu at the bottom of the screen, so draw our own label above the button.
    _addTipAbove(button, text) {
        let Main = imports.ui.main;
        let tip = new St.Label({ text, visible: false,
            style: "background-color: rgba(20,20,20,0.92); color: #eee; border: 1px solid rgba(255,255,255,0.12);" +
                   "border-radius: 6px; padding: 4px 8px; font-size: 9pt;" });
        Main.uiGroup.add_child(tip);
        button.connect("notify::hover", () => {
            if (!button.hover) { tip.hide(); return; }
            let [bx, by] = button.get_transformed_position();
            let [bw] = button.get_transformed_size();
            tip.show();
            Main.uiGroup.set_child_above_sibling(tip, null);
            let [, tw] = tip.get_preferred_width(-1);
            let [, th] = tip.get_preferred_height(-1);
            tip.set_position(Math.round(bx + (bw - tw) / 2), Math.round(by - th - 6));
        });
        button.connect("destroy", () => tip.destroy());
        this.menu.connect("open-state-changed", (m, open) => { if (!open) tip.hide(); });
    }

    _refreshAll() {
        this._refreshWifi();
        this._refreshBt();
        this._refreshNight();
        this._refreshDnd();
        this._refreshDark();
        this._refreshPower();
        this._refreshBright();
        this._refreshKbd();
        this._refreshBattery();
        this._refreshWifiList(true);
        this._refreshBtList();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new ControlCenter(metadata, orientation, panelHeight, instanceId);
}
