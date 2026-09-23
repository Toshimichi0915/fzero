import * as THREE from 'three';
import { Music } from './Music';

/** Procedural audio: engines, 3D fly-bys, effects and music. No samples needed. */
export class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  sfx!: GainNode;
  musicBus!: GainNode;
  reverb!: ConvolverNode;
  reverbSend!: GainNode;
  noise!: AudioBuffer;
  music: Music | null = null;
  volume = { master: 0.8, music: 0.55, sfx: 0.9 };
  // player engine
  private eng: {
    o1: OscillatorNode;
    o2: OscillatorNode;
    whine: OscillatorNode;
    lp: BiquadFilterNode;
    gain: GainNode;
    whineGain: GainNode;
    roar: AudioBufferSourceNode;
    roarBp: BiquadFilterNode;
    roarGain: GainNode;
    wind: AudioBufferSourceNode;
    windGain: GainNode;
    windLp: BiquadFilterNode;
  } | null = null;
  private voices: { o: OscillatorNode; n: AudioBufferSourceNode; bp: BiquadFilterNode; g: GainNode; p: PannerNode; lp: BiquadFilterNode }[] = [];
  private warnTimer = 0;
  private scrape: { g: GainNode; bp: BiquadFilterNode } | null = null;

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume.master;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.volume.sfx;
    this.sfx.connect(this.master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.volume.music;
    this.musicBus.connect(this.master);
    // reverb
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.8, 2.2);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.35;
    this.reverbSend.connect(this.reverb).connect(this.master);
    // noise
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.music = new Music(ctx, this.musicBus, this.reverbSend, this.noise);
    this.setupEngine();
    this.setupVoices();
    this.setupScrape();
  }

  setVolumes(master: number, music: number, sfx: number) {
    this.volume = { master, music, sfx };
    if (!this.ctx) return;
    this.master.gain.value = master;
    this.musicBus.gain.value = music;
    this.sfx.gain.value = sfx;
  }

  private impulse(sec: number, decay: number) {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return b;
  }
  private noiseSrc(loop = true) {
    const s = this.ctx!.createBufferSource();
    s.buffer = this.noise;
    s.loop = loop;
    s.loopStart = Math.random();
    return s;
  }

  private setupEngine() {
    const ctx = this.ctx!;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 800;
    lp.Q.value = 3;
    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    const o2g = ctx.createGain();
    o2g.gain.value = 0.4;
    o1.connect(lp);
    o2.connect(o2g).connect(lp);
    lp.connect(gain);
    const whine = ctx.createOscillator();
    whine.type = 'sine';
    const whineGain = ctx.createGain();
    whineGain.gain.value = 0;
    whine.connect(whineGain).connect(gain);
    const roar = this.noiseSrc();
    const roarBp = ctx.createBiquadFilter();
    roarBp.type = 'bandpass';
    roarBp.Q.value = 0.8;
    const roarGain = ctx.createGain();
    roarGain.gain.value = 0;
    roar.connect(roarBp).connect(roarGain).connect(gain);
    const wind = this.noiseSrc();
    const windLp = ctx.createBiquadFilter();
    windLp.type = 'lowpass';
    windLp.frequency.value = 600;
    const windGain = ctx.createGain();
    windGain.gain.value = 0;
    wind.connect(windLp).connect(windGain).connect(this.sfx);
    gain.connect(this.sfx);
    o1.start();
    o2.start();
    whine.start();
    roar.start();
    wind.start();
    this.eng = { o1, o2, whine, lp, gain, whineGain, roar, roarBp, roarGain, wind, windGain, windLp };
  }

  private setupVoices() {
    const ctx = this.ctx!;
    for (let i = 0; i < 5; i++) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 8;
      p.rolloffFactor = 1.4;
      p.maxDistance = 400;
      const g = ctx.createGain();
      g.gain.value = 0;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1200;
      const n = this.noiseSrc();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.2;
      const ng = ctx.createGain();
      ng.gain.value = 1.4;
      o.connect(lp).connect(g);
      n.connect(bp).connect(ng).connect(g);
      g.connect(p).connect(this.sfx);
      o.start();
      n.start();
      this.voices.push({ o, n, bp, g, p, lp });
    }
  }
  private setupScrape() {
    const ctx = this.ctx!;
    const n = this.noiseSrc();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3000;
    bp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.value = 0;
    n.connect(bp).connect(g).connect(this.sfx);
    n.start();
    this.scrape = { g, bp };
  }

  /** per-frame update of continuous sounds */
  update(
    dt: number,
    listener: THREE.Camera,
    player: { v: number; max: number; throttle: number; boost: boolean; air: boolean; active: boolean; energy: number; scraping: number },
    others: { pos: THREE.Vector3; vel: THREE.Vector3; throttle: number }[],
    camVel: THREE.Vector3,
  ) {
    const ctx = this.ctx;
    if (!ctx || !this.eng) return;
    const t = ctx.currentTime;
    const e = this.eng;
    const f = Math.min(1.4, player.v / player.max);
    const on = player.active ? 1 : 0;
    const base = 38 + f * 95 + player.throttle * 12;
    e.o1.frequency.setTargetAtTime(base, t, 0.05);
    e.o2.frequency.setTargetAtTime(base * 0.5, t, 0.05);
    e.whine.frequency.setTargetAtTime(700 + f * 1900, t, 0.08);
    e.whineGain.gain.setTargetAtTime(0.05 + f * 0.05, t, 0.1);
    e.lp.frequency.setTargetAtTime(300 + player.throttle * 900 + f * 1300 + (player.boost ? 1500 : 0), t, 0.05);
    e.roarBp.frequency.setTargetAtTime(400 + f * 1200, t, 0.05);
    e.roarGain.gain.setTargetAtTime((player.boost ? 0.9 : 0.12 + player.throttle * 0.2) * on, t, 0.08);
    e.gain.gain.setTargetAtTime(on * (0.12 + player.throttle * 0.08) * (player.air ? 0.7 : 1), t, 0.08);
    e.windGain.gain.setTargetAtTime(on * f * f * 0.35, t, 0.1);
    e.windLp.frequency.setTargetAtTime(400 + f * 2500, t, 0.1);
    if (this.scrape) this.scrape.g.gain.setTargetAtTime(player.scraping * 0.5, t, 0.03);

    // listener
    const L = ctx.listener;
    const fw = new THREE.Vector3(0, 0, -1).applyQuaternion(listener.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(listener.quaternion);
    if (L.positionX) {
      L.positionX.setTargetAtTime(listener.position.x, t, 0.02);
      L.positionY.setTargetAtTime(listener.position.y, t, 0.02);
      L.positionZ.setTargetAtTime(listener.position.z, t, 0.02);
      L.forwardX.setTargetAtTime(fw.x, t, 0.02);
      L.forwardY.setTargetAtTime(fw.y, t, 0.02);
      L.forwardZ.setTargetAtTime(fw.z, t, 0.02);
      L.upX.setTargetAtTime(up.x, t, 0.02);
      L.upY.setTargetAtTime(up.y, t, 0.02);
      L.upZ.setTargetAtTime(up.z, t, 0.02);
    }
    // opponent fly-bys: nearest N get voices, doppler-shifted
    for (let i = 0; i < this.voices.length; i++) {
      const vo = this.voices[i];
      const o = others[i];
      if (!o) {
        vo.g.gain.setTargetAtTime(0, t, 0.1);
        continue;
      }
      const rel = new THREE.Vector3().subVectors(o.pos, listener.position);
      const dist = rel.length();
      const dir = rel.divideScalar(Math.max(dist, 0.01));
      const vs = o.vel.dot(dir); // source moving away (+)
      const vl = camVel.dot(dir); // listener moving toward (+)
      const c = 340;
      const doppler = Math.max(0.4, Math.min(2.5, (c + vl) / (c + vs)));
      const baseF = (60 + o.vel.length() * 0.6) * doppler;
      vo.o.frequency.setTargetAtTime(baseF, t, 0.03);
      vo.bp.frequency.setTargetAtTime(800 * doppler + o.vel.length() * 6, t, 0.03);
      vo.lp.frequency.setTargetAtTime(900 * doppler, t, 0.03);
      vo.g.gain.setTargetAtTime(0.18 * (0.5 + o.throttle * 0.5), t, 0.05);
      vo.p.positionX.setTargetAtTime(o.pos.x, t, 0.02);
      vo.p.positionY.setTargetAtTime(o.pos.y, t, 0.02);
      vo.p.positionZ.setTargetAtTime(o.pos.z, t, 0.02);
    }
    // low energy warning
    if (player.active && player.energy < 25) {
      this.warnTimer -= dt;
      if (this.warnTimer <= 0) {
        this.warnTimer = player.energy < 10 ? 0.25 : 0.5;
        this.beep(1320, 0.07, 0.12, 'square');
      }
    }
    this.music?.update();
  }

  silenceEngine() {
    if (!this.ctx || !this.eng) return;
    const t = this.ctx.currentTime;
    this.eng.gain.gain.setTargetAtTime(0, t, 0.1);
    this.eng.roarGain.gain.setTargetAtTime(0, t, 0.1);
    this.eng.windGain.gain.setTargetAtTime(0, t, 0.1);
    for (const v of this.voices) v.g.gain.setTargetAtTime(0, t, 0.1);
    if (this.scrape) this.scrape.g.gain.setTargetAtTime(0, t, 0.05);
  }

  // ---------------- one-shot effects
  beep(freq: number, dur: number, vol = 0.2, type: OscillatorType = 'sine', when = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfx);
    g.connect(this.reverbSend);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  noiseHit(dur: number, freq: number, q: number, vol: number, sweepTo?: number, when = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + when;
    const n = this.noiseSrc(false);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f).connect(g).connect(this.sfx);
    g.connect(this.reverbSend);
    n.start(t);
    n.stop(t + dur + 0.05);
  }
  wallHit(strength: number) {
    const v = Math.min(0.9, 0.15 + strength / 40);
    this.noiseHit(0.25, 2500, 1.5, v);
    this.beep(180 + Math.random() * 60, 0.3, v * 0.5, 'triangle');
    this.beep(1900 + Math.random() * 400, 0.35, v * 0.12, 'sine');
  }
  carHit(strength: number) {
    const v = Math.min(0.9, 0.2 + strength / 30);
    this.noiseHit(0.18, 900, 1, v);
    this.beep(90, 0.25, v * 0.8, 'sine');
    this.beep(2600, 0.2, v * 0.15, 'square');
  }
  boost() {
    this.noiseHit(1.2, 300, 1.2, 0.7, 4000);
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(900, t + 0.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    const lp = ctx.createBiquadFilter();
    lp.frequency.value = 2500;
    o.connect(lp).connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 1);
  }
  boostPad() {
    this.noiseHit(0.6, 600, 1.5, 0.45, 5000);
    this.beep(880, 0.15, 0.1, 'triangle');
    this.beep(1320, 0.2, 0.08, 'triangle', 0.05);
  }
  land(strength: number) {
    this.beep(60, 0.3, Math.min(0.8, 0.2 + strength / 40), 'sine');
    this.noiseHit(0.3, 400, 0.8, Math.min(0.6, strength / 50));
  }
  explosion() {
    this.noiseHit(2.2, 1800, 0.6, 1.0, 60);
    this.beep(45, 1.4, 0.9, 'sine');
    this.noiseHit(0.4, 5000, 1, 0.5);
  }
  fall() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(700, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 1.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 1.6);
  }
  countdown(n: number) {
    if (n > 0) this.beep(660, 0.35, 0.3, 'square');
    else {
      this.beep(1320, 0.9, 0.3, 'square');
      this.beep(660, 0.9, 0.2, 'square');
    }
  }
  lap(final: boolean) {
    const notes = final ? [660, 880, 1100, 1320, 1760] : [880, 1320];
    notes.forEach((f, i) => this.beep(f, 0.3, 0.18, 'square', i * 0.09));
  }
  menuMove() {
    this.beep(1500, 0.05, 0.08, 'square');
  }
  menuConfirm() {
    this.beep(900, 0.08, 0.12, 'square');
    this.beep(1800, 0.14, 0.1, 'square', 0.06);
  }
  menuBack() {
    this.beep(500, 0.1, 0.1, 'square');
  }
  finish(place: number) {
    const win = place <= 3;
    const seq = win ? [523, 659, 784, 1046, 784, 1046, 1318] : [440, 523, 659, 523];
    seq.forEach((f, i) => this.beep(f, 0.4, 0.2, 'square', i * 0.13));
  }
  ko() {
    this.beep(1760, 0.15, 0.2, 'square');
    this.beep(2350, 0.3, 0.2, 'square', 0.1);
  }
}
