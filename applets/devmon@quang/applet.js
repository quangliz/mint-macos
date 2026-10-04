const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Mainloop = imports.mainloop;
const Main = imports.ui.main;

function readFile(path) {
    try {
        let [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes).trim() : null;
    } catch (e) {
        return null;
    }
}

function fmtBytes(b) {
    const u = ["B", "K", "M", "G", "T"];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return (b < 10 && i > 0 ? b.toFixed(1) : Math.round(b)) + u[i];
}

function bar(pct, width = 20) {
    let n = Math.round(Math.max(0, Math.min(100, pct)) / 100 * width);
    return "█".repeat(n) + "░".repeat(width - n);
}

class DeviceMonitor extends Applet.TextIconApplet {
    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);
        this.orientation = orientation;
        this.hide_applet_icon();
        this.set_applet_tooltip("Device Monitor");

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instanceId);
        for (let k of ["interval", "show-cpu", "show-mem", "show-temp", "show-net", "warn-temp", "show-gpu", "gpu-interval"])
            this.settings.bind(k, k.replace(/-/g, "_"), () => this._restart());

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this.rows = {};
        for (let [key, title] of [
            ["cpu", "CPU"], ["mem", "Memory"], ["swap", "Swap"], ["temps", "Temperatures"],
            ["gpu", "CUDA GPU"], ["net", "Network"], ["disk", "Disk (/)"], ["bat", "Battery"], ["sys", "System"],
        ]) {
            let item = new PopupMenu.PopupMenuItem("", { reactive: false });
            item.label.clutter_text.use_markup = true;
            item.label.style = "font-family: monospace;";
            this.menu.addMenuItem(item);
            this.rows[key] = { item, title };
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction("Open System Monitor", () => Util.spawnCommandLine("gnome-system-monitor"));
        this.primeItem = this.menu.addAction("Switch GPU mode…", () => Util.spawnCommandLine("nvidia-settings --page=\"PRIME Profiles\""));
        // With mint-macos/gpu installed: turn the GPU on for CUDA, fully off otherwise
        this.gpuToggle = this.menu.addAction("", () => this._toggleGpu());
        this.gpuToggle.actor.hide();
        this.menu.connect("open-state-changed", (m, open) => { if (open) this._updateGpuToggle(); });

        this.prevCpu = null;
        this.prevNet = null;
        this.nvsmi = GLib.find_program_in_path("nvidia-smi");
        this.gpu = null;
        this.gpuBusy = false;
        if (!this.nvsmi) this.rows.gpu.item.actor.hide();

        // We show the PRIME GPU mode in the CUDA section, so hide the
        // separate nvidia-prime tray icon (stock tray-replacement mechanism).
        this.uuid = metadata.uuid;
        this.primeMode = null;
        if (GLib.find_program_in_path("prime-select")) {
            imports.ui.main.systrayManager.registerTrayIconReplacement("nvidia-prime", this.uuid);
            this._queryPrime();
        } else {
            this.primeItem.actor.hide();
        }
        this._update();
        this._restart();
    }

    on_orientation_changed(orientation) {
        this.orientation = orientation;
        this._update();
    }

    _isVertical() {
        return this.orientation === imports.gi.St.Side.LEFT || this.orientation === imports.gi.St.Side.RIGHT;
    }

    _hasGpuCmd() {
        return GLib.file_test("/usr/local/bin/gpu", GLib.FileTest.IS_EXECUTABLE);
    }

    _updateGpuToggle() {
        if (!this._hasGpuCmd()) { this.gpuToggle.actor.hide(); return; }
        let on = GLib.file_test("/sys/module/nvidia", GLib.FileTest.IS_DIR);
        this.gpuToggle.label.text = on ? "Turn GPU off (save power)" : "Turn GPU on for CUDA";
        this.gpuToggle.actor.show();
        // in GPU-off setups the PRIME switch is not the right tool
        this.primeItem.actor.hide();
    }

    // Runs "gpu on|off" as root through the normal password dialog
    _toggleGpu() {
        let on = GLib.file_test("/sys/module/nvidia", GLib.FileTest.IS_DIR);
        try {
            let proc = Gio.Subprocess.new(["pkexec", "/usr/local/bin/gpu", on ? "off" : "on"],
                                          Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                let out = "";
                try { [, out] = p.communicate_utf8_finish(res); } catch (e) {}
                if (!p.get_successful() && out && !/dismissed|Not authorized/i.test(out))
                    Main.notify("GPU", out.trim().split("\n").slice(0, 4).join("\n"));
                this.gpu = null;
                this._pollGpu();
                this._updateGpuToggle();
            });
        } catch (e) {
            global.logError("devmon: gpu toggle failed: " + e);
        }
    }

    on_applet_clicked() {
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        imports.ui.main.systrayManager.unregisterTrayIconReplacement(this.uuid);
        if (this.timer) Mainloop.source_remove(this.timer);
        if (this.gpuTimer) Mainloop.source_remove(this.gpuTimer);
        this.timer = this.gpuTimer = null;
        this.settings.finalize();
    }

    _restart() {
        if (this.timer) Mainloop.source_remove(this.timer);
        this.timer = Mainloop.timeout_add_seconds(this.interval, () => { this._update(); return true; });
        if (this.gpuTimer) Mainloop.source_remove(this.gpuTimer);
        this.gpuTimer = null;
        if (this.nvsmi) {
            this.gpuTimer = Mainloop.timeout_add_seconds(this.gpu_interval, () => { this._pollGpu(); return true; });
            this._pollGpu();
        }
        this._update();
    }

    _setRow(key, text) {
        let r = this.rows[key];
        r.item.label.clutter_text.set_markup(`<b>${r.title}</b>\n${text}`);
    }

    // ---- data readers ----
    _cpu() {
        let lines = (readFile("/proc/stat") || "").split("\n");
        let parse = l => l.split(/\s+/).slice(1).map(Number);
        let now = lines.filter(l => /^cpu\d*\s/.test(l)).map(parse);
        let usage = [];
        if (this.prevCpu && this.prevCpu.length === now.length) {
            for (let i = 0; i < now.length; i++) {
                let idle = (now[i][3] + now[i][4]) - (this.prevCpu[i][3] + this.prevCpu[i][4]);
                let total = now[i].reduce((a, b) => a + b, 0) - this.prevCpu[i].reduce((a, b) => a + b, 0);
                usage.push(total > 0 ? 100 * (1 - idle / total) : 0);
            }
        }
        this.prevCpu = now;
        let freqs = [];
        for (let i = 0; i < now.length - 1; i++) {
            let f = readFile(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`);
            if (f) freqs.push(Number(f));
        }
        let avgFreq = freqs.length ? freqs.reduce((a, b) => a + b, 0) / freqs.length / 1e6 : 0;
        let load = (readFile("/proc/loadavg") || "").split(" ").slice(0, 3).join(" ");
        return { total: usage[0] ?? 0, cores: usage.slice(1), freq: avgFreq, load };
    }

    _mem() {
        let m = {};
        for (let l of (readFile("/proc/meminfo") || "").split("\n")) {
            let [k, v] = l.split(":");
            if (v) m[k] = parseInt(v) * 1024;
        }
        let used = m.MemTotal - m.MemAvailable;
        let swapUsed = m.SwapTotal - m.SwapFree;
        return { used, total: m.MemTotal, pct: 100 * used / m.MemTotal,
                 swapUsed, swapTotal: m.SwapTotal, swapPct: m.SwapTotal ? 100 * swapUsed / m.SwapTotal : 0 };
    }

    _temps() {
        let out = [];
        let dir = Gio.File.new_for_path("/sys/class/hwmon");
        let en;
        try { en = dir.enumerate_children("standard::name", 0, null); } catch (e) { return out; }
        let info;
        while ((info = en.next_file(null))) {
            let base = "/sys/class/hwmon/" + info.get_name();
            // Don't wake runtime-suspended devices (e.g. a sleeping discrete GPU)
            if (readFile(base + "/device/power/runtime_status") === "suspended") continue;
            let name = readFile(base + "/name");
            let t = readFile(base + "/temp1_input");
            if (!name || !t) continue;
            let label = readFile(base + "/temp1_label");
            out.push({ name: label && label !== "Composite" ? `${name} (${label})` : name, c: Number(t) / 1000 });
        }
        out.sort((a, b) => a.name.localeCompare(b.name));
        return out;
    }

    _net() {
        let rx = 0, tx = 0;
        for (let l of (readFile("/proc/net/dev") || "").split("\n").slice(2)) {
            let [iface, rest] = l.split(":");
            if (!rest || iface.trim() === "lo") continue;
            let f = rest.trim().split(/\s+/).map(Number);
            rx += f[0]; tx += f[8];
        }
        let now = GLib.get_monotonic_time() / 1e6;
        let r = { down: 0, up: 0, rx, tx };
        if (this.prevNet) {
            let dt = now - this.prevNet.t;
            r.down = (rx - this.prevNet.rx) / dt;
            r.up = (tx - this.prevNet.tx) / dt;
        }
        this.prevNet = { rx, tx, t: now };
        return r;
    }

    _disk() {
        try {
            let info = Gio.File.new_for_path("/").query_filesystem_info("filesystem::size,filesystem::free", null);
            let size = info.get_attribute_uint64("filesystem::size");
            let free = info.get_attribute_uint64("filesystem::free");
            return { used: size - free, size, pct: 100 * (size - free) / size };
        } catch (e) {
            return null;
        }
    }

    _battery() {
        let base = "/sys/class/power_supply/BAT1";
        if (!readFile(base + "/capacity")) base = "/sys/class/power_supply/BAT0";
        let cap = readFile(base + "/capacity");
        if (!cap) return null;
        let cur = Number(readFile(base + "/current_now") || 0);
        let volt = Number(readFile(base + "/voltage_now") || 0);
        let pw = Number(readFile(base + "/power_now") || 0) || cur * volt / 1e6;
        let full = Number(readFile(base + "/charge_full") || 0);
        let design = Number(readFile(base + "/charge_full_design") || 0);
        return { pct: Number(cap), status: readFile(base + "/status"), watts: pw / 1e6,
                 health: design ? 100 * full / design : null, cycles: readFile(base + "/cycle_count") };
    }

    _gpuPciPath() {
        // /proc/driver/nvidia/gpus/<pci-id> exists only while the proprietary driver is loaded
        try {
            let en = Gio.File.new_for_path("/proc/driver/nvidia/gpus").enumerate_children("standard::name", 0, null);
            let info = en.next_file(null);
            return info ? "/sys/bus/pci/devices/" + info.get_name() : null;
        } catch (e) {
            return null;
        }
    }

    // Runs nvidia-smi asynchronously so the panel never blocks on it.
    _pollGpu() {
        if (this.gpuBusy) return;
        let pci = this._gpuPciPath();
        if (!pci) { this.gpu = { state: "no-driver" }; return; }
        // Don't wake a runtime-suspended GPU just to read its stats
        if (readFile(pci + "/power/runtime_status") === "suspended") { this.gpu = { state: "asleep" }; return; }

        this.gpuBusy = true;
        let fields = "name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,clocks.sm,pstate";
        let cmd = `${this.nvsmi} --query-gpu=${fields} --format=csv,noheader,nounits && echo --- && ` +
                  `${this.nvsmi} --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits && echo --- && ` +
                  `${this.nvsmi} --version | grep -i cuda`;
        try {
            let proc = Gio.Subprocess.new(["sh", "-c", cmd], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                this.gpuBusy = false;
                try {
                    let [, out] = p.communicate_utf8_finish(res);
                    let [gpuPart, appPart, verPart] = (out || "").split("---\n");
                    let f = (gpuPart || "").trim().split("\n")[0].split(",").map(x => x.trim());
                    if (f.length < 9) { this.gpu = { state: "error" }; return; }
                    let num = x => (isNaN(Number(x)) ? null : Number(x));
                    let apps = (appPart || "").trim().split("\n").filter(l => l.trim()).map(l => {
                        let [pid, name, mem] = l.split(",").map(x => x.trim());
                        return { pid, name: GLib.path_get_basename(name), mem: num(mem) };
                    });
                    let cuda = ((verPart || "").match(/CUDA Version\s*:?\s*([\d.]+)/i) || [])[1];
                    this.gpu = { state: "ok", name: f[0], util: num(f[1]), memUtil: num(f[2]),
                                 memUsed: num(f[3]), memTotal: num(f[4]), temp: num(f[5]),
                                 power: num(f[6]), clock: num(f[7]), pstate: f[8], apps, cuda };
                } catch (e) {
                    this.gpu = { state: "error" };
                }
            });
        } catch (e) {
            this.gpuBusy = false;
            this.gpu = { state: "error" };
        }
    }

    _queryPrime() {
        try {
            let proc = Gio.Subprocess.new(["prime-select", "query"], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    let [, out] = p.communicate_utf8_finish(res);
                    let mode = (out || "").trim();
                    this.primeMode = { "on-demand": "NVIDIA On-Demand", "nvidia": "NVIDIA (performance)",
                                       "intel": "Integrated only (power saving)" }[mode] || mode || null;
                } catch (e) {}
            });
        } catch (e) {}
    }

    _gpuText() {
        let text = this._gpuStats();
        return this.primeMode ? `mode ${this.primeMode}\n${text}` : text;
    }

    _gpuStats() {
        let g = this.gpu;
        if (!g) return "querying…";
        if (g.state === "no-driver")
            return this._hasGpuCmd() ? "GPU off: fully powered down\nTurn it on below for CUDA" : "NVIDIA driver not loaded";
        if (g.state === "asleep") return "GPU asleep (not polled, to save power)";
        if (g.state !== "ok") return "nvidia-smi failed";
        let memPct = g.memTotal ? 100 * g.memUsed / g.memTotal : 0;
        let lines = [
            `${g.name}${g.cuda ? "   CUDA " + g.cuda : ""}`,
            `util ${bar(g.util ?? 0)} ${g.util ?? "?"}%`,
            `vram ${bar(memPct)} ${g.memUsed} / ${g.memTotal} MiB`,
            `${g.temp ?? "?"}°C   ${g.power != null ? g.power.toFixed(1) + " W" : "? W"}   ${g.clock ?? "?"} MHz   ${g.pstate}`,
        ];
        if (g.temp != null && g.temp >= this.warn_temp) lines[3] = `<span foreground="#ff5555">${lines[3]}</span>`;
        if (g.apps.length) {
            lines.push("CUDA processes:");
            for (let a of g.apps)
                lines.push(`  ${a.pid.padStart(7)}  ${GLib.markup_escape_text(a.name, -1).padEnd(20)} ${a.mem ?? "?"} MiB`);
        } else {
            lines.push("no CUDA processes");
        }
        return lines.join("\n");
    }

    // ---- render ----
    _update() {
        try {
            let cpu = this._cpu(), mem = this._mem(), temps = this._temps();
            let net = this._net(), disk = this._disk(), bat = this._battery();
            let cpuTemp = temps.find(t => /k10temp|coretemp|zenpower|cpu/i.test(t.name));
            let hot = cpuTemp && cpuTemp.c >= this.warn_temp;

            let v = this._isVertical();
            let parts = [];
            if (this.show_cpu) parts.push(v ? `C${Math.round(cpu.total)}` : `CPU ${Math.round(cpu.total)}%`);
            if (this.show_mem) parts.push(v ? `M${Math.round(mem.pct)}` : `RAM ${Math.round(mem.pct)}%`);
            if (this.show_temp && cpuTemp) parts.push(`${Math.round(cpuTemp.c)}°`);
            let g = this.gpu;
            if (this.show_gpu && g && g.state === "ok") parts.push(v ? `G${g.util}` : `GPU ${g.util}%`);
            if (this.show_net) parts.push(v ? `↓${fmtBytes(net.down)}\n↑${fmtBytes(net.up)}` : `↓${fmtBytes(net.down)} ↑${fmtBytes(net.up)}`);
            this.set_applet_label(parts.join(v ? "\n" : "  "));
            this.set_applet_tooltip(`CPU ${cpu.total.toFixed(0)}%  RAM ${mem.pct.toFixed(0)}%` +
                (cpuTemp ? `  ${cpuTemp.c.toFixed(0)}°C` : "") +
                (g && g.state === "ok" ? `\nGPU ${g.util}%  VRAM ${g.memUsed}/${g.memTotal} MiB  ${g.temp}°C` : "") + `\n↓${fmtBytes(net.down)}/s ↑${fmtBytes(net.up)}/s`);
            this._applet_label.style = (v ? "font-size: 8pt; text-align: center;" : "") +
                (hot ? "color: #ff5555; font-weight: bold;" : "");

            let cores = cpu.cores.map((c, i) => `${String(i).padStart(2)} ${bar(c, 10)} ${String(Math.round(c)).padStart(3)}%`);
            let coreLines = [];
            for (let i = 0; i < cores.length; i += 2) coreLines.push(cores.slice(i, i + 2).join("   "));
            this._setRow("cpu", `${bar(cpu.total)} ${cpu.total.toFixed(1)}%   ${cpu.freq.toFixed(2)} GHz   load ${cpu.load}\n` + coreLines.join("\n"));
            this._setRow("mem", `${bar(mem.pct)} ${fmtBytes(mem.used)} / ${fmtBytes(mem.total)} (${mem.pct.toFixed(0)}%)`);
            this._setRow("swap", mem.swapTotal ? `${bar(mem.swapPct)} ${fmtBytes(mem.swapUsed)} / ${fmtBytes(mem.swapTotal)}` : "none");
            this._setRow("temps", temps.length ? temps.map(t => {
                let s = `${t.name.padEnd(18)} ${t.c.toFixed(1)}°C`;
                return t.c >= this.warn_temp ? `<span foreground="#ff5555">${s}</span>` : s;
            }).join("\n") : "no sensors");
            if (this.nvsmi) this._setRow("gpu", this._gpuText());
            this._setRow("net", `↓ ${fmtBytes(net.down)}/s   ↑ ${fmtBytes(net.up)}/s\ntotal ↓ ${fmtBytes(net.rx)}  ↑ ${fmtBytes(net.tx)}`);
            this._setRow("disk", disk ? `${bar(disk.pct)} ${fmtBytes(disk.used)} / ${fmtBytes(disk.size)} (${disk.pct.toFixed(0)}%)` : "n/a");
            this._setRow("bat", bat ? `${bar(bat.pct)} ${bat.pct}%  ${bat.status}  ${bat.watts.toFixed(1)} W` +
                (bat.health ? `\nhealth ${bat.health.toFixed(0)}%   cycles ${bat.cycles}` : "") : "no battery");
            let up = Number((readFile("/proc/uptime") || "0").split(" ")[0]);
            this._setRow("sys", `uptime ${Math.floor(up / 86400)}d ${Math.floor(up % 86400 / 3600)}h ${Math.floor(up % 3600 / 60)}m   procs ${(readFile("/proc/loadavg") || "").split(" ")[3] || "?"}`);
        } catch (e) {
            global.logError("devmon: " + e);
        }
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new DeviceMonitor(metadata, orientation, panelHeight, instanceId);
}
