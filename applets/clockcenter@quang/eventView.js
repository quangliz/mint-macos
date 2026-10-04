// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// Calendar events from Evolution Data Server, via Cinnamon's calendar
// server. Taken from Cinnamon's calendar applet, without its event list
// widget: the clock panel draws its own Up Next and day lists.

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Lang = imports.lang;
const Signals = imports.signals;
const Cinnamon = imports.gi.Cinnamon;
const Mainloop = imports.mainloop;

const STATUS_UNKNOWN = 0;
const STATUS_NO_CALENDARS = 1;
const STATUS_HAS_CALENDARS = 2;

const EDS_BUS_NAME = "org.gnome.evolution.dataserver.Calendar8"

function js_date_to_gdatetime(js_date) {
    let unix = js_date.getTime() / 1000; // getTime returns ms
    return GLib.DateTime.new_from_unix_local(unix);
}

function date_only(gdatetime) {
    let date = GLib.DateTime.new_local(
        gdatetime.get_year(),
        gdatetime.get_month(),
        gdatetime.get_day_of_month(), 0, 0, 0
    );

    return date;
}

function month_year_only(gdatetime) {
    let month_year_only = GLib.DateTime.new_local(
        gdatetime.get_year(),
        gdatetime.get_month(),
        1, 0, 0, 0
    );

    return month_year_only;
}

// GLib.DateTime.equal is broken
function dt_equals(dt1, dt2) {
    return dt1.to_unix() === dt2.to_unix();
}

class EventData {
    constructor(data_var, last_update_timestamp) {
        const [id, color, summary, all_day, start_time, end_time, mod_time] = data_var.deep_unpack();
        this.id = id;
        this.start = GLib.DateTime.new_from_unix_local(start_time);
        this.end = GLib.DateTime.new_from_unix_local(end_time);

        this.all_day = all_day;
        if (this.all_day) {
            // An all day event can be from 00:00 to 00:00 the next day, which will end up
            // causing it to appear for two days.
            this.end = this.end.add_seconds(-1);
        }
        if (this.end.compare(this.start) == -1) {
            // An all day event can be a single point in time at 00:00. The previous -1s
            // will cause it to appear all the following days in the current view.
            this.end = this.start;
        }
        this.end_date = date_only(this.end);

        this.summary = summary;
        this.color = color;
        // This is the time_t for when event was last modified by e-d-s
        this.modified = mod_time;
        // This is the last monotonic time we contacted our server to update our events. This
        // is used to cull deleted events.
        this.last_update_timetamp = last_update_timestamp;
    }

    ends_on_day(date) {
        return dt_equals(date_only(date), this.end_date);
    }

    equal(other_event) {
        return this.id === other_event.id && this.modified === other_event.modified;
    }
}

class EventDataList {
    constructor() {
        this._events = {};
    }

    add_or_update(event_data, last_update_timetamp) {
        let existing = this._events[event_data.id];

        if (existing !== undefined && event_data.equal(existing)) {
            existing.last_update_timetamp = last_update_timetamp;
            existing.color = event_data.color;
            return false;
        }

        this._events[event_data.id] = event_data;
        return true;
    }

    delete(id) {
        let existing = this._events[id];

        if (existing === undefined) {
            return false;
        }

        delete this._events[id];
        return true;
    }

    cull_removed_events(last_update_timetamp) {
        let to_remove = [];
        for (let id in this._events) {
            if (this._events[id].last_update_timetamp < last_update_timetamp) {
                to_remove.push(id);
            }
        }

        if (to_remove.length === 0) {
            return false;
        }

        to_remove.forEach((id) => {
            this.delete(id);
        });

        return true;
    }

    get_colors() {
        return Object.values(this._events).sort((a, b) => a.start.to_unix() - b.start.to_unix()).map(e => e.color);
    }
}

class EventsManager {
    constructor(settings) {
        this.settings = settings;
        this._bus_watch_id
        this._calendar_server = null;
        this.current_month_year = null;

        this.last_update_timestamp = 0;
        this.events_by_date = {};

        this._inited = false;
        this._cached_state = STATUS_UNKNOWN;

        this._gc_timer_id = 0;

        this._reload_today_id = 0;

        this._force_reload_pending = false;
    }

    start_events() {
        this._bus_watch_id = Gio.bus_watch_name(Gio.BusType.SESSION,
                                                EDS_BUS_NAME,
                                                Gio.BusNameWatcherFlags.NONE,
                                                this.eds_service_found.bind(this),
                                                null);
    }

    eds_service_found(connection, name, name_owner) {
        Gio.bus_unwatch_name(this._bus_watch_id);
        this._bus_watch_id = 0;

        if (this._calendar_server == null) {
            log("calendar@cinnamon.org: Calendar events supported.")

            Cinnamon.CalendarServerProxy.new_for_bus(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION,
                "org.cinnamon.CalendarServer",
                "/org/cinnamon/CalendarServer",
                null,
                this._calendar_server_ready.bind(this)
            );
        }
    }

    log_dbus_error(e) {
        global.logError(`calendar@cinnamon.org: Could not check for calendar event support: ${e.toString()}`);
    }

    _calendar_server_ready(obj, res) {
        try {
            this._calendar_server = Cinnamon.CalendarServerProxy.new_for_bus_finish(res);

            this._calendar_server.connect(
                "events-added-or-updated",
                this._handle_added_or_updated_events.bind(this)
            );

            this._calendar_server.connect(
                "events-removed",
                this._handle_removed_events.bind(this)
            );

            this._calendar_server.connect(
                "client-disappeared",
                this._handle_client_disappeared.bind(this)
            );

            this._calendar_server.connect(
                "notify::status",
                this._handle_status_notify.bind(this)
            );

            this._inited = true;

            this.emit("events-manager-ready");
        } catch (e) {
            log("could not connect to calendar server process: " + e);
            return;
        }
    }

