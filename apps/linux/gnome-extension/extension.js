// Poach Capture: keeps Poach's recording controls out of its own recordings.
//
// Mutter records an area (org.gnome.Mutter.ScreenCast RecordArea) by painting
// the stage again into an off-screen framebuffer. The effect below lets the
// controls window paint only into the framebuffers of real stage views, so it
// stays visible on the monitor and is absent from those off-screen paints.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const CONTROLS_TITLE = 'Poach Recording';
const EFFECT_NAME = 'poach-hide-from-capture';
const MARGIN = 24;
const API_VERSION = 1;

const DBUS_PATH = '/io/github/poach/Shell';
const DBUS_INTERFACE = `
<node>
  <interface name="io.github.poach.Shell">
    <method name="GetVersion">
      <arg type="u" direction="out" name="version"/>
    </method>
    <method name="GetCaptureMonitor">
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
      <arg type="i" direction="out" name="width"/>
      <arg type="i" direction="out" name="height"/>
    </method>
  </interface>
</node>`;

const HideFromCaptureEffect = GObject.registerClass(
class PoachHideFromCaptureEffect extends Clutter.Effect {
    vfunc_paint(node, paintContext, flags) {
        if (this._paintsOnScreen(paintContext))
            super.vfunc_paint(node, paintContext, flags);
    }

    _paintsOnScreen(paintContext) {
        const framebuffer = paintContext.get_framebuffer();
        return this.actor.peek_stage_views().some(view =>
            view.get_framebuffer() === framebuffer || view.get_onscreen() === framebuffer);
    }
});

/** Methods Poach calls over D-Bus. */
class PoachShellService {
    GetVersion() {
        return API_VERSION;
    }

    /** The monitor under the pointer, in stage coordinates (as RecordArea expects). */
    GetCaptureMonitor() {
        const rect = global.display.get_monitor_geometry(global.display.get_current_monitor());
        return [rect.x, rect.y, rect.width, rect.height];
    }
}

export default class PoachCaptureExtension extends Extension {
    enable() {
        this._windowSignals = new Map();
        this._service = Gio.DBusExportedObject.wrapJSObject(DBUS_INTERFACE, new PoachShellService());
        this._service.export(Gio.DBus.session, DBUS_PATH);
        this._createdId = global.display.connect('window-created', (_display, window) => this._watch(window));
        for (const actor of global.get_window_actors())
            this._watch(actor.get_meta_window());
    }

    disable() {
        global.display.disconnect(this._createdId);
        for (const [window, ids] of this._windowSignals) {
            ids.forEach(id => window.disconnect(id));
            window.get_compositor_private()?.remove_effect_by_name(EFFECT_NAME);
        }
        this._windowSignals = null;
        this._service.unexport();
        this._service = null;
    }

    _watch(window) {
        if (!window || this._windowSignals.has(window))
            return;
        const ids = [
            window.connect('notify::title', () => this._adopt(window)),
            window.connect('shown', () => this._adopt(window)),
            window.connect('unmanaged', () => this._windowSignals?.delete(window)),
        ];
        this._windowSignals.set(window, ids);
        this._adopt(window);
    }

    _adopt(window) {
        const actor = window.get_compositor_private();
        if (!actor || window.get_title() !== CONTROLS_TITLE || actor.get_effect(EFFECT_NAME))
            return;
        actor.add_effect_with_name(EFFECT_NAME, new HideFromCaptureEffect());
        window.make_above();
        window.stick();
        // Wait for the first frame so the frame rect has its final size.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const area = window.get_work_area_current_monitor();
            const frame = window.get_frame_rect();
            window.move_frame(true, area.x + area.width - frame.width - MARGIN, area.y + MARGIN);
            return GLib.SOURCE_REMOVE;
        });
    }
}
