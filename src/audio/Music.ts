/** Generative synthwave / race soundtrack using a look-ahead sequencer. */
type Mode = 'off' | 'title' | 'race' | 'results';

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

// chord progressions (root midi, minor?)
const PROGS: [number, boolean][][] = [
  [
    [45, true],
    [41, false],
    [48, false],
    [43, false],
  ],
  [
    [45, true],
    [41, false],
    [43, false],
    [40, true],
  ],
  [
    [38, true],
    [41, false],
    [45, true],
    [43, false],
  ],
];

export class Music {
  mode: Mode = 'off';
  bpm = 146;
  private next = 0;
  private step = 0;
  private bar = 0;
  private out: GainNode;
  private delay: DelayNode;
  private delayFb: GainNode;
  private duck: GainNode;
  private intensity = 1;
  constructor(
    private ctx: AudioContext,
    bus: GainNode,
    private send: GainNode,
    private noise: AudioBuffer,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.duck = ctx.createGain();
    this.duck.connect(this.out);
    this.out.connect(bus);
    this.delay = ctx.createDelay(1);
    this.delay.delayTime.value = (60 / this.bpm) * 0.75;
    this.delayFb = ctx.createGain();
    this.delayFb.gain.value = 0.35;
    const dlp = ctx.createBiquadFilter();
    dlp.frequency.value = 2500;
    this.delay.connect(dlp).connect(this.delayFb).connect(this.delay);
    dlp.connect(this.out);
  }

  setMode(m: Mode) {
    if (m === this.mode) return;
    const t = this.ctx.currentTime;
    this.mode = m;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(m === 'off' ? 0 : m === 'results' ? 0.8 : 1, t, 0.6);
    if (m === 'race') {
      this.bar = 0;
      this.step = 0;
    }
    if (this.next < t) this.next = t + 0.05;
  }

  update() {
    if (this.mode === 'off') return;
    const t = this.ctx.currentTime;
    const spb = 60 / this.bpm / 4; // 16th note
    if (this.next < t - 0.2) this.next = t + 0.02;
    while (this.next < t + 0.15) {
      this.schedule(this.next, this.step, this.bar);
      this.next += spb;
      this.step++;
      if (this.step >= 16) {
        this.step = 0;
        this.bar++;
      }
    }
  }

