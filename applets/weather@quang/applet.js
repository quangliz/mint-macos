const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Mainloop = imports.mainloop;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const Glass = require('./glass');

const API = "https://api.open-meteo.com/v1/forecast";
const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const HOURS = 12;

// WMO weather codes -> [icon, description]
function describe(code, isDay) {
    const night = isDay === 0;
    if (code === 0) return [night ? "weather-clear-night" : "weather-clear", "Clear"];
    if (code === 1) return [night ? "weather-clear-night" : "weather-clear", "Mostly clear"];
    if (code === 2) return [night ? "weather-few-clouds-night" : "weather-few-clouds", "Partly cloudy"];
    if (code === 3) return ["weather-overcast", "Cloudy"];
    if (code === 45 || code === 48) return ["weather-fog", "Fog"];
    if (code >= 51 && code <= 57) return ["weather-showers-scattered", "Drizzle"];
    if (code >= 61 && code <= 67) return ["weather-showers", "Rain"];
    if (code >= 71 && code <= 77) return ["weather-snow", "Snow"];
    if (code >= 80 && code <= 82) return ["weather-showers", "Showers"];
    if (code === 85 || code === 86) return ["weather-snow", "Snow showers"];
    if (code >= 95) return ["weather-storm", "Thunderstorms"];
    return ["weather-overcast", "—"];
}

function icon(name, size) {
    return new St.Icon({ icon_name: name + "-symbolic", icon_type: St.IconType.SYMBOLIC, icon_size: size });
}

function label(text, style, dim) {
    let l = new St.Label({ text, style: style || "" });
    l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    if (dim) l.opacity = 165;   // works with both light and dark theme text
    return l;
}

// Same glass panes as the Control Center
// The sheet itself is just the blur, no tint or border, like the clock panel
const SHEET = "background-color: transparent; border: none;";
function glassPalette(light) {
    const sheen = (t, b) => "background-gradient-direction: vertical;" +
        ` background-gradient-start: rgba(255,255,255,${t}); background-gradient-end: rgba(255,255,255,${b});`;
    return light ? {
        sheet: SHEET,
        pane: sheen(0.72, 0.48) + " border: 1px solid rgba(255,255,255,0.80);",
    } : {
        sheet: SHEET,
        pane: sheen(0.15, 0.06) + " border: 1px solid rgba(255,255,255,0.12);",
    };
}

