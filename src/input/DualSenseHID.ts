/**
 * DualSense extras over WebHID: adaptive triggers, lightbar, player LEDs, rumble.
 * Works over USB (report 0x02) and Bluetooth (report 0x31 + CRC32).
 */

const VENDOR = 0x054c;
const PRODUCTS = [0x0ce6, 0x0df2]; // DualSense, DualSense Edge

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array, seed = 0xffffffff) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = seed;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type TriggerEffect = { mode: 'off' } | { mode: 'feedback'; position: number; strength: number } | { mode: 'vibration'; position: number; amplitude: number; frequency: number } | { mode: 'weapon'; start: number; end: number; strength: number };

function encodeTrigger(e: TriggerEffect): number[] {
  const out = new Array(11).fill(0);
  if (e.mode === 'off') {
    out[0] = 0x05;
    return out;
  }
  if (e.mode === 'feedback' || e.mode === 'vibration') {
    const pos = Math.max(0, Math.min(9, Math.round(e.position)));
    const str = Math.max(1, Math.min(8, Math.round(e.mode === 'feedback' ? e.strength : e.amplitude)));
    let active = 0;
    let force = 0;
    for (let i = pos; i < 10; i++) {
      active |= 1 << i;
      force |= ((str - 1) & 7) << (3 * i);
    }
    out[0] = e.mode === 'feedback' ? 0x21 : 0x26;
    out[1] = active & 0xff;
    out[2] = (active >> 8) & 0xff;
    out[3] = force & 0xff;
    out[4] = (force >>> 8) & 0xff;
    out[5] = (force >>> 16) & 0xff;
    out[6] = (force >>> 24) & 0xff;
    if (e.mode === 'vibration') out[9] = Math.max(1, Math.min(255, Math.round(e.frequency)));
    return out;
  }
  // weapon: resistance between start..end then snap
  const start = Math.max(2, Math.min(7, e.start));
  const end = Math.max(start + 1, Math.min(8, e.end));
  const zones = (1 << start) | (1 << end);
  out[0] = 0x25;
  out[1] = zones & 0xff;
  out[2] = (zones >> 8) & 0xff;
  out[3] = Math.max(0, Math.min(7, e.strength - 1));
  return out;
}

export class DualSenseHID {
  device: HIDDevice | null = null;
  bt = false;
  seq = 0;
  // desired state
  rumbleL = 0; // strong (0..1)
  rumbleR = 0; // weak (0..1)
  light = [0, 60, 255];
  playerLeds = 0;
  trigL: TriggerEffect = { mode: 'off' };
  trigR: TriggerEffect = { mode: 'off' };
  private lastSent = '';
  private lastTime = 0;
  private sending = false;

  static supported() {
    return typeof navigator !== 'undefined' && 'hid' in navigator;
  }

  async connect() {
    if (!DualSenseHID.supported()) throw new Error('WebHID not supported in this browser');
    const devs = await navigator.hid.requestDevice({ filters: PRODUCTS.map((productId) => ({ vendorId: VENDOR, productId })) });
    if (!devs.length) return false;
    return this.open(devs[0]);
  }
  async tryReconnect() {
    if (!DualSenseHID.supported()) return false;
    const devs = await navigator.hid.getDevices();
    const d = devs.find((x) => x.vendorId === VENDOR && PRODUCTS.includes(x.productId));
    if (!d) return false;
    return this.open(d);
  }
  private async open(d: HIDDevice) {
    if (!d.opened) await d.open();
    this.device = d;
    // Bluetooth devices expose output report 0x31
    this.bt = d.collections.some((c) => c.outputReports?.some((r) => r.reportId === 0x31));
    navigator.hid.addEventListener('disconnect', (e) => {
      if ((e as HIDConnectionEvent).device === this.device) this.device = null;
    });
    this.lastSent = '';
    await this.flush(true);
    return true;
  }
  get connected() {
    return !!this.device;
  }

  private buildCommon(): Uint8Array<ArrayBuffer> {
    const c = new Uint8Array(47);
    c[0] = 0x01 | 0x02 | 0x04 | 0x08; // rumble emulation, haptics select, right+left trigger
    c[1] = 0x04 | 0x10 | 0x02; // lightbar, player LEDs, power save
    c[2] = Math.round(Math.max(0, Math.min(1, this.rumbleR)) * 255);
    c[3] = Math.round(Math.max(0, Math.min(1, this.rumbleL)) * 255);
    c[9] = 0x00; // power save: all on
    const r = encodeTrigger(this.trigR);
    const l = encodeTrigger(this.trigL);
    for (let i = 0; i < 11; i++) {
      c[10 + i] = r[i];
      c[21 + i] = l[i];
    }
    c[38] = 0x02; // lightbar setup control enable
    c[41] = 0x02; // light out (release default fade)
    c[42] = 0x00; // led brightness: high
    c[43] = this.playerLeds & 0x1f;
    c[44] = this.light[0];
    c[45] = this.light[1];
    c[46] = this.light[2];
    return c;
  }

  /** Send the current state if it changed (rate-limited). */
  async flush(force = false) {
    if (!this.device || this.sending) return;
    const now = performance.now();
    const common = this.buildCommon();
    const key = common.join(',');
    if (!force && (key === this.lastSent || now - this.lastTime < 33)) return;
    this.sending = true;
    try {
      if (!this.bt) {
        await this.device.sendReport(0x02, common);
      } else {
        const data = new Uint8Array(77);
        data[0] = (this.seq << 4) & 0xf0;
        this.seq = (this.seq + 1) & 0x0f;
        data[1] = 0x10;
        data.set(common, 2);
        const forCrc = new Uint8Array(1 + 1 + 73);
        forCrc[0] = 0xa2;
        forCrc[1] = 0x31;
        forCrc.set(data.subarray(0, 73), 2);
        const crc = crc32(forCrc);
        data[73] = crc & 0xff;
        data[74] = (crc >>> 8) & 0xff;
        data[75] = (crc >>> 16) & 0xff;
        data[76] = (crc >>> 24) & 0xff;
        await this.device.sendReport(0x31, data);
      }
      this.lastSent = key;
      this.lastTime = now;
    } catch (e) {
      console.warn('DualSense HID send failed', e);
    } finally {
      this.sending = false;
    }
  }

  async reset() {
    this.rumbleL = this.rumbleR = 0;
    this.trigL = { mode: 'off' };
    this.trigR = { mode: 'off' };
    await this.flush(true);
  }
}

export const PLAYER_LED_PATTERNS = [0x00, 0x04, 0x0a, 0x15, 0x1b, 0x1f];