    _stop_gc_timer() {
        if (this._gc_timer_id > 0) {
            Mainloop.source_remove(this._gc_timer_id);
            this._gc_timer_id = 0;
        }
    }

    _start_gc_timer() {
        this._stop_gc_timer();

        if (!this.is_active()) {
            return;
        }

        this._gc_timer_id = Mainloop.timeout_add_seconds(
            3, Lang.bind(this, this._perform_gc)
        );
    }

    _perform_gc() {
        let any_removed = false;
        for (let date in this.events_by_date) {
            if (this.events_by_date[date].cull_removed_events(this.last_update_timestamp)) {
                any_removed = true;
            }
        }

        if (any_removed) {
            this.emit("events-updated");
        }

        this._gc_timer_id = 0;
        return GLib.SOURCE_REMOVE;
    }

    _handle_added_or_updated_events(server, varray) {
        let events = varray.unpack();
        for (let n = 0; n < events.length; n++) {
            let data = new EventData(events[n], this.last_update_timestamp);
            // don't loop endlessly in case of a bugged event
            let escape = 0;
            let date_iter = date_only(data.start);
            do {
                let hash = date_iter.to_unix();

                if (this.events_by_date[hash] === undefined) {
                    this.events_by_date[hash] = new EventDataList();
                }

                this.events_by_date[hash].add_or_update(data, this.last_update_timestamp);

                if (data.ends_on_day(date_iter) || escape == 50) {
                    break;
                }

                escape++;
                date_iter = date_iter.add_days(1);
            } while (true);
        }

        this._start_gc_timer();
        this.emit("events-updated");
    }

    _handle_removed_events(server, uids_string) {
        let uids = uids_string.split("::");
        for (let hash in this.events_by_date) {
            let event_data_list = this.events_by_date[hash];

            for (let uid of uids) {
                event_data_list.delete(uid);
            }
        }

        this.queue_reload_today(false);

        this.emit("events-updated");
    }

    _handle_client_disappeared(server, uid) {
        // A calendar was removed/disabled. Instead of picking
        // specific matching events to remove, just rebuild the
        // entire list.
        this.events_by_date = {};
        this.queue_reload_today(true);
    }

    _handle_status_notify(server, pspec) {
        if (this._calendar_server.status === this._cached_state) {
            return;
        }

        // Never reload when the new status is STATUS_UNKNOWN - this
        // means the server name-owner disappeared, it doesn't mean
        // there are no calendars.
        if (this._calendar_server.status === STATUS_UNKNOWN) {
            return;
        }

        this._cached_state = this._calendar_server.status;
        this.queue_reload_today(true);
        this.emit("has-calendars-changed");
    }

    fetch_month_events(month_year, force) {
        let changed_month = this.current_month_year === null || !dt_equals(month_year, this.current_month_year);

        if (!changed_month && !force) {
            return;
        }
        this.current_month_year = month_year;

        if (changed_month) {
            this.events_by_date = {};
        }

        // get first day of month
        let day_one = month_year_only(month_year);
        let week_day = day_one.get_day_of_week();
        let week_start = Cinnamon.util_get_week_start();

        // back up to the start of the week preceding day 1
        let start = day_one.add_days( -(week_day - week_start) );
        // The calendar has 42 boxes
        let end = start.add_days(42).add_seconds(-1);

        this._calendar_server.call_set_time_range(start.to_unix(), end.to_unix(), force, null, this.call_finished.bind(this));

        this.last_update_timestamp = GLib.get_monotonic_time();
    }

    call_finished(server, res) {
        try {
            this._calendar_server.call_set_time_range_finish(res);
        } catch (e) {
            log(e);
        }
    }

    _cancel_reload_today() {
        if (this._reload_today_id > 0) {
            Mainloop.source_remove(this._reload_today_id);
            this._reload_today_id = 0;
        }
    }

    queue_reload_today(force) {
        this._cancel_reload_today();

        if (force) {
            this._force_reload_pending = true;
        }

        this._reload_today_id = Mainloop.idle_add(Lang.bind(this, this._idle_do_reload_today));
    }

    _idle_do_reload_today() {
        this._reload_today_id = 0;

        this.select_date(new Date(), this._force_reload_pending);
        this._force_reload_pending = false;

        return GLib.SOURCE_REMOVE;
    }

    select_date(date, force) {
        if (!this.is_active()) {
            return;
        }

        // date is a js Date(). Eventually the calendar side should use
        // GDateTime, but for now we'll convert it here - it's a bit more
        // useful for dealing with events.
        let gdate = js_date_to_gdatetime(date);

        let gdate_only = date_only(gdate);
        let month_year = month_year_only(gdate_only);
        this.fetch_month_events(month_year, force);
    }

    get_colors_for_date(js_date) {
        let gdate = js_date_to_gdatetime(js_date);
        let gdate_only = date_only(gdate);

        let event_data_list = this.events_by_date[gdate_only.to_unix()];

        return event_data_list !== undefined ? event_data_list.get_colors() : null;
    }

    is_active() {
        return this._inited &&
               this.settings.getValue("show-events") &&
               this._calendar_server !== null &&
               // Not blocking STATUS_UNKNOWN allows our calendar to remain
               // populated while the server is 'unowned' (sleeping), since
               // its cached property is set to 0 when its current owner exits.
               this._calendar_server.status !== STATUS_NO_CALENDARS;
    }
}
Signals.addSignalMethods(EventsManager.prototype);
