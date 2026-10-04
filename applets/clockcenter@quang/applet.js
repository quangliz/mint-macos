const Applet = imports.ui.applet;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Clutter = imports.gi.Clutter;
const St = imports.gi.St;
const Util = imports.misc.util;
const PopupMenu = imports.ui.popupMenu;
const UPowerGlib = imports.gi.UPowerGlib;
const Settings = imports.ui.settings;
const Calendar = require('./calendar');
const EventView = require('./eventView');
const CinnamonDesktop = imports.gi.CinnamonDesktop;
const Main = imports.ui.main;
const Separator = imports.ui.separator;
const MessageTray = imports.ui.messageTray;
const Urgency = imports.ui.messageTray.Urgency;
const NotificationDestroyedReason = imports.ui.messageTray.NotificationDestroyedReason;
const UUID = "clockcenter@quang";
const Glass = require('./glass');

const DAY_FORMAT = CinnamonDesktop.WallClock.lctime_format("cinnamon", "%A");
const DATE_FORMAT_SHORT = CinnamonDesktop.WallClock.lctime_format("cinnamon", _("%B %-e, %Y"));
const DATE_FORMAT_FULL = CinnamonDesktop.WallClock.lctime_format("cinnamon", _("%A, %B %-e, %Y"));

class CinnamonCalendarApplet extends Applet.TextApplet {
    constructor(orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.setAllowedLayout(Applet.AllowedLayout.BOTH);

        try {
            this.menuManager = new PopupMenu.PopupMenuManager(this);
            this.orientation = orientation;

            this._initContextMenu();
            this.menu.setCustomStyleClass('calendar-background');

            this.settings = new Settings.AppletSettings(this, UUID, this.instance_id);
            this.desktop_settings = new Gio.Settings({ schema_id: "org.cinnamon.desktop.interface" });

            this.clock = new CinnamonDesktop.WallClock();
            this.clock_notify_id = 0;

            // Events
            this.events_manager = new EventView.EventsManager(this.settings, this.desktop_settings);
            this.events_manager.connect("events-manager-ready", this._events_manager_ready.bind(this));
            this.events_manager.connect("has-calendars-changed", this._has_calendars_changed.bind(this));

            this._buildNotificationSection();

            let box = new St.BoxLayout(
                {
                    style_class: 'calendar-main-box',
                    vertical: false
                }
            );
            this.menu.addActor(box);

            this.event_list = this.events_manager.get_event_list();
            this.event_list.connect("launched-calendar", Lang.bind(this.menu, this.menu.toggle));

            // hack to allow event list scrollbar to be dragged.
            this.event_list.connect("start-pass-events", Lang.bind(this.menu, () => {
                this.menu.passEvents = true;
            }));
            this.event_list.connect("stop-pass-events", Lang.bind(this.menu, () => {
                this.menu.passEvents = false;
            }));

            box.add_actor(this.event_list.actor);

            let calbox = new St.BoxLayout(
                {
                    vertical: true,
                    style_class: "ccn-calendar-card",
                    x_expand: true
                }
            );

            this.go_home_button = new St.BoxLayout(
                {
                    style_class: "calendar-today-home-button",
                    x_align: Clutter.ActorAlign.CENTER,
                    reactive: true,
                    vertical: true
                }
            );

            this.go_home_button.connect("enter-event", Lang.bind(this, (actor, event) => {
                actor.add_style_pseudo_class("hover");
            }));

            this.go_home_button.connect("leave-event", Lang.bind(this, (actor, event) => {
                actor.remove_style_pseudo_class("hover");
            }));

            this.go_home_button.connect("button-press-event", Lang.bind(this, (actor, event) => {
                if (event.get_button() == Clutter.BUTTON_PRIMARY) {
                    return Clutter.EVENT_STOP;
                }
            }));

            this.go_home_button.connect("button-release-event", Lang.bind(this, (actor, event) => {
                if (event.get_button() == Clutter.BUTTON_PRIMARY) {
                    // button immediately becomes non-reactive, so leave-event will never fire.
                    actor.remove_style_pseudo_class("hover");
                    this._resetCalendar();
                    return Clutter.EVENT_STOP;
                }
            }));

            calbox.add_actor(this.go_home_button);
            this.go_home_button.hide();

            // Calendar
            this._day = new St.Label(
                {
                    style_class: "calendar-today-day-label"
                }
            );
            this.go_home_button.add_actor(this._day);

            // Date
            this._date = new St.Label(
                {
                    style_class: "calendar-today-date-label"
                }
            );
            this.go_home_button.add_actor(this._date);

            this._calendar = new Calendar.Calendar(this.settings, this.events_manager);
            this._calendar.connect("selected-date-changed", Lang.bind(this, this._updateClockAndDate));
            calbox.add_actor(this._calendar.actor);
            this._buildDayEvents(calbox);

            box.add_actor(calbox);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            let item = new PopupMenu.PopupMenuItem(_("Date and Time Settings"));
            item.connect("activate", Lang.bind(this, this._onLaunchSettings));

            this.menu.addMenuItem(item);

            this.settings.bind("show-events", "show_events", this._onSettingsChanged);
            this.settings.bind("use-custom-format", "use_custom_format", this._onSettingsChanged);
            this.settings.bind("custom-format", "custom_format", this._onSettingsChanged);
            this.settings.bind("custom-tooltip-format", "custom_tooltip_format", this._onSettingsChanged);
            this.settings.bind("keyOpen", "keyOpen", this._setKeybinding);
            this.settings.bind("keyNotif", "keyNotif", this._setKeybinding);
            this.settings.bind("keyClear", "keyClear", this._setKeybinding);
            this.settings.bind("ignoreTransientNotifications", "ignoreTransientNotifications");
            this.settings.bind("showNewestFirst", "showNewestFirst", this._updateNotifications);
            Main.messageTray.connect('notify-applet-update', (tray, n) => this._notificationAdded(n));
            this._setKeybinding();

            /* FIXME: Add gobject properties to the WallClock class to allow easier access from
             * its clients, and possibly a separate signal to notify of updates to these properties
             * (though GObject "changed" would be sufficient.) */
            this.desktop_settings.connect("changed::clock-use-24h", Lang.bind(this, function (key) {
                this._onSettingsChanged();
            }));
            this.desktop_settings.connect("changed::clock-show-seconds", Lang.bind(this, function (key) {
                this._onSettingsChanged();
            }));

            // https://bugzilla.gnome.org/show_bug.cgi?id=655129
            this._upClient = new UPowerGlib.Client();
            try {
                this._upClient.connect('notify-resume', Lang.bind(this, this._updateClockAndDate));
            } catch (e) {
                this._upClient.connect('notify::resume', Lang.bind(this, this._updateClockAndDate));
            }

            // Change the format string if the mouse is over the calender to account for the tooltip.
            this._is_entered = false;
            this.actor.connect('enter-event', Lang.bind(this, function (menu, event) {
                this._is_entered = true;
                this._updateFormatString();
            }))
            this.actor.connect('leave-event', Lang.bind(this, function (menu, event) {
                this._is_entered = false;
                this._updateFormatString();
            }))
        }
        catch (e) {
            global.logError(e);
        }
    }

