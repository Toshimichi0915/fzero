import { Controls } from '../vehicles/Vehicle';
import { DualSenseHID } from './DualSenseHID';

export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'pause' | 'camera' | 'rear';

interface PadState {
  steerX: number;
  stickY: number;
  throttle: number;
  brake: number;
  cross: boolean;
  circle: boolean;
  square: boolean;
  triangle: boolean;
  l1: boolean;
  r1: boolean;
  options: boolean;
  create: boolean;
  touch: boolean;
  r3: boolean;
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}
const emptyPad = (): PadState => ({
  steerX: 0,
  stickY: 0,
  throttle: 0,
  brake: 0,
  cross: false,
  circle: false,
  square: false,
  triangle: false,
  l1: false,
  r1: false,
  options: false,
  create: false,
  touch: false,
  r3: false,
  up: false,
  down: false,
  left: false,
  right: false,
});

const dz = (v: number, d = 0.1) => (Math.abs(v) < d ? 0 : (Math.sign(v) * (Math.abs(v) - d)) / (1 - d));

/** Unified input: DualSense (Gamepad API + optional WebHID extras) and keyboard. */
export class Input {
  keys = new Set<string>();
  private pressedKeys = new Set<string>();
  pad = emptyPad();
  private prevPad = emptyPad();
  padId = '';
  padConnected = false;
  lastDevice: 'keyboard' | 'pad' = 'keyboard';
  hid = new DualSenseHID();
  private menuQueue: MenuAction[] = [];
  private lastTapL = -10;
  private lastTapR = -10;
  private boostQueued = false;
  private sideQueued = 0;
  private spinQueued = false;
  private rumbleUntil = 0;
  private rumbleStrong = 0;
  private rumbleWeak = 0;
  private repeatT = 0;
  private repeatDir: MenuAction | null = null;
  private kbSteer = 0;
  private lastFill = performance.now();

  constructor() {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressedKeys.add(e.code);
      this.lastDevice = 'keyboard';
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('gamepadconnected', () => (this.lastDevice = 'pad'));
    this.hid.tryReconnect().catch(() => {});
  }

  private readPad(): PadState {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp: Gamepad | null = null;
    for (const p of pads) {
      if (!p || !p.connected) continue;
      // prefer a DualSense
      if (!gp || /054c|dualsense|wireless controller/i.test(p.id)) gp = p;
    }
    this.padConnected = !!gp;
    if (!gp) return emptyPad();
    this.padId = gp.id;
    const b = (i: number) => !!gp!.buttons[i]?.pressed;
    const bv = (i: number) => gp!.buttons[i]?.value ?? 0;
    const s = emptyPad();
    if (gp.mapping === 'standard') {
      s.steerX = dz(gp.axes[0] ?? 0, 0.08);
      s.stickY = dz(gp.axes[1] ?? 0, 0.15);
      s.cross = b(0);
      s.circle = b(1);
      s.square = b(2);
      s.triangle = b(3);
      s.l1 = b(4);
      s.r1 = b(5);
      s.brake = bv(6);
      s.throttle = bv(7);
      s.create = b(8);
      s.options = b(9);
      s.r3 = b(11);
      s.up = b(12);
      s.down = b(13);
      s.left = b(14);
      s.right = b(15);
      s.touch = b(17);
    } else {
      // raw Linux hid-playstation layout (e.g. Firefox)
      s.steerX = dz(gp.axes[0] ?? 0, 0.08);
      s.stickY = dz(gp.axes[1] ?? 0, 0.15);
      s.brake = gp.axes.length > 2 ? ((gp.axes[2] ?? -1) + 1) / 2 : bv(6);
      s.throttle = gp.axes.length > 5 ? ((gp.axes[5] ?? -1) + 1) / 2 : bv(7);
      s.cross = b(0);
      s.circle = b(1);
      s.triangle = b(2);
      s.square = b(3);
      s.l1 = b(4);
      s.r1 = b(5);
      s.create = b(8);
      s.options = b(9);
      s.r3 = b(12);
      // d-pad as hat axes 6/7
      const hx = gp.axes[6] ?? 0,
        hy = gp.axes[7] ?? 0;
      s.left = hx < -0.5;
      s.right = hx > 0.5;
      s.up = hy < -0.5;
      s.down = hy > 0.5;
    }
    return s;
  }

