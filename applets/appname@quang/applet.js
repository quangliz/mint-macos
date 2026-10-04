const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Cinnamon = imports.gi.Cinnamon;
const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;

// Longest window title shown before it is cut off with "…"
const MAX_LABEL_WIDTH = 640;

class AppName extends Applet.TextApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this._applet_label.style = `max-width: ${MAX_LABEL_WIDTH}px;`;
        this._applet_label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.tracker = Cinnamon.WindowTracker.get_default();

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);
        this.hideItem = this.menu.addAction("Hide", () => { if (this.win) this.win.minimize(); });
        this.closeItem = this.menu.addAction("Close Window", () => { if (this.win) this.win.delete(global.get_current_time()); });
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.quitItem = this.menu.addAction("Quit", () => {
            if (this.app) this.app.request_quit();
            else if (this.win) this.win.delete(global.get_current_time());
        });

        this.titleWin = null;
        this.titleId = 0;
        this.focusId = global.display.connect("notify::focus-window", () => this._update());
        this._update();
    }

    _update() {
        let win = global.display.focus_window;
        // Ignore the desktop and panels, like Finder showing when nothing is focused
        if (win && (win.get_window_type() === Meta.WindowType.DESKTOP || win.get_window_type() === Meta.WindowType.DOCK))
            win = null;
        this.win = win;
        this.app = win ? this.tracker.get_window_app(win) : null;
        this._watchTitle(win);
        this._render();
        this.quitItem.label.text = this.app ? `Quit ${this._shortName(this.app.get_name())}` : "Quit";
        for (let it of [this.hideItem, this.closeItem, this.quitItem]) it.setSensitive(!!win);
    }

    // Follow title changes of the focused window (tab switches, opened files…)
    _watchTitle(win) {
        if (this.titleWin === win) return;
        if (this.titleWin && this.titleId) this.titleWin.disconnect(this.titleId);
        this.titleWin = win;
        this.titleId = win ? win.connect("notify::title", () => this._render()) : 0;
    }

    // Short, macOS-like app name: "Firefox Web Browser" -> "Firefox"
    _shortName(name) {
        return (name || "").replace(/\s+(Web Browser|Browser|Text Editor|File Manager)$/i, "");
    }

    // Window title without trailing parts that just repeat the app
    // ("… — Mozilla Firefox") or a browser profile ("… — Original profile").
    _cleanTitle(title, name, wmClass) {
        title = (title || "").trim();
        // whole words from the app name and window class, minus reverse-DNS noise
        const NOISE = ["com", "org", "net", "io", "md", "desktop", "app"];
        const words = s => s.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
        let keys = words(`${name} ${wmClass || ""}`).filter(k => !NOISE.includes(k));
        let appish = seg => {
            let w = words(seg);
            return w.some(x => keys.includes(x)) || /\bprofile$/i.test(seg.trim());
        };
        let m;
        while ((m = title.match(/^(.*\S)\s+[-–—|·]\s+([^-–—|·]+)$/)) && appish(m[2]))
            title = m[1];
        return appish(title) && title.length <= name.length + 12 ? "" : title;
    }

    _render() {
        let win = this.win;
        let name = this._shortName(this.app ? this.app.get_name() : (win ? win.get_wm_class() || "" : "Desktop"));
        let title = win ? this._cleanTitle(win.get_title(), name, win.get_wm_class()) : "";
        let esc = s => GLib.markup_escape_text(s, -1);
        let markup = `<b>${esc(name || "")}</b>`;
        if (title) markup += `   <span alpha="70%">${esc(title)}</span>`;
        this._applet_label.clutter_text.set_markup(markup);
        this.set_applet_tooltip(win ? (win.get_title() || name) : "");
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        global.display.disconnect(this.focusId);
        this._watchTitle(null);
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new AppName(metadata, orientation, panelHeight, instanceId);
}
