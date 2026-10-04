// Frosted "liquid glass" backdrop for a Cinnamon popup menu.
//
// Cinnamon has no backdrop blur, so while the menu is open we put live clones
// of the wallpaper and the windows behind it into a layer under the menu
// content, and blur that layer with a two-pass Gaussian GLSL shader. The
// second pass also rounds the corners and lifts saturation slightly
// (macOS "vibrancy"). Clones exist only while the menu is open.
//
// Shared by controlcenter@quang and clockcenter@quang (keep both copies equal).

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;

const BLUR_H = `
uniform sampler2D tex;
uniform float dx;
void main() {
  vec2 uv = cogl_tex_coord_in[0].st;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -12; i <= 12; i++) {
    float w = exp(-float(i * i) / 72.0);
    sum += texture2D(tex, clamp(uv + vec2(dx * float(i) * 2.5, 0.0), 0.0, 1.0)) * w;
    wsum += w;
  }
  cogl_color_out = sum / wsum;
}`;

const BLUR_V = `
uniform sampler2D tex;
uniform float dy;
void main() {
  vec2 uv = cogl_tex_coord_in[0].st;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -12; i <= 12; i++) {
    float w = exp(-float(i * i) / 72.0);
    sum += texture2D(tex, clamp(uv + vec2(0.0, dy * float(i) * 2.5), 0.0, 1.0)) * w;
    wsum += w;
  }
  vec4 col = sum / wsum;

  // vibrancy: a little extra saturation
  float luma = dot(col.rgb, vec3(0.299, 0.587, 0.114));
  col.rgb = mix(vec3(luma), col.rgb, 1.25);
  cogl_color_out = col;
}`;

// Rounded corners, cut in screen pixels. The blur passes render into
// off-screen buffers a little larger than the panel, so texture coordinates
// can't locate its edges; gl_FragCoord in the final, on-screen pass can.
const MASK = `
uniform sampler2D tex;
uniform float rx;
uniform float ry;
uniform float rw;
uniform float rh;
uniform float radius;
uniform float stage_h;
void main() {
  vec4 col = texture2D(tex, cogl_tex_coord_in[0].st);
  vec2 p = vec2(gl_FragCoord.x, stage_h - gl_FragCoord.y);   // GL origin is bottom-left
  vec2 q = abs(p - vec2(rx + rw * 0.5, ry + rh * 0.5)) - (vec2(rw, rh) * 0.5 - vec2(radius));
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  cogl_color_out = col * clamp(0.5 - d, 0.0, 1.0);
}`;

// Uniforms are typed by value; a tiny fraction keeps whole numbers as floats.
const f = v => v + 1e-6;

