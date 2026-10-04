const Applet = imports.ui.applet;
const Glass = require('./glass');
const PopupMenu = imports.ui.popupMenu;
const Util = imports.misc.util;
const Interfaces = imports.misc.interfaces;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Cvc = imports.gi.Cvc;
const Mainloop = imports.mainloop;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const XApp = imports.gi.XApp;
const NM = imports.gi.NM;

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
const PPD_NAME = "org.freedesktop.UPower.PowerProfiles";
const PPD_PATH = "/org/freedesktop/UPower/PowerProfiles";
const KDC_NAME = "org.kde.kdeconnect";
const COLOR_NAME = "org.cinnamon.SettingsDaemon.Color";
const MprisAppProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="Identity" type="s" access="read"/>
  </interface>
</node>`);

// Now Playing album art
const ART_STYLE = "width: 72px; height: 72px; border-radius: 12px;";
// Fades a sliding line out at the edge(s) where text is cut off
const EDGE_FADE = `
uniform sampler2D tex;
uniform float fl;
uniform float fr;
void main() {
  vec4 col = texture2D(tex, cogl_tex_coord_in[0].st);
  float x = cogl_tex_coord_in[0].s;
  float a = 1.0;
  if (fl > 0.001) a *= clamp(x / fl, 0.0, 1.0);
  if (fr > 0.001) a *= clamp((1.0 - x) / fr, 0.0, 1.0);
  cogl_color_out = col * a;
}`;
const ACCENT = "#1f9ede";  // Mint-Y-Aqua accent, shared with the theme sliders and the clock panel
let GLASS = Glass.palette(false);

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

function iconThemeExists(name) {
    for (let dir of [GLib.get_home_dir() + "/.local/share/icons", GLib.get_home_dir() + "/.icons", "/usr/share/icons"])
        if (GLib.file_test(`${dir}/${name}/index.theme`, GLib.FileTest.EXISTS)) return true;
    return false;
}

function themeExists(name) {
    for (let dir of [GLib.get_home_dir() + "/.themes", GLib.get_home_dir() + "/.local/share/themes", "/usr/share/themes"])
        if (GLib.file_test(`${dir}/${name}`, GLib.FileTest.IS_DIR)) return true;
    return false;
}

// A macOS-style toggle tile: round icon + title + subtitle
class Tile {
    constructor(iconName, title, onClick) {
        this.actor = new St.Button({ reactive: true, can_focus: true, track_hover: true, x_expand: true });
        // Left-align tile contents so icons line up in a column
        let box = new St.BoxLayout({ vertical: false, style: "spacing: 10px;", x_expand: true,
                                     x_align: Clutter.ActorAlign.FILL });
        this.iconBin = new St.Bin({ style: "border-radius: 99px; padding: 7px;" });
        this.icon = new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: 16 });
        this.iconBin.set_child(this.icon);
        let labels = new St.BoxLayout({ vertical: true, y_align: Clutter.ActorAlign.CENTER });
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
        // glass pane: soft sheen, brighter at the top like light on glass
        this.actor.style = GLASS.pane(this.actor.hover) + " border-radius: 16px; padding: 8px 10px; width: 150px;";
        this.iconBin.style = "border-radius: 99px; padding: 7px; " +
            (this.active ? `background-color: ${ACCENT}; color: white;` : GLASS.circle);
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
        this._batteryTimer = Mainloop.timeout_add_seconds(30, () => { this._updatePanelBattery(); return true; });

        // We provide Bluetooth controls, so tell Cinnamon to hide Blueman's
        // tray icon (same mechanism the stock network/sound applets use).
        this.uuid = metadata.uuid;
        this._path = metadata.path;
        this._liveSignals = [];   // [object, id] for the D-Bus watchers below
        this._queued = {};        // pending _queue() timeouts
        imports.ui.main.systrayManager.registerTrayIconReplacement("blueman", this.uuid);
        for (let role in ALERT_APPS) imports.ui.main.systrayManager.registerTrayIconReplacement(role, this.uuid);

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        // Frosted glass sheet behind the content; falls back to the theme if unavailable.
        // Light or dark panes follow the Cinnamon theme (the Dark Mode tile switches it).
        this._glass = new Glass.GlassBackdrop(this.menu, { radius: 20, gap: 6, padding: "10px 6px",
                                                           onTheme: () => this._applyGlassTheme() });

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
        this._applyGlassTheme();

        this.signals = [
            [this.nightSettings, this.nightSettings.connect("changed", () => this._refreshNight())],
            [this.notifSettings, this.notifSettings.connect("changed::display-notifications", () => this._refreshDnd())],
            [this.ifaceSettings, this.ifaceSettings.connect("changed::gtk-theme", () => this._refreshDark())],
        ];

        // Wi-Fi, Bluetooth, power mode and phones are read over D-Bus and kept
        // up to date by their services' signals. Starting a helper program
        // from Cinnamon blocks the whole desktop for ~20 ms each, which made
        // the panel slow to open, so opening it starts none.
        this._initWifi();
        this._initBt();
        this._initPower();
        this._initPhone();
        this._initNight();

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
        this._marquee(false);
        // GObject's disconnect: some of these objects have their own disconnect()
        // method (NM.Device's drops the network connection)
        for (let [obj, id] of this._liveSignals) GObject.signal_handler_disconnect(obj, id);
        if (this._wifiDev) for (let id of this._wifiDevIds) GObject.signal_handler_disconnect(this._wifiDev, id);
        if (this._phoneSub) Gio.DBus.session.signal_unsubscribe(this._phoneSub);
        for (let id of Object.values(this._queued)) GLib.source_remove(id);
    }

    // Run fn once, a moment later, however many times this is called before then
    _queue(key, fn, ms = 0) {
        if (this._queued[key]) return;
        this._queued[key] = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, ms, () => {
            delete this._queued[key];
            fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _watch(obj, signals, fn) {
        for (let sig of signals) this._liveSignals.push([obj, obj.connect(sig, fn)]);
    }

    _styleFooterBtn(b) {
        b.style = "border-radius: 99px; padding: 8px; " + GLASS.pane(b.hover);
    }

    // Runs once everything is built, then on every light/dark switch
    _applyGlassTheme() {
        if (!this._glass) return;
        GLASS = Glass.palette(this._glass.light);
        for (let t of this.tiles) t._style();
        this.mediaCard.style = GLASS.pane(false) + " border-radius: 16px; padding: 12px; spacing: 14px;";
        for (let b of this._footerBtns) this._styleFooterBtn(b);
    }

    // ---------- Now Playing (MPRIS) ----------
    _buildMedia() {
        this.players = new Map();   // bus name -> { player, app, lastActive, propId }

        let card = this.mediaCard = new St.BoxLayout({ vertical: false, x_expand: true });
        this.mediaArt = new St.Bin({ style: ART_STYLE + " background-color: rgba(128,128,128,0.3);" });
        card.add_child(this.mediaArt);

        let text = new St.BoxLayout({ vertical: true, x_expand: true, reactive: true, track_hover: true,
                                      y_align: Clutter.ActorAlign.CENTER });
        this.mediaTitle = new St.Label({ style: "font-weight: bold; font-size: 11.5pt;" });
        this.mediaArtist = new St.Label({ style: "font-size: 10pt; opacity: 0.7;" });
        // Each line sits in a clipped strip that asks for no width of its own,
        // so a long title can't widen the panel; it slides instead (_marquee)
        for (let l of [this.mediaTitle, this.mediaArtist]) {
            l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            let strip = new St.Widget({ layout_manager: new Clutter.FixedLayout(), clip_to_allocation: true,
                                        x_expand: true, style: "width: 1px;" });
            strip.add_child(l);
            text.add_child(strip);
            try {
                strip._fade = new Clutter.ShaderEffect({ shader_type: Clutter.ShaderType.FRAGMENT_SHADER });
                strip._fade.set_shader_source(EDGE_FADE);
                strip._fade.set_uniform_value("tex", 0);
                strip.add_effect(strip._fade);
            } catch (e) { strip._fade = null; }
            l.connect("notify::translation-x", () => this._updateFade(l));
            strip.connect("notify::width", () => this._updateFade(l));
            l.connect("notify::width", () => this._updateFade(l));
        }
        this.menu.connect("open-state-changed", (m, open) => this._marquee(open));
        // Clicking the track brings the player window forward
        text.connect("button-release-event", () => {
            let p = this._currentPlayer();
            if (p && p.app) { p.app.RaiseRemote(() => {}); this.menu.close(); }
            return Clutter.EVENT_STOP;
        });
        card.add_child(text);

        let controls = new St.BoxLayout({ vertical: false, style: "spacing: 4px;", y_align: Clutter.ActorAlign.CENTER });
        // Our own filled icons (icons/), like macOS; themes often draw thin outlines
        let mkBtn = (icon, action, size = 22) => {
            let b = new St.Button({ reactive: true, track_hover: true,
                child: new St.Icon({ gicon: this._mediaIcon(icon), icon_type: St.IconType.SYMBOLIC, icon_size: size }) });
            let style = () => b.style = "padding: 6px; border-radius: 99px;" +
                (b.hover ? " background-color: rgba(128,128,128,0.3);" : "");
            b.connect("notify::hover", style);
            style();
            b.connect("clicked", () => { let p = this._currentPlayer(); if (p && p.player) action(p.player); });
            controls.add_child(b);
            return b;
        };
        this.mediaPrev = mkBtn("backward", pl => pl.PreviousRemote(() => {}));
        this.mediaPlay = mkBtn("play", pl => pl.PlayPauseRemote(() => {}), 28);   // bigger, like macOS
        this.mediaNext = mkBtn("forward", pl => pl.NextRemote(() => {}));
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

    // Slide lines that don't fit: wait, scroll to the end, pause, slide back,
    // repeat. Runs only while the panel is open.
    _marquee(run) {
        this._marqueeGen = (this._marqueeGen || 0) + 1;
        let gen = this._marqueeGen;
        for (let id of this._marqueeTimers || []) GLib.source_remove(id);
        this._marqueeTimers = new Set();
        let later = (ms, fn) => {
            let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._marqueeTimers.delete(id);
                if (gen === this._marqueeGen) fn();
                return GLib.SOURCE_REMOVE;
            });
            this._marqueeTimers.add(id);
        };
        for (let label of [this.mediaTitle, this.mediaArtist]) {
            label.remove_all_transitions();
            label.translation_x = 0;
            if (!run) continue;
            let cycle = () => {
                let overflow = label.width - label.get_parent().width;
                if (overflow <= 1) return;   // fits; check again when the text changes
                label.ease({ translation_x: -overflow, duration: Math.max(1500, overflow * 35),
                             mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                             onComplete: () => later(1500, () => label.ease({
                                 translation_x: 0, duration: 400, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                                 onComplete: () => later(2500, cycle) })) });
            };
            later(1500, cycle);
        }
    }

    // Fade the right edge while more text follows, the left once it has slid
    _updateFade(label) {
        let strip = label.get_parent(), fade = strip && strip._fade;
        if (!fade) return;
        let w = strip.width, overflow = label.width - w, shift = -label.translation_x;
        fade.set_enabled(w > 0 && overflow > 1);
        if (!(w > 0 && overflow > 1)) return;
        let edge = Math.min(0.3, 18 / w);   // uniforms are typed by value: keep these floats
        fade.set_uniform_value("fl", (shift > 0.5 ? edge : 0) + 1e-6);
        fade.set_uniform_value("fr", (shift < overflow - 0.5 ? edge : 0) + 1e-6);
    }

    _mediaIcon(name) {
        return Gio.FileIcon.new(Gio.File.new_for_path(`${this._path}/icons/media-${name}-symbolic.svg`));
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
        let artistText = artist || meta["xesam:album"] || (p.app && p.app.Identity) || "";
        if (this.mediaTitle.text !== title || this.mediaArtist.text !== artistText) {
            this.mediaTitle.text = title;
            this.mediaArtist.text = artistText;
            this._marquee(this.menu.isOpen);
        }
        let playing = p.player.PlaybackStatus === "Playing";
        this.mediaPlay.child.gicon = this._mediaIcon(playing ? "pause" : "play");
        this.mediaPrev.opacity = p.player.CanGoPrevious === false ? 90 : 255;
        this.mediaNext.opacity = p.player.CanGoNext === false ? 90 : 255;
        this._setArt(meta["mpris:artUrl"] || "");
    }

    _setArt(url) {
        if (url === this._artUrl) return;
        this._artUrl = url;
        let base = ART_STYLE;
        let fallback = () => {
            this.mediaArt.style = base + " background-color: rgba(128,128,128,0.3);";
            this.mediaArt.set_child(new St.Icon({ icon_name: "audio-x-generic-symbolic", icon_type: St.IconType.SYMBOLIC, icon_size: 32 }));
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
        this.nightTile = new Tile("night-light-symbolic", "Night Light", () => this._toggleNight());
        this.dndTile = new Tile("notifications-disabled-symbolic", "Do Not Disturb", () =>
            this.notifSettings.set_boolean("display-notifications", !this.notifSettings.get_boolean("display-notifications")));
        this.darkTile = new Tile("weather-clear-night-symbolic", "Dark Mode", () => this._toggleDark());
        this.powerTile = new Tile("power-profile-balanced-symbolic", "Power Mode", () => this._cyclePower());
        this.phoneTile = new Tile("phone-symbolic", "Phone", () => this._phoneClicked());
        this.phoneTile.actor.hide();

        let grid = new St.BoxLayout({ vertical: true, style: "spacing: 8px; padding: 4px 0;", x_expand: true });
        let tiles = this.tiles = [this.wifiTile, this.btTile, this.nightTile, this.dndTile, this.darkTile, this.powerTile, this.phoneTile];
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

    // ---------- Phone (KDE Connect) ----------
    _initPhone() {
        // the daemon announces phones coming and going
        this._phoneSub = Gio.DBus.session.signal_subscribe(KDC_NAME, "org.kde.kdeconnect.daemon", null,
            "/modules/kdeconnect", null, Gio.DBusSignalFlags.NONE, () => this._queue("phone", () => this._refreshPhone(), 300));
    }

    // A KDE Connect D-Bus call; callback gets the unpacked reply, or null
    _kdc(path, iface, method, params, callback) {
        Gio.DBus.session.call(KDC_NAME, path, iface, method, params, null, Gio.DBusCallFlags.NO_AUTO_START, 3000, null, (c, res) => {
            let reply = null;
            try { reply = c.call_finish(res).recursiveUnpack(); } catch (e) {}
            callback(reply);
        });
    }

    // Paired phones that are reachable right now, with battery level
    _phones(callback) {
        this._kdc("/modules/kdeconnect", "org.kde.kdeconnect.daemon", "devices", new GLib.Variant("(bb)", [true, true]), reply => {
            let phones = (reply ? reply[0] : []).filter(id => /^[A-Za-z0-9_]+$/.test(id)).map(id => ({ id, name: id, battery: null }));
            let left = phones.length * 2;
            if (!left) { callback(phones); return; }
            let done = () => { if (--left === 0) callback(phones); };
            let get = (p, path, iface, prop, set) =>
                this._kdc(`/modules/kdeconnect/devices/${p.id}${path}`, "org.freedesktop.DBus.Properties", "Get",
                          new GLib.Variant("(ss)", [iface, prop]), r => { if (r) set(r[0]); done(); });
            for (let p of phones) {
                get(p, "", "org.kde.kdeconnect.device", "name", v => p.name = v);
                get(p, "/battery", "org.kde.kdeconnect.device.battery", "charge", v => p.battery = v >= 0 ? v : null);
            }
        });
    }

    _refreshPhone() {
        let installed = !!GLib.find_program_in_path("kdeconnect-cli");
        this.phoneTile.actor.visible = installed;
        this.phoneMenu.actor.visible = installed;
        if (!installed) return;
        this._phones(phones => {
            let p = phones[0];
            this.phoneTile.set(!!p, p ? `${p.name}${p.battery !== null ? ` · ${p.battery}%` : ""}` : "Not connected");
            this._fillPhoneList(phones);
        });
    }

    // Like Wi-Fi and Bluetooth: the tile opens its list below
    _phoneClicked() {
        if (this.phoneMenu.menu.isOpen) this.phoneMenu.menu.close(true);
        else this.phoneMenu.menu.open(true);
    }

    _fillPhoneList(phones) {
        let sub = this.phoneMenu.menu;
        this._setList(sub, JSON.stringify(phones), () => {
            if (!phones.length)
                sub.addMenuItem(new PopupMenu.PopupMenuItem("No phone connected", { reactive: false }));
            for (let p of phones) {
                sub.addMenuItem(new PopupMenu.PopupIconMenuItem(
                    p.name + (p.battery !== null ? `  ·  ${p.battery}%` : ""), "phone-symbolic", St.IconType.SYMBOLIC,
                    { reactive: false }));
                let act = (text, fn) => {
                    let it = new PopupMenu.PopupMenuItem(text);
                    it.connect("activate", () => { this.menu.close(); fn(); });
                    sub.addMenuItem(it);
                };
                act("Send files…", () => run(["sh", "-c",
                    `zenity --file-selection --multiple --separator='\n' --title="Send to ${p.name.replace(/[^\w .-]/g, "")}" |` +
                    ` while IFS= read -r f; do kdeconnect-cli --device ${p.id} --share "$f"; done`]));
                act("Ring phone", () => run(["kdeconnect-cli", "--device", p.id, "--ring"]));
                act("Browse phone files", () => run(["gdbus", "call", "--session", "--dest", "org.kde.kdeconnect",
                    "--object-path", `/modules/kdeconnect/devices/${p.id}/sftp`,
                    "--method", "org.kde.kdeconnect.device.sftp.startBrowsing"]));
            }
            this._addSettingsLink(sub, phones.length ? "KDE Connect settings…" : "Pair a phone…", "kdeconnect-app");
        });
    }

    // ---------- Wi-Fi (NetworkManager) ----------
    _initWifi() {
        this._wifiDevIds = [];
        NM.Client.new_async(null, (o, res) => {
            try { this._nm = NM.Client.new_finish(res); } catch (e) { global.logError("controlcenter: NetworkManager: " + e); }
            if (this._nm) this._watch(this._nm, ["notify::wireless-enabled", "notify::active-connections", "device-added", "device-removed"],
                                      () => this._queue("wifi", () => this._updateWifi()));
            this._updateWifi();
        });
    }

    _updateWifi() {
        let dev = this._nm ? this._nm.get_devices().find(d => d.get_device_type() === NM.DeviceType.WIFI) || null : null;
        if (dev !== this._wifiDev) {
            if (this._wifiDev) for (let id of this._wifiDevIds) GObject.signal_handler_disconnect(this._wifiDev, id);
            this._wifiDev = dev;
            this._wifiDevIds = !dev ? [] : ["notify::active-access-point", "access-point-added", "access-point-removed", "notify::last-scan"]
                .map(sig => dev.connect(sig, () => this._queue("wifi", () => this._updateWifi())));
        }
        if (!dev || !this._nm.wireless_get_enabled()) {
            this.wifiTile.set(false, dev ? "Off" : "Unavailable", "network-wireless-disabled-symbolic");
            this._fillWifiList(null);
            return;
        }
        let ssidOf = ap => { let b = ap.get_ssid(); return b ? NM.utils_ssid_to_utf8(b.get_data()) : ""; };
        let active = dev.get_active_access_point();
        let current = active ? ssidOf(active) : null;
        this.wifiTile.set(true, current || "Not connected", active ?
            `network-wireless-signal-${this._signalName(active.get_strength())}-symbolic` : "network-wireless-offline-symbolic");

        // One row per network name, at its strongest access point
        let best = new Map();
        for (let ap of dev.get_access_points()) {
            let ssid = ssidOf(ap);
            if (!ssid || (best.has(ssid) && best.get(ssid).strength >= ap.get_strength())) continue;
            // PRIVACY (0x1) is WEP; the WPA/RSN flags cover everything newer
            let secure = (ap.get_flags() & 0x1) || ap.get_wpa_flags() || ap.get_rsn_flags();
            best.set(ssid, { ssid, strength: ap.get_strength(), secure: !!secure, inUse: ssid === current });
        }
        let nets = Array.from(best.values())
            .sort((a, b) => b.inUse - a.inUse || b.strength - a.strength)
            .slice(0, 12)
            .map(n => ({ inUse: n.inUse, ssid: n.ssid,
                         icon: `network-wireless-signal-${this._signalName(n.strength)}${n.secure ? "-secure" : ""}-symbolic` }));
        this._fillWifiList(nets);
    }

    // Look for new networks; results arrive through the device's signals
    _scanWifi() {
        if (this._wifiDev && this._nm.wireless_get_enabled())
            this._wifiDev.request_scan_async(null, (d, res) => { try { d.request_scan_finish(res); } catch (e) {} });
    }

    _signalName(s) {
        return s >= 80 ? "excellent" : s >= 55 ? "good" : s >= 30 ? "ok" : s > 5 ? "weak" : "none";
    }

    _toggleWifi() {
        if (!this._nm) return;
        let on = !this.wifiTile.active;
        this.wifiTile.set(on, on ? "Turning on…" : "Off");
        this._nm.dbus_set_property(NM.DBUS_PATH, NM.DBUS_INTERFACE, "WirelessEnabled", GLib.Variant.new_boolean(on), -1, null,
            (c, res) => { try { c.dbus_set_property_finish(res); } catch (e) { this._updateWifi(); } });
    }

    // ---------- Bluetooth (BlueZ) ----------
    _initBt() {
        let mgr = new Gio.DBusObjectManagerClient({ bus_type: Gio.BusType.SYSTEM, name: "org.bluez", object_path: "/",
                                                    flags: Gio.DBusObjectManagerClientFlags.DO_NOT_AUTO_START });
        mgr.init_async(GLib.PRIORITY_DEFAULT, null, (m, res) => {
            try {
                m.init_finish(res);
                this._bluez = m;
                this._watch(m, ["object-added", "object-removed", "interface-proxy-properties-changed", "notify::name-owner"],
                            () => this._queue("bt", () => this._updateBt()));
            } catch (e) {}
            this._updateBt();
        });
    }

    _btProxies(iface) {
        if (!this._bluez || !this._bluez.name_owner) return [];
        return this._bluez.get_objects().map(o => o.get_interface(iface)).filter(Boolean);
    }

    _updateBt() {
        let prop = (proxy, name) => { let v = proxy.get_cached_property(name); return v ? v.unpack() : null; };
        let adapter = this._btProxies("org.bluez.Adapter1")[0];
        if (!adapter) {
            this.btTile.set(false, "Unavailable", "bluetooth-disabled-symbolic");
            this._fillBtList(null);
            return;
        }
        if (!prop(adapter, "Powered")) {
            this.btTile.set(false, "Off", "bluetooth-disabled-symbolic");
            this._fillBtList(null);
            return;
        }
        let devs = this._btProxies("org.bluez.Device1").filter(d => prop(d, "Paired"))
            .map(d => ({ path: d.g_object_path, name: prop(d, "Alias") || prop(d, "Address"), on: !!prop(d, "Connected") }))
            .sort((a, b) => a.name.localeCompare(b.name));
        let connected = devs.filter(d => d.on).map(d => d.name);
        this.btTile.set(true, connected.length ? connected.join(", ") : "On", "bluetooth-active-symbolic");
        this._fillBtList(devs);
    }

    _toggleBt() {
        let turnOn = !this.btTile.active;
        this.btTile.set(turnOn, turnOn ? "Turning on…" : "Off");
        // rfkill first: a soft-blocked adapter can't be powered on over D-Bus
        let cmd = turnOn ? "rfkill unblock bluetooth; sleep 1; bluetoothctl power on" : "bluetoothctl power off";
        run(["sh", "-c", cmd], () => this._updateBt());
    }

    // ---------- Night Light ----------
    // Cinnamon's switch only enables the schedule, so during the day turning
    // it "on" did nothing until sunset. Like macOS: the tile shows whether
    // the screen is warm right now. Turning it on outside the schedule runs
    // it all day (a manual schedule with equal start and end) and remembers
    // your schedule; turning it off puts the schedule back, or pauses it
    // until tomorrow if it's running on schedule.
    _initNight() {
        this._nightFile = GLib.build_filenamev([GLib.get_user_state_dir(), "controlcenter", "night-light-schedule.json"]);
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            COLOR_NAME, "/org/cinnamon/SettingsDaemon/Color", COLOR_NAME, null, (o, res) => {
                try {
                    this._color = Gio.DBusProxy.new_for_bus_finish(res);
                    this._watch(this._color, ["g-properties-changed"], () => this._refreshNight());
                } catch (e) {}
                this._refreshNight();
            });
    }

    _colorProp(name) {
        let v = this._color && this._color.get_cached_property(name);
        return v ? v.unpack() : null;
    }

    _setColorProp(name, value) {
        if (!this._color) return;
        this._color.call("org.freedesktop.DBus.Properties.Set", new GLib.Variant("(ssv)", [COLOR_NAME, name, value]),
                         Gio.DBusCallFlags.NONE, -1, null, (p, res) => { try { p.call_finish(res); } catch (e) {} });
    }

    // The schedule we replaced to force it on, while that is still in effect
    _nightSaved() {
        let ns = this.nightSettings;
        if (ns.get_string("night-light-schedule-mode") !== "manual" ||
            ns.get_double("night-light-schedule-from") !== ns.get_double("night-light-schedule-to")) return null;
        try { return JSON.parse(new TextDecoder().decode(GLib.file_get_contents(this._nightFile)[1])); } catch (e) { return null; }
    }

    // Start and end of the schedule in hours (sunset/sunrise in auto mode)
    _nightWindow() {
        let ns = this.nightSettings;
        if (ns.get_string("night-light-schedule-mode") === "auto")
            return [this._colorProp("Sunset") || 20, this._colorProp("Sunrise") || 6];
        return [ns.get_double("night-light-schedule-from"), ns.get_double("night-light-schedule-to")];
    }

    _inNightWindow() {
        let [from, to] = this._nightWindow();
        let now = GLib.DateTime.new_now_local();
        let h = now.get_hour() + now.get_minute() / 60;
        if (to <= from) to += 24;            // overnight; equal means all day
        if (h < from) h += 24;
        return h >= from && h < to;
    }

    _toggleNight() {
        let ns = this.nightSettings;
        if (!this.nightTile.active) {
            if (ns.get_boolean("night-light-enabled") && this._inNightWindow()) {
                this._setColorProp("DisabledUntilTomorrow", GLib.Variant.new_boolean(false));   // just paused
            } else {
                let saved = { enabled: ns.get_boolean("night-light-enabled"), mode: ns.get_string("night-light-schedule-mode"),
                              from: ns.get_double("night-light-schedule-from"), to: ns.get_double("night-light-schedule-to") };
                GLib.mkdir_with_parents(GLib.path_get_dirname(this._nightFile), 0o700);
                GLib.file_set_contents(this._nightFile, JSON.stringify(saved));
                ns.set_string("night-light-schedule-mode", "manual");
                ns.set_double("night-light-schedule-from", 0);
                ns.set_double("night-light-schedule-to", 0);
                ns.set_boolean("night-light-enabled", true);
                this._setColorProp("DisabledUntilTomorrow", GLib.Variant.new_boolean(false));
            }
            this.nightTile.set(true, "On", "night-light-symbolic");
        } else {
            let saved = this._nightSaved();
            if (saved) {
                ns.set_string("night-light-schedule-mode", saved.mode);
                ns.set_double("night-light-schedule-from", saved.from);
                ns.set_double("night-light-schedule-to", saved.to);
                ns.set_boolean("night-light-enabled", saved.enabled);
                GLib.unlink(this._nightFile);
            }
            // back on schedule but inside its hours: don't switch straight on again
            if (ns.get_boolean("night-light-enabled") && this._inNightWindow())
                this._setColorProp("DisabledUntilTomorrow", GLib.Variant.new_boolean(true));
            this.nightTile.set(false, "Off", "night-light-disabled-symbolic");
        }
    }

    _refreshNight() {
        let ns = this.nightSettings;
        let auto = ns.get_string("night-light-schedule-mode") === "auto";
        let [from, to] = this._nightWindow();
        let hhmm = h => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
        let active = this._color ? !!this._colorProp("NightLightActive")
                                 : ns.get_boolean("night-light-enabled") && this._inNightWindow();
        let sub;
        if (active) sub = this._nightSaved() ? "On" : auto ? "Until sunrise" : `Until ${hhmm(to)}`;
        else if (ns.get_boolean("night-light-enabled") && this._colorProp("DisabledUntilTomorrow")) sub = "Off until tomorrow";
        else if (ns.get_boolean("night-light-enabled")) sub = auto ? "From sunset" : `From ${hhmm(from)}`;
        else sub = "Off";
        this.nightTile.set(active, sub, active ? "night-light-symbolic" : "night-light-disabled-symbolic");
    }

    _refreshDnd() {
        let dnd = !this.notifSettings.get_boolean("display-notifications");
        this.dndTile.set(dnd, dnd ? "On" : "Off");
    }

    // Theme name for the other mode. Handles Mint-Y ("Mint-Y-Aqua" <-> "Mint-Y-Dark-Aqua")
    // and themes with Light/Dark variants ("WhiteSur-Light" <-> "WhiteSur-Dark").
    _darkVariant(name, wantDark) {
        if (!/^Mint-/.test(name) && /-(Light|Dark)(\b|-)/.test(name))
            return name.replace(/-(Light|Dark)(\b|-)/, (m, v, rest) => (wantDark ? "-Dark" : "-Light") + rest);
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
        // icon sets with light/dark variants (e.g. WhiteSur-light / WhiteSur-dark)
        let icons = this.ifaceSettings.get_string("icon-theme");
        let m = icons.match(/^(.*)-(light|dark)$/i);
        if (m && iconThemeExists(`${m[1]}-${wantDark ? "dark" : "light"}`))
            this.ifaceSettings.set_string("icon-theme", `${m[1]}-${wantDark ? "dark" : "light"}`);
        if (this.portalSettings) this.portalSettings.set_string("color-scheme", wantDark ? "prefer-dark" : "default");
        if (this.gnomeIface) try { this.gnomeIface.set_string("color-scheme", wantDark ? "prefer-dark" : "default"); } catch (e) {}
        this._refreshDark();
    }

    // ---------- Power Mode (power-profiles-daemon) ----------
    _initPower() {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null, PPD_NAME, PPD_PATH, PPD_NAME, null,
            (o, res) => {
                try {
                    this._ppd = Gio.DBusProxy.new_for_bus_finish(res);
                    this._watch(this._ppd, ["g-properties-changed", "notify::g-name-owner"], () => this._refreshPower());
                } catch (e) {}
                this._refreshPower();
                this._watchPowerSource();
            });
    }

    _profile() {
        let v = this._ppd && this._ppd.get_cached_property("ActiveProfile");
        return v ? v.unpack() : null;
    }

    _setProfile(profile) {
        this._ppd.call("org.freedesktop.DBus.Properties.Set",
            new GLib.Variant("(ssv)", [PPD_NAME, "ActiveProfile", GLib.Variant.new_string(profile)]),
            Gio.DBusCallFlags.NONE, -1, null, (p, res) => { try { p.call_finish(res); } catch (e) {} });
    }

    _refreshPower() {
        let p = this._profile();
        this.powerTile.actor.visible = !!p;
        if (!p) return;
        let label = { "power-saver": "Power Saver", "balanced": "Balanced", "performance": "Performance" }[p] || p;
        this.powerTile.set(p !== "balanced", label, `power-profile-${p}-symbolic`);
    }

    _cyclePower() {
        let list = this._ppd && this._ppd.get_cached_property("Profiles");
        if (!list) return;
        let have = list.recursiveUnpack().map(d => d.Profile);
        let avail = ["power-saver", "balanced", "performance"].filter(p => have.includes(p));
        this._setProfile(avail[(avail.indexOf(this._profile()) + 1) % avail.length]);
    }

    // ---------- sliders ----------
    _makeSlider(iconName) {
        let slider = new PopupMenu.PopupSliderMenuItem(0);
        // 30px wide, like the tile icon circles, so icons share one column
        let btn = new St.Button({ reactive: true, style: "padding: 0 0 0 10px; width: 30px;" });
        let icon = new St.Icon({ icon_name: iconName, icon_type: St.IconType.SYMBOLIC, icon_size: 16 });
        btn.set_child(icon);
        slider.removeActor(slider._slider);
        slider.pct = new St.Label({ text: "", style: "min-width: 3.4em; text-align: right; font-size: 9pt;",
                                    y_align: Clutter.ActorAlign.CENTER });
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

        // Display brightness via cinnamon-settings-daemon (never all the way to black)
        this.bright = this._percentSlider("display-brightness-symbolic", "org.cinnamon.SettingsDaemon.Power.Screen", 1);

        // Output volume and microphone via the PulseAudio/PipeWire mixer:
        // the icon is the mute button, the slider sets the level
        this.vol = this._streamSlider("audio-volume-high-symbolic", (v, muted) => muted || v === 0 ? "audio-volume-muted-symbolic" :
            v < 0.34 ? "audio-volume-low-symbolic" : v < 0.67 ? "audio-volume-medium-symbolic" : "audio-volume-high-symbolic");
        this.mic = this._streamSlider("audio-input-microphone-symbolic", (v, muted) =>
            muted ? "microphone-sensitivity-muted-symbolic" : "audio-input-microphone-symbolic");

        // Keyboard backlight; stays hidden on laptops without one
        this.kbd = this._percentSlider("keyboard-brightness-symbolic", "org.cinnamon.SettingsDaemon.Power.Keyboard", 0);

        this._mixer = new Cvc.MixerControl({ name: "Control Center" });
        let bindSink = () => this._bindStream(this.vol, this._mixer.get_default_sink());
        let bindSource = () => this._bindStream(this.mic, this._mixer.get_default_source());
        this._mixer.connect("state-changed", () => {
            if (this._mixer.get_state() === Cvc.MixerControlState.READY) { bindSink(); bindSource(); }
        });
        this._mixer.connect("default-sink-changed", bindSink);
        this._mixer.connect("default-source-changed", bindSource);
        this._mixer.open();
    }

    // A slider for a settings-daemon "percentage" interface (screen or keyboard
    // backlight). Hidden until the interface answers, so it never shows on
    // hardware that doesn't support it.
    _percentSlider(iconName, iface, min) {
        let slider = this._makeSlider(iconName);
        slider.actor.hide();
        this.menu.addMenuItem(slider);
        let show = b => { slider.setValue(b / 100); slider.pct.text = b + "%"; };
        slider.refresh = () => {
            if (slider.proxy) slider.proxy.GetPercentageRemote((b, err) => { if (!err) show(b); });
        };
        Interfaces.getDBusProxyAsync(iface, (proxy, error) => {
            if (error) return;
            proxy.GetPercentageRemote((b, err) => {
                if (err) return;   // e.g. "Keyboard backlight control is not supported"
                slider.proxy = proxy;
                slider.actor.show();
                show(b);
            });
            proxy.connectSignal("Changed", () => { if (!slider.dragging) slider.refresh(); });
        });
        slider.connect("drag-begin", () => slider.dragging = true);
        slider.connect("drag-end", () => slider.dragging = false);
        slider.connect("value-changed", (s, v) => {
            let pct = Math.max(min, Math.round(v * 100));
            slider.pct.text = pct + "%";
            if (slider.proxy) slider.proxy.SetPercentageRemote(pct, () => {});
        });
        return slider;
    }

    // A mixer slider; _bindStream attaches it to the default output or input
    _streamSlider(iconName, iconFor) {
        let slider = this._makeSlider(iconName);
        slider.actor.hide();
        slider.iconFor = iconFor;
        this.menu.addMenuItem(slider);
        slider.button.connect("clicked", () => { if (slider.stream) slider.stream.change_is_muted(!slider.stream.is_muted); });
        slider.connect("value-changed", (s, v) => {
            let stream = slider.stream;
            if (!stream) return;
            stream.volume = v * this._mixer.get_vol_max_norm();
            stream.push_volume();
            if (stream.is_muted && v > 0) stream.change_is_muted(false);
            this._showStream(slider);
        });
        return slider;
    }

    _bindStream(slider, stream) {
        if (slider.stream) for (let id of slider.streamIds) slider.stream.disconnect(id);
        slider.stream = stream;
        slider.actor.visible = !!stream;
        if (!stream) return;
        slider.streamIds = ["notify::volume", "notify::is-muted"].map(sig => stream.connect(sig, () => this._showStream(slider, true)));
        this._showStream(slider, true);
    }

    _showStream(slider, moveSlider) {
        let v = slider.stream.volume / this._mixer.get_vol_max_norm();
        let muted = slider.stream.is_muted;
        if (moveSlider) slider.setValue(Math.min(1, v));
        slider.pct.text = muted ? "muted" : Math.round(v * 100) + "%";
        slider.icon.icon_name = slider.iconFor(v, muted);
    }

    // ---------- network / bluetooth lists ----------
    _buildLists() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.wifiMenu = new PopupMenu.PopupSubMenuMenuItem("Wi-Fi networks");
        this.menu.addMenuItem(this.wifiMenu);
        this.btMenu = new PopupMenu.PopupSubMenuMenuItem("Bluetooth devices");
        this.menu.addMenuItem(this.btMenu);
        // Phone (KDE Connect); hidden until KDE Connect is installed
        this.phoneMenu = new PopupMenu.PopupSubMenuMenuItem("Phone");
        this.menu.addMenuItem(this.phoneMenu);
        this.phoneMenu.actor.hide();
        let sections = () => [this.wifiMenu, this.btMenu, this.phoneMenu];
        for (let s of sections()) this._smoothSubmenu(s, sections);

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
    _smoothSubmenu(item, siblings) {
        let sub = item.menu;
        // The theme paints expanded sections solid; let the glass show through
        sub.actor.style = "background-color: transparent;";
        let animOn = () => imports.ui.main.wm.desktop_effects_menus;
        let setArrow = p => { if (sub._arrow) sub._arrow.rotation_angle_z = p * 90; };
        sub.open = (animate) => {
            if (sub.isOpen) return;
            for (let s of siblings()) if (s !== item) s.menu.close(animate);
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
        // The theme indents section items by 2.5em on the left but keeps the
        // full 1.75em on the right, which widens the panel when expanded.
        // Keep the indent and trim the right side so the width stays the same.
        for (let it of sub._getMenuItems())
            if (it.actor) it.actor.style = "padding-left: 2.5em; padding-right: 1em;";
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
                    run(["nmcli", "dev", "wifi", "connect", n.ssid], ok => {
                        if (!ok) Util.spawnCommandLine("cinnamon-settings network");
                        this._updateWifi();
                    });
                });
                sub.addMenuItem(item);
            }
            this._addSettingsLink(sub, "Network settings…", "cinnamon-settings network");
        });
    }

    _fillBtList(devs) {
        let sub = this.btMenu.menu;
        this._setList(sub, JSON.stringify(devs), () => {
            if (!devs) sub.addMenuItem(new PopupMenu.PopupMenuItem("Bluetooth is off", { reactive: false }));
            else if (!devs.length) sub.addMenuItem(new PopupMenu.PopupMenuItem("No paired devices", { reactive: false }));
            for (let d of devs || []) {
                let item = new PopupMenu.PopupSwitchMenuItem(d.name, d.on);
                item.connect("toggled", (it, state) => {
                    let dev = this._bluez && this._bluez.get_interface(d.path, "org.bluez.Device1");
                    if (dev) dev.call(state ? "Connect" : "Disconnect", null, Gio.DBusCallFlags.NONE, 30000, null,
                                      (p, res) => { try { p.call_finish(res); } catch (e) { this._updateBt(); } });
                });
                sub.addMenuItem(item);
            }
            this._addSettingsLink(sub, "Bluetooth settings…", "blueman-manager");
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
        if (!this._profile()) return;
        new UPowerProxy(Gio.DBus.system, "org.freedesktop.UPower", "/org/freedesktop/UPower", (proxy, error) => {
            if (error) return;
            this._upower = proxy;
            this._onBattery = proxy.OnBattery;
            this._upowerId = proxy.connect("g-properties-changed", () => {
                let onBattery = proxy.OnBattery;
                if (onBattery === this._onBattery) return;
                this._onBattery = onBattery;
                if (onBattery) {
                    this._profileOnAC = this._profile() || "balanced";
                    if (this._profileOnAC !== "power-saver") this._setProfile("power-saver");
                } else {
                    this._setProfile(this._profileOnAC || "balanced");
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

    // "99%" beside the icon; a bolt while charging, red when low. Returns the reading.
    _updatePanelBattery() {
        let b = this._readBattery();
        if (this._alertDot) this._alertDot.visible = !!this._alertCount;
        if (!b) { this.hide_applet_label(true); return null; }
        this.hide_applet_label(false);
        let charging = b.status === "Charging";
        let text = (charging ? "⚡" : "") + b.cap + "%";
        this.set_applet_label(text);
        this._applet_label.style = !charging && b.cap <= 20 ? "color: #ff5f57;" : null;

        this.set_applet_tooltip(`Control Center\nBattery ${b.cap}% — ${b.status}`);
        return b;
    }

    _refreshBattery() {
        let b = this._updatePanelBattery();
        if (!b) { this.batteryItem.actor.hide(); return; }
        this.batteryItem.label.text = `Battery ${b.cap}% — ${b.status}`;
    }

    // ---------- footer ----------
    _buildFooter() {
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        let row = new St.BoxLayout({ vertical: false, style: "spacing: 6px;", x_expand: true });
        this._footerBtns = [];
        let buttons = [
            ["preferences-system-symbolic", "Settings", "cinnamon-settings"],
            ["system-lock-screen-symbolic", "Lock", "cinnamon-screensaver-command --lock"],
            ["weather-clear-night-symbolic", "Suspend", "systemctl suspend"],
            ["system-log-out-symbolic", "Log out", "cinnamon-session-quit --logout"],
            ["system-shutdown-symbolic", "Power off", "cinnamon-session-quit --power-off"],
        ];
        for (let [icon, tip, cmd] of buttons) {
            let b = new St.Button({ reactive: true, track_hover: true, x_expand: true });
            b.set_child(new St.Icon({ icon_name: icon, icon_type: St.IconType.SYMBOLIC, icon_size: 16 }));
            this._footerBtns.push(b);
            b.connect("notify::hover", () => this._styleFooterBtn(b));
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

    // Cheap reads only: everything here is a setting, a file in /sys or an async D-Bus call
    _refreshAll() {
        this._refreshNight();
        this._refreshDnd();
        this._refreshDark();
        this._refreshPower();
        this.bright.refresh();
        this.kbd.refresh();
        this._refreshBattery();
        this._refreshPhone();
        this._scanWifi();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new ControlCenter(metadata, orientation, panelHeight, instanceId);
}