  /** Call once per frame before reading. */
  poll(dt: number, time: number) {
    this.prevPad = this.pad;
    this.pad = this.readPad();
    const p = this.pad,
      q = this.prevPad;
    const edge = (k: keyof PadState) => !!p[k] && !q[k];
    const anyPad = p.cross || p.circle || p.throttle > 0.2 || Math.abs(p.steerX) > 0.3 || p.options || p.up || p.down;
    if (anyPad) this.lastDevice = 'pad';

    // menu events
    const push = (a: MenuAction) => this.menuQueue.push(a);
    if (edge('cross')) push('confirm');
    if (edge('circle')) push('back');
    if (edge('options')) push('pause');
    if (edge('triangle')) push('camera');
    if (edge('touch')) push('rear');
    // stick/dpad navigation with auto-repeat
    let dir: MenuAction | null = null;
    if (p.up || p.stickY < -0.6) dir = 'up';
    else if (p.down || p.stickY > 0.6) dir = 'down';
    else if (p.left || p.steerX < -0.6) dir = 'left';
    else if (p.right || p.steerX > 0.6) dir = 'right';
    if (dir !== this.repeatDir) {
      this.repeatDir = dir;
      this.repeatT = 0.4;
      if (dir) push(dir);
    } else if (dir) {
      this.repeatT -= dt;
      if (this.repeatT <= 0) {
        this.repeatT = 0.12;
        push(dir);
      }
    }
    for (const k of this.pressedKeys) {
      if (k === 'Enter' || k === 'NumpadEnter') push('confirm');
      if (k === 'Escape' || k === 'Backspace') push('back');
      if (k === 'Escape' || k === 'KeyP') push('pause');
      if (k === 'ArrowUp' || k === 'KeyW') push('up');
      if (k === 'ArrowDown' || k === 'KeyS') push('down');
      if (k === 'ArrowLeft' || k === 'KeyA') push('left');
      if (k === 'ArrowRight' || k === 'KeyD') push('right');
      if (k === 'KeyC') push('camera');
      if (k === 'KeyR') push('rear');
    }

    // action edges
    if (edge('circle') || this.pressedKeys.has('Space')) this.boostQueued = true;
    if (edge('square') || this.pressedKeys.has('KeyF')) this.spinQueued = true;
    // double-tap lean for side attack (F-Zero X)
    const tapL = edge('l1') || this.pressedKeys.has('KeyQ');
    const tapR = edge('r1') || this.pressedKeys.has('KeyE');
    if (tapL) {
      if (time - this.lastTapL < 0.3) this.sideQueued = -1;
      this.lastTapL = time;
    }
    if (tapR) {
      if (time - this.lastTapR < 0.3) this.sideQueued = 1;
      this.lastTapR = time;
    }
    this.pressedKeys.clear();

    // rumble decay
    if (time > this.rumbleUntil) {
      this.rumbleStrong = 0;
      this.rumbleWeak = 0;
    }
  }

  menu(): MenuAction[] {
    const q = this.menuQueue;
    this.menuQueue = [];
    return q;
  }
  clearMenu() {
    this.menuQueue = [];
  }

  fillControls(c: Controls) {
    const p = this.pad;
    const k = this.keys;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFill) / 1000);
    this.lastFill = now;
    // digital steering (keys / d-pad) ramps in smoothly; analog stick is used directly
    const digital = (p.left || k.has('ArrowLeft') || k.has('KeyA') ? -1 : 0) + (p.right || k.has('ArrowRight') || k.has('KeyD') ? 1 : 0);
    if (digital !== 0) {
      if (Math.sign(this.kbSteer) !== digital) this.kbSteer *= 0.3;
      this.kbSteer = Math.max(-1, Math.min(1, this.kbSteer + digital * dt * 4.5));
    } else this.kbSteer *= Math.exp(-dt * 14);
    let steer = Math.abs(p.steerX) > Math.abs(this.kbSteer) ? p.steerX : this.kbSteer;
    // slight response curve for fine control
    c.steer = Math.sign(steer) * Math.pow(Math.abs(steer), 1.35);
    c.throttle = Math.max(p.throttle, p.cross ? 1 : 0, k.has('ArrowUp') || k.has('KeyW') ? 1 : 0);
    c.brake = Math.max(p.brake, k.has('ArrowDown') || k.has('KeyS') ? 1 : 0);
    c.lean = (p.r1 || k.has('KeyE') ? 1 : 0) - (p.l1 || k.has('KeyQ') ? 1 : 0);
    c.pitch = p.stickY + (k.has('ArrowDown') ? 0 : 0);
    c.boost = this.boostQueued;
    c.sideAttack = this.sideQueued;
    c.spin = this.spinQueued;
    this.boostQueued = false;
    this.sideQueued = 0;
    this.spinQueued = false;
  }

  /** Rumble: strong = low-frequency motor, weak = high-frequency. */
  rumble(strong: number, weak: number, ms: number, now: number) {
    if (strong < this.rumbleStrong && now < this.rumbleUntil) return;
    this.rumbleStrong = strong;
    this.rumbleWeak = weak;
    this.rumbleUntil = now + ms / 1000;
    if (this.hid.connected) return; // applied in updateFeedback
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      const act = (p as Gamepad & { vibrationActuator?: GamepadHapticActuator })?.vibrationActuator;
      if (act && 'playEffect' in act) {
        (act as unknown as { playEffect: (t: string, o: object) => Promise<unknown> })
          .playEffect('dual-rumble', { duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) })
          .catch(() => {});
      }
    }
  }
  /** continuous rumble component (engine), mixed in for HID */
  get rumbleNow() {
    return [this.rumbleStrong, this.rumbleWeak];
  }
}