var GlassBackdrop = class GlassBackdrop {
    constructor(menu, params = {}) {
        this.menu = menu;
        this.radius = params.radius || 18;
        this._clones = [];
        this._signals = [];
        this._syncId = 0;
        this._ok = false;
        try {
            this.layer = new Clutter.Actor({ clip_to_allocation: true, reactive: false });
            // Clutter runs effects inside-out: the first one added is the
            // outermost and draws to the screen, so the mask goes first.
            this._fxMask = this._effect(MASK);
            this._fxH = this._effect(BLUR_H);
            this._fxV = this._effect(BLUR_V);
            this.layer.add_effect(this._fxMask);
            this.layer.add_effect(this._fxH);
            this.layer.add_effect(this._fxV);

            menu._boxWrapper.insert_child_below(this.layer, menu.box);
            this._connect(menu._boxWrapper, "allocate", (actor, box, flags) => this._allocate(box, flags));
            this._connect(menu, "open-state-changed", (m, open) => open ? this._build() : this._clear());
            // the menu slides in; keep the clones lined up with the screen
            this._connect(menu.actor, "notify::x", () => this._queueSync());
            this._connect(menu.actor, "notify::y", () => this._queueSync());

            // Cinnamon rewrites the menu's style on every open (max-height/width),
            // so re-append our transparent frame whenever that happens.
            this._frameStyle = "background-color: transparent; box-shadow: none; border: none; padding: 0;" +
                               (params.gap ? ` margin-top: ${params.gap}px; margin-right: ${params.gap}px;` : "");
            this._connect(menu.actor, "notify::style", () => this._keepFrameStyle());
            this._keepFrameStyle();
            this._ok = true;
        } catch (e) {
            global.logError("glass: disabled, falling back to the theme background: " + e);
            this.destroy();
        }
    }

    get active() { return this._ok; }

    _keepFrameStyle() {
        let style = this.menu.actor.style || "";
        if (!style.includes(this._frameStyle))
            this.menu.actor.style = (style ? style + " " : "") + this._frameStyle;
    }

    _connect(obj, signal, fn) {
        this._signals.push([obj, obj.connect(signal, fn)]);
    }

    _effect(source) {
        let fx = new Clutter.ShaderEffect({ shader_type: Clutter.ShaderType.FRAGMENT_SHADER });
        fx.set_shader_source(source);
        fx.set_uniform_value("tex", 0);
        return fx;
    }

    // Same box the menu gives its content, so the glass sits exactly under it
    _allocate(box, flags) {
        this.layer.allocate(box, flags);
        let w = box.get_width(), h = box.get_height();
        if (w > 0 && h > 0 && (w !== this._w || h !== this._h)) {
            this._w = w;
            this._h = h;
            this._fxH.set_uniform_value("dx", f(1 / w));
            this._fxV.set_uniform_value("dy", f(1 / h));
            this._fxMask.set_uniform_value("rw", f(w));
            this._fxMask.set_uniform_value("rh", f(h));
            this._fxMask.set_uniform_value("radius", f(this.radius));
            this._fxMask.set_uniform_value("stage_h", f(global.stage.height));
            this._queueSync();
        }
    }

    _build() {
        this._clear();
        let sources = [global.background_actor].concat(
            global.get_window_actors().filter(a => a.visible && a.meta_window &&
                                                   !a.meta_window.minimized &&
                                                   a.meta_window.showing_on_its_workspace()));
        for (let src of sources) {
            let clone = new Clutter.Clone({ source: src });
            this.layer.add_child(clone);
            let entry = { clone, src, id: 0 };
            // A window can close while the menu is open; touching its actor
            // after that crashes Cinnamon, so drop the clone the moment it goes.
            entry.id = src.connect("destroy", () => this._drop(entry));
            this._clones.push(entry);
        }
        this._queueSync();
    }

    _drop(entry) {
        let i = this._clones.indexOf(entry);
        if (i === -1) return;
        this._clones.splice(i, 1);
        entry.src = null;
        entry.clone.destroy();
    }

    // Position updates run after layout, never inside an allocation pass
    _queueSync() {
        if (this._syncId || !this.layer) return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        if (!this.layer) return;
        let [lx, ly] = this.layer.get_transformed_position();
        this._fxMask.set_uniform_value("rx", f(lx));
        this._fxMask.set_uniform_value("ry", f(ly));
        for (let entry of this._clones) {
            if (!entry.src) continue;
            let [sx, sy] = entry.src.get_transformed_position();
            entry.clone.set_position(Math.round(sx - lx), Math.round(sy - ly));
        }
    }

    _clear() {
        for (let entry of this._clones) {
            if (entry.src) {
                try { entry.src.disconnect(entry.id); } catch (e) {}
            }
            entry.clone.destroy();
        }
        this._clones = [];
    }

    destroy() {
        if (this._syncId) GLib.source_remove(this._syncId);
        this._syncId = 0;
        for (let [obj, id] of this._signals) {
            try { obj.disconnect(id); } catch (e) {}
        }
        this._signals = [];
        this._clear();
        if (this.layer) this.layer.destroy();
        this.layer = null;
        if (this.menu && this.menu.actor) this.menu.actor.style = null;
        this._ok = false;
    }
};