class WeatherApplet extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.set_applet_icon_symbolic_name("weather-overcast-symbolic");
        this.set_applet_label("--°");
        this.set_applet_tooltip("Weather");

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        for (let k of ["units", "refresh", "city", "location-name", "latitude", "longitude"])
            this.settings.bind(k, k.replace(/-/g, "_"), () => this._restart(true));
        this.iface = new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" });

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this._glass = new Glass.GlassBackdrop(this.menu, { radius: 20, gap: 6 });
        this.themeSettings = new Gio.Settings({ schema_id: "org.cinnamon.theme" });
        this.themeId = this.themeSettings.connect("changed::name", () => this._render());

        this.content = new St.BoxLayout({ vertical: true, style: "padding: 6px 14px; spacing: 12px; width: 330px;" });
        this.menu.addActor(this.content);
        this.menu.connect("open-state-changed", (m, open) => {
            // refresh if the data is getting old
            if (open && (!this.fetchedAt || Date.now() - this.fetchedAt > 10 * 60 * 1000)) this._fetch();
        });

        this.data = null;
        this.failed = false;
        this.place = null;          // { lat, lon, name } resolved for the current settings
        this._geoCache = {};        // city text -> place
        this._restart(true);
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        if (this.timer) Mainloop.source_remove(this.timer);
        this.timer = null;
        if (this._glass) this._glass.destroy();
        this.themeSettings.disconnect(this.themeId);
        this.settings.finalize();
    }

    _restart(fetchNow) {
        if (this.timer) Mainloop.source_remove(this.timer);
        this.timer = Mainloop.timeout_add_seconds(Math.max(5, this.refresh) * 60, () => { this._fetch(); return true; });
        if (fetchNow) this._fetch();
    }

    _curl(url, callback) {
        try {
            let proc = Gio.Subprocess.new(["curl", "-sf", "--max-time", "15", url],
                                          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                let json = null;
                try {
                    let [, out] = p.communicate_utf8_finish(res);
                    if (p.get_successful()) json = JSON.parse(out);
                } catch (e) {}
                callback(json);
            });
        } catch (e) {
            callback(null);
        }
    }

    // Look up a city by name with Open-Meteo's geocoding (cached per name)
    _geocode(city, callback) {
        let key = city.trim().toLowerCase();
        if (this._geoCache[key]) { callback(this._geoCache[key]); return; }
        let url = `${GEOCODE}?name=${GLib.uri_escape_string(city.trim(), null, true)}&count=1&language=en&format=json`;
        this._curl(url, json => {
            let r = json && json.results && json.results[0];
            let place = r ? { lat: r.latitude, lon: r.longitude,
                              name: r.country && r.country !== r.name ? `${r.name}, ${r.country}` : r.name } : null;
            if (place) this._geoCache[key] = place;
            callback(place);
        });
    }

    // City search first, then manual coordinates, then the location Night Light detected
    _resolve(callback) {
        if ((this.city || "").trim()) {
            this._geocode(this.city, place => callback(place, place ? null : `No place called "${this.city.trim()}" was found.`));
            return;
        }
        let lat = parseFloat(this.latitude), lon = parseFloat(this.longitude);
        if (isFinite(lat) && isFinite(lon)) { callback({ lat, lon, name: null }); return; }
        try {
            let color = new Gio.Settings({ schema_id: "org.cinnamon.settings-daemon.plugins.color" });
            let [la, lo] = color.get_value("night-light-last-coordinates").deep_unpack();
            if (Math.abs(la) <= 90 && Math.abs(lo) <= 180) { callback({ lat: la, lon: lo, name: null }); return; }
        } catch (e) {}
        callback(null, "No location yet. Search for a city above.");
    }

    _placeName() {
        if (this.location_name) return this.location_name;
        if (this.place && this.place.name) return this.place.name;
        let id = GLib.TimeZone.new_local().get_identifier() || "";   // e.g. "Asia/Ho_Chi_Minh"
        return id.includes("/") ? id.split("/").pop().replace(/_/g, " ") : "Weather";
    }

    _fetch() {
        this._resolve((place, error) => {
            if (!place) {
                this.error = error;
                this.failed = true;
                this._render();
                return;
            }
            let moved = !this.place || this.place.lat !== place.lat || this.place.lon !== place.lon;
            this.place = place;
            this.error = null;
            let f = this.units === "fahrenheit";
            let url = `${API}?latitude=${place.lat.toFixed(3)}&longitude=${place.lon.toFixed(3)}` +
                "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day" +
                "&hourly=temperature_2m,weather_code,precipitation_probability,is_day" +
                "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
                `&timezone=auto&forecast_days=7&forecast_hours=${HOURS + 1}` +
                (f ? "&temperature_unit=fahrenheit&wind_speed_unit=mph" : "");
            if (moved) this.data = null;   // don't show the old city's weather under the new name
            this._curl(url, json => {
                if (json && json.current) {
                    this.data = json;
                    this.fetchedAt = Date.now();
                    this.failed = false;
                } else {
                    this.failed = true;   // keep showing the last data we had
                    this.error = "Weather unavailable. Check your connection.";
                }
                this._render();
            });
        });
    }

    // Saving a setting from inside the applet doesn't fire its change
    // callback (only edits from the Configure window do), so refresh here.
    _setCity(text) {
        this.settings.setValue("city", text);
        this.city = text;
        this._fetch();
    }

    // Search box at the top of the popup: Enter looks up the city and switches to it
    _buildSearch() {
        let entry = new St.Entry({ hint_text: "Search city…", can_focus: true, x_expand: true,
            style: "border-radius: 10px; padding: 5px 10px; background-color: rgba(128,128,128,0.18); border: none;" });
        entry.clutter_text.connect("activate", () => {
            let text = entry.get_text().trim();
            if (!text) return;
            entry.set_text("");
            entry.hint_text = "Searching…";
            this._geocode(text, place => {
                entry.hint_text = "Search city…";
                if (!place) { this.searchNote = `No place called "${text}" was found.`; this._render(); return; }
                this.searchNote = null;
                this._setCity(text);
            });
        });
        let row = new St.BoxLayout({ vertical: false, style: "spacing: 6px;" });
        row.add_child(entry);
        if ((this.city || "").trim()) {
            // back to automatic location
            let auto = new St.Button({ reactive: true, track_hover: true, style: "padding: 4px 6px; border-radius: 8px;",
                child: new St.Icon({ icon_name: "find-location-symbolic", icon_type: St.IconType.SYMBOLIC, icon_size: 16 }) });
            auto.connect("clicked", () => this._setCity(""));
            new imports.ui.tooltips.Tooltip(auto, "Use my location");
            row.add_child(auto);
        }
        this.content.add_child(row);
        if (this.searchNote) this.content.add_child(label(this.searchNote, "font-size: 9pt; color: #ff6961;"));
    }

    _hour(iso) {
        let d = new Date(iso);
        if (this.iface.get_boolean("clock-use-24h")) return d.toLocaleFormat("%H");
        return d.toLocaleFormat("%-l%p").toLowerCase();
    }

    _render() {
        let light = !/dark/i.test(this.themeSettings.get_string("name"));
        let pal = glassPalette(light);
        if (this._glass.active) this.menu.box.style = pal.sheet + " border-radius: 20px; padding: 10px 0;";
        this.content.destroy_all_children();
        this._buildSearch();

        let d = this.data;
        if (!d) {
            this.set_applet_label("--°");
            let msg = label(this.failed ? (this.error || "Weather unavailable. Check your connection.") : "Loading weather…",
                            "padding: 12px 0;", true);
            msg.clutter_text.line_wrap = true;
            this.content.add_child(msg);
            return;
        }

        let c = d.current, day = d.daily;
        let [iconName, text] = describe(c.weather_code, c.is_day);
        let deg = v => `${Math.round(v)}°`;
        this.set_applet_icon_symbolic_name(iconName + "-symbolic");
        this.set_applet_label(deg(c.temperature_2m));
        this.set_applet_tooltip(`${this._placeName()}: ${text}, ${deg(c.temperature_2m)}`);

        // Header: place, big temperature, condition, high/low
        let header = new St.BoxLayout({ vertical: false, style: "spacing: 12px;" });
        let left = new St.BoxLayout({ vertical: true, x_expand: true });
        left.add_child(label(this._placeName(), "font-weight: bold; font-size: 12pt;"));
        left.add_child(label(deg(c.temperature_2m), "font-size: 34pt; font-weight: 300;"));
        header.add_child(left);
        let right = new St.BoxLayout({ vertical: true, y_align: Clutter.ActorAlign.END, style: "spacing: 2px;" });
        let ic = icon(iconName, 32);
        ic.x_align = Clutter.ActorAlign.END;
        right.add_child(ic);
        let cond = label(text, "font-weight: bold; text-align: right;");
        cond.x_align = Clutter.ActorAlign.END;
        right.add_child(cond);
        let hl = label(`H:${deg(day.temperature_2m_max[0])}  L:${deg(day.temperature_2m_min[0])}`, "text-align: right;", true);
        hl.x_align = Clutter.ActorAlign.END;
        right.add_child(hl);
        header.add_child(right);
        this.content.add_child(header);

        let wind = this.units === "fahrenheit" ? "mph" : "km/h";
        this.content.add_child(label(`Feels like ${deg(c.apparent_temperature)}  ·  Humidity ${c.relative_humidity_2m}%  ·  ` +
                                     `Wind ${Math.round(c.wind_speed_10m)} ${wind}`, "font-size: 9pt;", true));

        // Hourly strip
        let hourly = new St.BoxLayout({ vertical: false, style: pal.pane + " border-radius: 16px; padding: 10px 8px;" });
        let h = d.hourly;
        let step = 2;
        for (let i = 0; i <= HOURS && i < h.time.length; i += step) {
            let col = new St.BoxLayout({ vertical: true, x_expand: true, style: "spacing: 6px;" });
            let t = label(i === 0 ? "Now" : this._hour(h.time[i]), "font-size: 8.5pt; text-align: center;", true);
            t.x_align = Clutter.ActorAlign.CENTER;
            col.add_child(t);
            let hi = icon(describe(h.weather_code[i], h.is_day[i])[0], 20);
            hi.x_align = Clutter.ActorAlign.CENTER;
            col.add_child(hi);
            let rain = h.precipitation_probability[i];
            let rl = label(rain >= 20 ? `${rain}%` : " ", "font-size: 7.5pt; color: #5ac8fa; text-align: center;");
            rl.x_align = Clutter.ActorAlign.CENTER;
            col.add_child(rl);
            let tl = label(deg(h.temperature_2m[i]), "font-weight: bold; text-align: center;");
            tl.x_align = Clutter.ActorAlign.CENTER;
            col.add_child(tl);
            hourly.add_child(col);
        }
        this.content.add_child(hourly);

        // 7-day forecast with temperature range bars
        let daily = new St.BoxLayout({ vertical: true, style: pal.pane + " border-radius: 16px; padding: 8px 12px; spacing: 6px;" });
        let lo = Math.min(...day.temperature_2m_min), hi = Math.max(...day.temperature_2m_max);
        const BAR = 90;
        for (let i = 0; i < day.time.length; i++) {
            let row = new St.BoxLayout({ vertical: false, style: "spacing: 8px;" });
            let name = i === 0 ? "Today" : new Date(day.time[i] + "T12:00").toLocaleFormat("%a");
            row.add_child(label(name, "width: 48px; font-weight: bold;"));
            let di = icon(describe(day.weather_code[i], 1)[0], 18);
            di.y_align = Clutter.ActorAlign.CENTER;
            row.add_child(di);
            let rain = day.precipitation_probability_max[i];
            row.add_child(label(rain >= 20 ? `${rain}%` : "", "width: 34px; font-size: 8.5pt; color: #5ac8fa;"));
            let min = label(deg(day.temperature_2m_min[i]), "width: 30px; text-align: right;", true);
            min.x_expand = true;
            row.add_child(min);
            // range bar: where this day's low..high sits within the week's range
            let span = Math.max(1, hi - lo);
            let start = Math.round((day.temperature_2m_min[i] - lo) / span * BAR);
            let len = Math.max(6, Math.round((day.temperature_2m_max[i] - day.temperature_2m_min[i]) / span * BAR));
            let track = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER,
                style: `width: ${BAR}px; height: 4px; border-radius: 2px; background-color: rgba(128,128,128,0.30);` });
            track.add_child(new St.Widget({ style: `width: ${Math.min(start, BAR - len)}px;` }));
            track.add_child(new St.Widget({ style: `width: ${len}px; height: 4px; border-radius: 2px;` +
                " background-gradient-direction: horizontal; background-gradient-start: #5ac8fa; background-gradient-end: #ff9f0a;" }));
            row.add_child(track);
            row.add_child(label(deg(day.temperature_2m_max[i]), "width: 30px; text-align: right; font-weight: bold;"));
            daily.add_child(row);
        }
        this.content.add_child(daily);

        let when = this.fetchedAt ? new Date(this.fetchedAt).toLocaleFormat("%H:%M") : "—";
        this.content.add_child(label(`${this.failed ? "Offline · last update " : "Updated "}${when} · Open-Meteo`,
                                     "font-size: 8pt; text-align: center;", true));
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new WeatherApplet(metadata, orientation, panelHeight, instanceId);
}