    _setKeybinding() {
        Main.keybindingManager.addXletHotKey(this, "calendar-open", this.keyOpen, Lang.bind(this, this._openMenu));
        if (this.keyNotif) Main.keybindingManager.addXletHotKey(this, "notification-open", this.keyNotif, Lang.bind(this, this._openMenu));
        if (this.keyClear) Main.keybindingManager.addXletHotKey(this, "notification-clear", this.keyClear, Lang.bind(this, this._clearNotifications));
    }

    // ---------- Selected day's events (inside the calendar card) ----------
    _buildDayEvents(calbox) {
        calbox.add_actor(new St.Widget({ style_class: "ccn-day-sep" }));
        let header = new St.BoxLayout({ vertical: false, style_class: "ccn-day-header" });
        this._dayTitle = new St.Label({ style_class: "ccn-day-title", x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        header.add_child(this._dayTitle);
        let open = new St.Button({ label: _("Open Calendar"), style_class: "ccn-link", reactive: true, track_hover: true });
        open.connect("clicked", () => {
            let gdate = EventView.js_date_to_gdatetime(this._calendar.getSelectedDate());
            this.menu.close();
            Util.trySpawn(["gnome-calendar", "--date", gdate.format("%x")], false);
        });
        header.add_child(open);
        calbox.add_actor(header);

        this._dayEvents = new St.BoxLayout({ vertical: true, style_class: "ccn-day-events" });
        calbox.add_actor(this._dayEvents);

        this._calendar.connect("selected-date-changed", () => this._renderDayEvents());
        this.events_manager.connect("events-updated", () => this._renderDayEvents());
        this.events_manager.connect("events-manager-ready", () => this._renderDayEvents());
    }

    _renderDayEvents() {
        if (!this._dayEvents) return;
        let jsDate = this._calendar.getSelectedDate();
        let today = new Date();
        let isToday = jsDate.toDateString() === today.toDateString();
        this._dayTitle.text = isToday ? _("Today") : jsDate.toLocaleFormat("%A, %-d %B").capitalize();

        this._dayEvents.destroy_all_children();
        let key = EventView.date_only(EventView.js_date_to_gdatetime(jsDate)).to_unix();
        let list = this.events_manager.events_by_date[key];
        let events = list ? Object.values(list._events) : [];
        events.sort((x, y) => (y.all_day - x.all_day) || x.start.compare(y.start));

        if (!events.length) {
            this._dayEvents.add_child(new St.Label({ text: _("No events"), style_class: "ccn-day-empty" }));
            return;
        }
        for (let ev of events.slice(0, 5)) {
            let row = new St.Button({ reactive: true, track_hover: true, style_class: "ccn-event-row", x_fill: true });
            let box = new St.BoxLayout({ vertical: false, style: "spacing: 8px;" });
            box.add_child(new St.Widget({ style_class: "ccn-event-dot", y_align: Clutter.ActorAlign.CENTER,
                                          style: `background-color: ${ev.color || "#1f9ede"};` }));
            box.add_child(new St.Label({ text: ev.all_day ? _("All day") : ev.start.format("%H:%M"),
                                         style_class: "ccn-event-time", y_align: Clutter.ActorAlign.CENTER }));
            let title = new St.Label({ text: ev.summary || "", x_expand: true, y_align: Clutter.ActorAlign.CENTER });
            title.clutter_text.ellipsize = imports.gi.Pango.EllipsizeMode.END;
            box.add_child(title);
            row.set_child(box);
            row.connect("clicked", () => {
                this.menu.close();
                Util.trySpawn(["gnome-calendar", "--uuid", ev.id], false);
            });
            this._dayEvents.add_child(row);
        }
        if (events.length > 5)
            this._dayEvents.add_child(new St.Label({ text: `+${events.length - 5} more`, style_class: "ccn-day-empty" }));
    }

    // ---------- Notification Center ----------
    _buildNotificationSection() {
        this.notifications = [];
        // Scope our stylesheet to this popup only
        this.menu.box.add_style_class_name("ccn");
        // Frosted glass sheet behind the content (ccn-glass styles the sheet itself)
        this._glass = new Glass.GlassBackdrop(this.menu, { radius: 20, gap: 6 });
        if (this._glass.active) this.menu.box.add_style_class_name("ccn-glass");
        // Light glass when the Cinnamon theme is light (the Dark Mode tile switches it)
        this._themeSettings = new Gio.Settings({ schema_id: "org.cinnamon.theme" });
        let applyMode = () => {
            if (/dark/i.test(this._themeSettings.get_string("name"))) this.menu.box.remove_style_class_name("ccn-light");
            else this.menu.box.add_style_class_name("ccn-light");
        };
        this._themeId = this._themeSettings.connect("changed::name", applyMode);
        applyMode();
        this._loadStylesheet();

        let section = new St.BoxLayout({ vertical: true, style_class: "ccn-section" });

        let header = new St.BoxLayout({ vertical: false, style_class: "ccn-header" });
        header.add_child(new St.Label({ text: _("Notifications"), x_expand: true,
                                        y_align: Clutter.ActorAlign.CENTER, style_class: "ccn-title" }));
        this._clearBtn = new St.Button({ label: _("Clear All"), reactive: true, track_hover: true, style_class: "ccn-pill" });
        this._clearBtn.connect("clicked", () => this._clearNotifications());
        header.add_child(this._clearBtn);
        section.add_child(header);

        this._emptyLabel = new St.Label({ text: _("No Notifications"), x_align: Clutter.ActorAlign.CENTER,
                                          style_class: "ccn-empty" });
        section.add_child(this._emptyLabel);

        this._notifBin = new St.BoxLayout({ vertical: true, style_class: "ccn-list" });
        this._notifScroll = new St.ScrollView({ x_fill: true, y_fill: true, y_align: St.Align.START,
                                                style_class: "vfade ccn-scroll" });
        this._notifScroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this._notifScroll.add_actor(this._notifBin);
        let vscroll = this._notifScroll.get_vscroll_bar();
        vscroll.connect('scroll-start', () => { this.menu.passEvents = true; });
        vscroll.connect('scroll-stop', () => { this.menu.passEvents = false; });
        section.add_child(this._notifScroll);

        this.menu.addActor(section);
        this._updateNotifications();
    }

    // St caches stylesheets by path, so an edited ccn.css would be
    // ignored after an applet reload. Load a copy named after its checksum
    // instead, so every change gets a fresh path.
    _loadStylesheet() {
        let src = GLib.build_filenamev([this._meta_path, "ccn.css"]);  // not "stylesheet.css": Cinnamon auto-loads that name
        let theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
        try {
            let [, bytes] = GLib.file_get_contents(src);
            let sum = GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, bytes).slice(0, 12);
            let dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), "clockcenter"]);
            GLib.mkdir_with_parents(dir, 0o700);
            this._stylesheet = GLib.build_filenamev([dir, `stylesheet-${sum}.css`]);
            if (!GLib.file_test(this._stylesheet, GLib.FileTest.EXISTS))
                GLib.file_set_contents(this._stylesheet, bytes);
            theme.load_stylesheet(this._stylesheet);
        } catch (e) {
            global.logError("clockcenter: could not load stylesheet: " + e);
        }
    }

    _unloadStylesheet() {
        try {
            St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._stylesheet);
        } catch (e) {}
    }

    // The message tray hands us each notification once its banner is done.
    // We keep the notification object (it owns the app callbacks) but draw
    // our own card for it instead of using the theme's notification widget.
    _notificationAdded(notification) {
        if (this.ignoreTransientNotifications && notification.isTransient) {
            notification.destroy();
            return;
        }
        let parent = notification.actor.get_parent();
        if (parent) parent.remove_child(notification.actor);
        notification._inNotificationBin = true;

        if (notification._destroyed) {
            let i = this.notifications.indexOf(notification);
            if (i != -1) this.notifications.splice(i, 1);
        } else if (this.notifications.indexOf(notification) == -1) {
            this.notifications.push(notification);
            notification.connect('destroy', () => {
                let i = this.notifications.indexOf(notification);
                if (i != -1) this.notifications.splice(i, 1);
                this._updateNotifications();
            });
        }
        this._updateNotifications();
    }

    _relativeTime(date) {
        let diff = Math.floor((Date.now() - date.getTime()) / 1000);
        if (diff < 60) return _("now");
        if (diff < 3600) return Math.floor(diff / 60) + "m ago";
        if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
        return date.toLocaleFormat("%-d %b");
    }

    // The notification's own icon actor lives inside its original widget,
    // so build a fresh one with the same image.
    _cardIcon(n) {
        let src = n._icon;
        let gicon = src && src.gicon;
        let name = src && src.icon_name;
        let symbolic = !gicon && (!name || /-symbolic$/.test(name));
        if (!gicon && !name) name = "dialog-information-symbolic";
        return new St.Icon({ gicon: gicon || null, icon_name: gicon ? null : name,
                             icon_type: symbolic ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR,
                             icon_size: symbolic ? 16 : 32 });
    }

    _makeCard(n) {
        let card = new St.Button({ reactive: true, track_hover: true, can_focus: true, style_class: "ccn-card",
                                   x_fill: true, x_expand: true });
        let row = new St.BoxLayout({ vertical: false, x_expand: true, style_class: "ccn-card-row" });
        card.set_child(row);

        let iconBin = new St.Bin({ style_class: "ccn-card-icon", y_align: St.Align.START });
        let icon = this._cardIcon(n);
        if (icon.icon_type === St.IconType.SYMBOLIC) iconBin.add_style_class_name("ccn-card-icon-symbolic");
        iconBin.set_child(icon);
        // A vertical box keeps the icon at its own height instead of stretching to the row
        let iconCol = new St.BoxLayout({ vertical: true });
        iconCol.add_child(iconBin);
        row.add_child(iconCol);

        let col = new St.BoxLayout({ vertical: true, x_expand: true, style_class: "ccn-card-text" });
        let top = new St.BoxLayout({ vertical: false });
        let app = new St.Label({ text: (n.source && n.source.title) || "", x_expand: true, style_class: "ccn-card-app" });
        let time = new St.Label({ text: this._relativeTime(n._timestamp), style_class: "ccn-card-time" });
        let close = new St.Button({ reactive: true, track_hover: true, style_class: "ccn-card-close", opacity: 0,
                                    child: new St.Icon({ icon_name: "window-close-symbolic", icon_type: St.IconType.SYMBOLIC, icon_size: 12 }) });
        close.connect("clicked", () => n.destroy(NotificationDestroyedReason.DISMISSED));
        top.add_child(app);
        top.add_child(time);
        top.add_child(close);
        col.add_child(top);

        let title = new St.Label({ style_class: "ccn-card-heading" });
        title.clutter_text.line_wrap = true;
        title.clutter_text.set_markup(n.title || "");
        col.add_child(title);

        let bodyText = "";
        try { bodyText = n._bodyUrlHighlighter ? n._bodyUrlHighlighter.actor.clutter_text.get_text() : ""; } catch (e) {}
        if (bodyText) {
            let body = new St.Label({ text: bodyText, style_class: "ccn-card-body" });
            body.clutter_text.line_wrap = true;
            col.add_child(body);
        }
        row.add_child(col);

        // Show the close button only while hovering, like macOS
        card.connect("notify::hover", () => { close.opacity = card.hover ? 200 : 0; time.visible = !card.hover; });
        card.connect("clicked", () => {
            this.menu.close();
            n._onClicked();
        });
        return card;
    }

    _updateNotifications() {
        if (!this._notifBin) return;
        this._notifBin.destroy_all_children();
        let list = this.notifications.slice();
        if (this.showNewestFirst) list.reverse();
        for (let n of list) this._notifBin.add_child(this._makeCard(n));

        let count = this.notifications.length;
        this._emptyLabel.visible = count === 0;
        this._notifScroll.visible = count > 0;
        // Only reserve scrollbar space when the list can actually scroll
        this._notifScroll.vscrollbar_policy = count > 4 ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER;
        this._clearBtn.visible = count > 0;
        if (this._calendar) this._updateClockAndDate();
    }

    _clearNotifications() {
        let list = this.notifications.slice();
        this.notifications = [];
        for (let n of list) n.destroy(NotificationDestroyedReason.DISMISSED);
        this._updateNotifications();
    }

    _refreshTimestamps() {
        // Cards show relative times; rebuilding is cheap
        this._updateNotifications();
    }

    _clockNotify(obj, pspec, data) {
        this._updateClockAndDate();
    }

    on_applet_clicked(event) {
        this._openMenu();
    }

    _openMenu() {
        this._refreshTimestamps();
        this.menu.toggle();
    }

    _onSettingsChanged() {
        this._updateFormatString();
        this._updateClockAndDate();
        this.event_list.actor.visible = false;  // compact list under the calendar instead
        this.events_manager.select_date(this._calendar.getSelectedDate(), true);
    }

    on_custom_format_button_pressed() {
        Util.spawnCommandLine("xdg-open https://cinnamon-spices.linuxmint.com/strftime.php");
    }

    _onLaunchSettings() {
        this.menu.close();
        Util.spawnCommandLine("cinnamon-settings calendar");
    }

    _updateFormatString() {
        let in_vertical_panel = (this.orientation == St.Side.LEFT || this.orientation == St.Side.RIGHT);

        if (this.use_custom_format) {
            let custom_format = this.custom_format;

            /* The frequency that the clock updates is based on the format string.
             * Thus, when the tooltip is displayed, we join the regular custom format string
             * with the custom tooltip format. That way, the format string is guaranteed
             * to contain whatever has the finest resolution between them. */
            if (this._is_entered) {
                custom_format += this.custom_tooltip_format;
            }

            if (!this.clock.set_format_string(custom_format)) {
                global.logError("Calendar applet: bad time format string - check your string.");
                this.clock.set_format_string("~CLOCK FORMAT ERROR~ %l:%M %p");
            }
        } else if (in_vertical_panel) {
            let use_24h = this.desktop_settings.get_boolean("clock-use-24h");
            let show_seconds = this.desktop_settings.get_boolean("clock-show-seconds");

            if (use_24h) {
                if (show_seconds) {
                    this.clock.set_format_string("%H%n%M%n%S");
                } else {
                    this.clock.set_format_string("%H%n%M%");
                }
            } else {
                if (show_seconds) {
                    this.clock.set_format_string("%l%n%M%n%S");
                } else {
                    this.clock.set_format_string("%l%n%M%");
                }
            }
        } else {
            this.clock.set_format_string(null);
        }
    }

    _events_manager_ready(em) {
        this.event_list.actor.visible = false;  // compact list under the calendar instead
        this.events_manager.select_date(this._calendar.getSelectedDate(), true);
    }

    _has_calendars_changed(em) {
        this.event_list.actor.visible = false;  // compact list under the calendar instead
    }

    _updateClockAndDate() {
        let label_string = this.clock.get_clock();

        if (!this.use_custom_format) {
            label_string = label_string.capitalize();
        }
        else if (this._is_entered) {
            label_string = this.clock.get_clock_for_format(this.custom_format);
        }

        this.go_home_button.reactive = !this._calendar.todaySelected();
        if (this._calendar.todaySelected()) {
            this.go_home_button.reactive = false;
            this.go_home_button.set_style_class_name("calendar-today-home-button");
        } else {
            this.go_home_button.reactive = true;
            this.go_home_button.set_style_class_name("calendar-today-home-button-enabled");
        }

        // Unread badge before the clock, e.g. "● 3   Sun 4 Oct  02:10"
        let unread = this.notifications ? this.notifications.length : 0;
        this.set_applet_label(unread ? `● ${unread}   ${label_string}` : label_string);

        let dateFormattedTooltip = this.clock.get_clock_for_format(DATE_FORMAT_FULL).capitalize();
        if (this.use_custom_format) {
            dateFormattedTooltip = this.clock.get_clock_for_format(this.custom_tooltip_format).capitalize();
            if (!dateFormattedTooltip) {
                global.logError("Calendar applet: bad tooltip time format string - check your string.");
                dateFormattedTooltip = this.clock.get_clock_for_format("~CLOCK FORMAT ERROR~ %l:%M %p");
            }
        }

        let dateFormattedShort = this.clock.get_clock_for_format(DATE_FORMAT_SHORT).capitalize();
        let dayFormatted = this.clock.get_clock_for_format(DAY_FORMAT).capitalize();

        this._day.set_text(dayFormatted);
        this._date.set_text(dateFormattedShort);
        this.set_applet_tooltip(dateFormattedTooltip);

        this.events_manager.select_date(this._calendar.getSelectedDate());
    }

    on_applet_added_to_panel() {
        MessageTray.extensionsHandlingNotifications++;
        this._onSettingsChanged();

        if (this.clock_notify_id == 0) {
            this.clock_notify_id = this.clock.connect("notify::clock", () => this._clockNotify());
        }

        /* Populates the calendar so our menu allocation is correct for animation */
        this.events_manager.start_events();
        this._resetCalendar();
    }

    on_applet_removed_from_panel() {
        Main.keybindingManager.removeXletHotKey(this, "calendar-open");
        Main.keybindingManager.removeXletHotKey(this, "notification-open");
        Main.keybindingManager.removeXletHotKey(this, "notification-clear");
        this._unloadStylesheet();
        if (this._glass) this._glass.destroy();
        if (this._themeId) this._themeSettings.disconnect(this._themeId);
        MessageTray.extensionsHandlingNotifications--;
        if (MessageTray.extensionsHandlingNotifications === 0) this._clearNotifications();
        if (this.clock_notify_id > 0) {
            this.clock.disconnect(this.clock_notify_id);
            this.clock_notify_id = 0;
        }
    }

    _initContextMenu() {
        this.menu = new Applet.AppletPopupMenu(this, this.orientation);
        this.menuManager.addMenu(this.menu);

        // Whenever the menu is opened, select today
        this.menu.connect('open-state-changed', Lang.bind(this, function (menu, isOpen) {
            if (isOpen) {
                this._resetCalendar();
                this.events_manager.select_date(this._calendar.getSelectedDate(), true);
            }
        }));
    }

    _resetCalendar() {
        this._calendar.setDate(new Date(), true);
    }

    on_orientation_changed(orientation) {
        this.orientation = orientation;
        this.menu.setOrientation(orientation);
        this._onSettingsChanged();
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    CinnamonCalendarApplet.prototype._meta_path = metadata.path;
    return new CinnamonCalendarApplet(orientation, panel_height, instance_id);
}
