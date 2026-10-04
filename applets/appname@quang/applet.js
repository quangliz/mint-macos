const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Cinnamon = imports.gi.Cinnamon;
const Meta = imports.gi.Meta;

class AppName extends Applet.TextApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this._applet_label.style = "font-weight: bold;";
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
        let name = this.app ? this.app.get_name() : (win ? win.get_wm_class() || win.get_title() : "Desktop");
        this.set_applet_label(name || "");
        this.quitItem.label.text = this.app ? `Quit ${this.app.get_name()}` : "Quit";
        for (let it of [this.hideItem, this.closeItem, this.quitItem]) it.setSensitive(!!win);
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        global.display.disconnect(this.focusId);
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new AppName(metadata, orientation, panelHeight, instanceId);
}