  private schedule(t: number, st: number, bar: number) {
    const m = this.mode;
    const prog = PROGS[Math.floor(bar / 8) % PROGS.length];
    const [root, minor] = prog[bar % 4];
    const third = root + (minor ? 3 : 4);
    const fifth = root + 7;
    const section = Math.floor(bar / 16) % 4; // 0 build, 1 full, 2 breakdown-ish, 3 full+lead
    const race = m === 'race';
    const title = m === 'title';
    const results = m === 'results';
    const full = race && section !== 2;
    const fillBar = bar % 8 === 7;
    // ---- drums
    if (race || (title && bar % 16 >= 8)) {
      const kickOn = race ? st % 4 === 0 && !(fillBar && st >= 12) : st % 8 === 0;
      if (kickOn) this.kick(t, race ? 1 : 0.6);
      if (race && (st === 4 || st === 12) && section !== 0) this.snare(t, 0.55);
      if (race && fillBar && st >= 12) this.snare(t, 0.25 + (st - 12) * 0.1);
      if (st % 4 === 2) this.hat(t, false, race ? 0.22 : 0.12);
      if (full && st % 2 === 1) this.hat(t, false, 0.07);
      if (race && section === 3 && st === 14) this.hat(t, true, 0.12);
    }
    // ---- bass
    if (!results) {
      const pat = race ? [1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0] : [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
      if (pat[st]) {
        const oct = race && (st === 6 || st === 14) ? 12 : 0;
        this.bass(t, mtof(root - 12 + oct), race ? 0.13 : 0.3, race ? 0.32 : 0.22);
      }
    }
    // ---- arp
    if ((race && section !== 0) || title || (race && bar % 2 === 1)) {
      const notes = [root + 12, third + 12, fifth + 12, root + 24, fifth + 12, third + 24, root + 24, fifth + 24];
      const n = notes[(st + Math.floor(bar / 2)) % notes.length];
      if (st % (race ? 1 : 2) === 0) this.arp(t, mtof(n), race ? 0.06 : 0.05);
    }
    // ---- pads on bar start
    if (st === 0) {
      const dur = (60 / this.bpm) * 4;
      this.pad(t, [mtof(root), mtof(third), mtof(fifth), mtof(root + 12)], dur * 1.02, race ? (section === 2 ? 0.07 : 0.04) : 0.07);
    }
    // ---- lead melody in section 3
    if (race && section === 3 && st % 4 === 0) {
      const scale = [0, 3, 5, 7, 10, 12];
      const idx = Math.floor((Math.sin(bar * 1.7 + st * 0.9) * 0.5 + 0.5) * scale.length) % scale.length;
      this.lead(t, mtof(root + 24 + scale[idx]), (60 / this.bpm) * 0.9);
    }
  }

  private env(g: GainNode, t: number, a: number, peak: number, d: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  private kick(t: number, v: number) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = c.createGain();
    this.env(g, t, 0.002, 0.9 * v, 0.32);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.4);
    // sidechain-style duck
    this.duck.gain.setValueAtTime(0.35, t);
    this.duck.gain.linearRampToValueAtTime(1, t + 0.18);
  }
  private snare(t: number, v: number) {
    const c = this.ctx;
    const n = c.createBufferSource();
    n.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1900;
    f.Q.value = 0.7;
    const g = c.createGain();
    this.env(g, t, 0.001, v, 0.18);
    n.connect(f).connect(g).connect(this.out);
    g.connect(this.send);
    n.start(t, Math.random());
    n.stop(t + 0.25);
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    const og = c.createGain();
    this.env(og, t, 0.001, v * 0.5, 0.1);
    o.connect(og).connect(this.out);
    o.start(t);
    o.stop(t + 0.15);
  }
  private hat(t: number, open: boolean, v: number) {
    const c = this.ctx;
    const n = c.createBufferSource();
    n.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7500;
    const g = c.createGain();
    this.env(g, t, 0.001, v, open ? 0.22 : 0.04);
    n.connect(f).connect(g).connect(this.duck);
    n.start(t, Math.random());
    n.stop(t + 0.3);
  }
  private bass(t: number, f: number, dur: number, v: number) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const sub = c.createOscillator();
    sub.frequency.value = f / 2;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(180, t);
    lp.frequency.linearRampToValueAtTime(1300, t + 0.02);
    lp.frequency.exponentialRampToValueAtTime(200, t + dur);
    const g = c.createGain();
    this.env(g, t, 0.004, v, dur);
    o.connect(lp).connect(g);
    sub.connect(g);
    g.connect(this.duck);
    o.start(t);
    sub.start(t);
    o.stop(t + dur + 0.05);
    sub.stop(t + dur + 0.05);
  }
  private arp(t: number, f: number, v: number) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const lp = c.createBiquadFilter();
    lp.frequency.value = 2600;
    const g = c.createGain();
    this.env(g, t, 0.003, v, 0.12);
    o.connect(lp).connect(g).connect(this.duck);
    g.connect(this.delay);
    o.start(t);
    o.stop(t + 0.2);
  }
  private pad(t: number, freqs: number[], dur: number, v: number) {
    const c = this.ctx;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.linearRampToValueAtTime(1800, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(700, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(v, t + dur * 0.25);
    g.gain.linearRampToValueAtTime(v * 0.8, t + dur * 0.8);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    lp.connect(g).connect(this.duck);
    g.connect(this.send);
    for (const f of freqs)
      for (const det of [-8, 0, 7]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
  }
  private lead(t: number, f: number, dur: number) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const vib = c.createOscillator();
    vib.frequency.value = 5.5;
    const vg = c.createGain();
    vg.gain.value = 6;
    vib.connect(vg).connect(o.detune);
    const lp = c.createBiquadFilter();
    lp.frequency.value = 3200;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.03);
    g.gain.setValueAtTime(0.07, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(this.duck);
    g.connect(this.delay);
    g.connect(this.send);
    o.start(t);
    vib.start(t);
    o.stop(t + dur + 0.05);
    vib.stop(t + dur + 0.05);
  }
}
