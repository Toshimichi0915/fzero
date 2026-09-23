import * as THREE from 'three';
import { clamp, smooth, smoother } from '../core/util';

export const F_GAP = 1; // no road surface (jump gap)
export const F_NORAIL_L = 2;
export const F_NORAIL_R = 4;
export const F_LOOP = 8; // use rotation-minimising frames (vertical loops)
export const F_TUNNEL = 16;
export const F_NOSUPPORT = 32;
export const WRAP_CURL = 0.97;

export interface Frame {
  p: THREE.Vector3;
  t: THREE.Vector3;
  u: THREE.Vector3;
  r: THREE.Vector3;
}
export const makeFrame = (): Frame => ({
  p: new THREE.Vector3(),
  t: new THREE.Vector3(),
  u: new THREE.Vector3(),
  r: new THREE.Vector3(),
});

/** Raw centreline produced by the turtle builder. */
export interface RawLine {
  pts: THREE.Vector3[];
  roll: number[];
  curl: number[];
  flags: number[];
  markers: Record<string, number>; // name -> index into pts
}

/**
 * Turtle-style course builder. Every command's height profile is eased so
 * slope is continuous between commands.
 */
export class Turtle {
  pos: THREE.Vector3;
  heading: number; // 0 = +X; positive = left turn (towards -Z)
  roll = 0;
  curl = 0; // cross-section curl: 0 flat, 1 closed tube (inside), -1 closed pipe (outside)
  line: RawLine = { pts: [], roll: [], curl: [], flags: [], markers: {} };
  flag = 0;
  step = 1;

  constructor(pos: THREE.Vector3, heading: number) {
    this.pos = pos.clone();
    this.heading = heading;
    this.push(0);
  }
  clone() {
    const c = new Turtle(this.pos, this.heading);
    c.roll = this.roll;
    c.curl = this.curl;
    c.flag = this.flag;
    c.line = {
      pts: this.line.pts.slice(),
      roll: this.line.roll.slice(),
      curl: this.line.curl.slice(),
      flags: this.line.flags.slice(),
      markers: { ...this.line.markers },
    };
    return c;
  }
  dir(h = this.heading) {
    return new THREE.Vector3(Math.cos(h), 0, -Math.sin(h));
  }
  private push(extraFlag: number) {
    this.line.pts.push(this.pos.clone());
    this.line.roll.push(this.roll);
    this.line.curl.push(this.curl);
    this.line.flags.push(this.flag | extraFlag);
  }
  mark(name: string) {
    this.line.markers[name] = this.line.pts.length - 1;
    return this;
  }
  /** apply flags to everything generated inside fn */
  with(flag: number, fn: () => void) {
    const old = this.flag;
    this.flag |= flag;
    fn();
    this.flag = old;
    return this;
  }
  straight(len: number, dy = 0) {
    const n = Math.max(1, Math.round(len / this.step));
    const p0 = this.pos.clone();
    const d = this.dir();
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      this.pos.copy(p0).addScaledVector(d, len * f);
      this.pos.y = p0.y + dy * smooth(f);
      this.push(0);
    }
    return this;
  }
  /** Eased turn: curvature ramps in and out. radius = average radius. */
  turn(angleDeg: number, radius: number, dy = 0) {
    const A = (angleDeg * Math.PI) / 180;
    const len = Math.abs(A) * radius;
    const n = Math.max(2, Math.round(len / this.step));
    const h0 = this.heading;
    const y0 = this.pos.y;
    const sub = 4;
    for (let i = 1; i <= n; i++) {
      for (let k = 1; k <= sub; k++) {
        const f = (i - 1 + k / sub) / n;
        const fm = (i - 1 + (k - 0.5) / sub) / n;
        const h = h0 + A * smooth(fm);
        this.pos.addScaledVector(this.dir(h), len / n / sub);
        this.heading = h0 + A * smooth(f);
      }
      this.pos.y = y0 + dy * smooth(i / n);
      this.push(0);
    }
    this.heading = h0 + A;
    return this;
  }
  /** Constant radius helix (eased at ends). */
  helix(angleDeg: number, radius: number, dy: number) {
    const A = (angleDeg * Math.PI) / 180;
    const len = Math.abs(A) * radius;
    const n = Math.max(2, Math.round(len / this.step));
    const ease = Math.min(0.12, 60 / len); // fraction used to ease curvature in/out
    // curvature profile k(f): ramps 0->1 over ease, 1, ramps down; normalise so integral = A
    const prof = (f: number) => (f < ease ? smooth(f / ease) : f > 1 - ease ? smooth((1 - f) / ease) : 1);
    let integ = 0;
    const M = 2000;
    for (let i = 0; i < M; i++) integ += prof((i + 0.5) / M) / M;
    const h0 = this.heading;
    const y0 = this.pos.y;
    let acc = 0;
    const sub = 4;
    for (let i = 1; i <= n; i++) {
      for (let k = 1; k <= sub; k++) {
        const fm = (i - 1 + (k - 0.5) / sub) / n;
        const dA = (A * prof(fm)) / integ / n / sub;
        const h = this.heading + dA * 0.5;
        this.pos.addScaledVector(this.dir(h), len / n / sub);
        this.heading += dA;
        acc += dA;
      }
      const f = i / n;
      this.pos.y = y0 + dy * smooth(f);
      this.push(0);
    }
    this.pos.y = y0 + dy;
    this.heading = h0 + A;
    return this;
  }
  /** Vertical loop, shifting sideways by `shift` (positive = right). */
  loop(radius: number, shift: number) {
    const len = Math.PI * 2 * radius;
    const n = Math.round(len / this.step);
    const p0 = this.pos.clone();
    const f = this.dir();
    const right = new THREE.Vector3(-f.z, 0, f.x); // f x up ... right-hand side
    this.with(F_LOOP | F_NOSUPPORT, () => {
      for (let i = 1; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        this.pos
          .copy(p0)
          .addScaledVector(f, radius * Math.sin(a))
          .addScaledVector(right, shift * smoother(i / n));
        this.pos.y = p0.y + radius * (1 - Math.cos(a));
        this.push(0);
      }
    });
    return this;
  }
  /** Straight section while the cross-section curls towards `target` (tube / pipe transitions). */
  curlTo(target: number, len: number, dy = 0) {
    const n = Math.max(1, Math.round(len / this.step));
    const c0 = this.curl;
    const p0 = this.pos.clone();
    const d = this.dir();
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      this.pos.copy(p0).addScaledVector(d, len * f);
      this.pos.y = p0.y + dy * smooth(f);
      this.curl = c0 + (target - c0) * smoother(f);
      this.push(0);
    }
    this.curl = target;
    return this;
  }
  /** Roll the road to `deg` degrees (e.g. 90 = wall ride, 180 = upside down) over len. */
  rollTo(deg: number, len: number, dy = 0) {
    const target = (deg * Math.PI) / 180;
    const turns = (target - this.roll) / (Math.PI * 2);
    return this.corkscrew(len, turns, dy);
  }
  /** Vertical climb: quarter arc up, vertical straight, quarter arc over (ends reversed, higher). */
  climb(radius: number, height: number) {
    const p0 = this.pos.clone();
    const f = this.dir();
    const pts: THREE.Vector3[] = [];
    const q = Math.round((Math.PI / 2) * radius / this.step);
    for (let i = 1; i <= q; i++) {
      const a = (i / q) * (Math.PI / 2);
      pts.push(p0.clone().addScaledVector(f, radius * Math.sin(a)).setY(p0.y + radius * (1 - Math.cos(a))));
    }
    const top = p0.clone().addScaledVector(f, radius).setY(p0.y + radius);
    const nv = Math.round(height / this.step);
    for (let i = 1; i <= nv; i++) pts.push(top.clone().setY(top.y + (height * i) / nv));
    const c = top.clone().setY(top.y + height).addScaledVector(f, -radius);
    for (let i = 1; i <= q; i++) {
      const a = (i / q) * (Math.PI / 2);
      pts.push(c.clone().addScaledVector(f, radius * Math.cos(a)).setY(c.y + radius * Math.sin(a)));
    }
    this.with(F_LOOP | F_NOSUPPORT, () => {
      for (const p of pts) {
        this.pos.copy(p);
        this.push(0);
      }
    });
    this.heading += Math.PI;
    return this;
  }
  corkscrew(len: number, turns: number, dy = 0) {
    const n = Math.max(1, Math.round(len / this.step));
    const r0 = this.roll;
    const p0 = this.pos.clone();
    const d = this.dir();
    this.with(F_NOSUPPORT, () => {
      for (let i = 1; i <= n; i++) {
        const f = i / n;
        this.pos.copy(p0).addScaledVector(d, len * f);
        this.pos.y = p0.y + dy * smooth(f);
        this.roll = r0 + Math.PI * 2 * turns * smoother(f);
        this.push(0);
      }
    });
    this.roll = r0 + Math.PI * 2 * turns;
    return this;
  }
  /** kicker ramp, a gap with no road, then a downhill landing zone */
  jump(ramp: number, gap: number, land: number, drop: number, kick = 6) {
    const total = ramp + gap + land;
    const n = Math.round(total / this.step);
    const p0 = this.pos.clone();
    const d = this.dir();
    for (let i = 1; i <= n; i++) {
      const s = (i / n) * total;
      this.pos.copy(p0).addScaledVector(d, s);
      const u = (s - ramp) / gap;
      const k = s <= ramp ? kick * (s / ramp) ** 2 : kick * (1 - smooth(u));
      const dropF = smooth((s - ramp) / (gap + land * 0.8));
      this.pos.y = p0.y + k - drop * dropF;
      const inGap = s > ramp && s < ramp + gap;
      this.push(inGap ? F_GAP | F_NORAIL_L | F_NORAIL_R | F_NOSUPPORT : 0);
    }
    return this;
  }
  /** Smoothly join to a target point/direction with a cubic Hermite curve. */
  joinTo(target: THREE.Vector3, targetDir: THREE.Vector3, targetRoll = this.roll, tension = 1) {
    const p0 = this.pos.clone();
    const t0 = this.dir();
    // include current slope
    const dist = p0.distanceTo(target);
    const m = dist * tension;
    const m0 = t0.clone().multiplyScalar(m);
    const m1 = targetDir.clone().setY(0).normalize().multiplyScalar(m);
    const r0 = this.roll;
    const N = Math.round((dist * 1.6) / this.step) + 10;
    const tmp: THREE.Vector3[] = [];
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const p = new THREE.Vector3()
        .addScaledVector(p0, h00)
        .addScaledVector(m0, h10)
        .addScaledVector(target, h01)
        .addScaledVector(m1, h11);
      // height eased separately for a smooth vertical profile
      p.y = p0.y + (target.y - p0.y) * smooth(t);
      tmp.push(p);
    }
    for (let i = 0; i < tmp.length; i++) {
      this.pos.copy(tmp[i]);
      this.roll = r0 + (targetRoll - r0) * smooth((i + 1) / tmp.length);
      this.push(0);
    }
    const last = tmp[tmp.length - 1];
    const prev = tmp[tmp.length - 2];
    this.heading = Math.atan2(-(last.z - prev.z), last.x - prev.x);
    return this;
  }
}

/** Uniformly sampled course path with orthonormal frames. */
export class Path {
  n: number;
  ds: number;
  length: number;
  closed: boolean;
  pos: Float32Array;
  tan: Float32Array;
  up: Float32Array;
  right: Float32Array;
  leftExt: Float32Array; // extent to the left (positive number, x = -leftExt)
  rightExt: Float32Array;
  flags: Uint8Array;
  curl: Float32Array; // cross-section curl (-1..1)
  curvature: Float32Array; // signed lateral curvature (positive = turning left) in the road plane
  markers: Record<string, number> = {}; // name -> s
  name: string;
  index = 0;

  constructor(name: string, raw: RawLine, closed: boolean, halfWidth: number) {
    this.name = name;
    this.closed = closed;
    const pts = raw.pts.slice();
    if (closed) {
      // drop duplicate end point
      if (pts[0].distanceTo(pts[pts.length - 1]) < 0.5) pts.pop();
    }
    // cumulative length
    const cum: number[] = [0];
    const cnt = closed ? pts.length + 1 : pts.length;
    for (let i = 1; i < cnt; i++) cum.push(cum[i - 1] + pts[i % pts.length].distanceTo(pts[i - 1]));
    const L = cum[cum.length - 1];
    const n = Math.round(L / 1.0);
    this.n = closed ? n : n + 1;
    this.ds = L / n;
    this.length = L;
    const N = this.n;
    this.pos = new Float32Array(N * 3);
    this.tan = new Float32Array(N * 3);
    this.up = new Float32Array(N * 3);
    this.right = new Float32Array(N * 3);
    this.leftExt = new Float32Array(N).fill(halfWidth);
    this.rightExt = new Float32Array(N).fill(halfWidth);
    this.flags = new Uint8Array(N);
    this.curvature = new Float32Array(N);
    const roll = new Float32Array(N);
    this.curl = new Float32Array(N);

    // resample
    let j = 0;
    for (let i = 0; i < N; i++) {
      const s = i * this.ds;
      while (j < cum.length - 2 && cum[j + 1] < s) j++;
      const seg = cum[j + 1] - cum[j];
      const f = seg > 0 ? (s - cum[j]) / seg : 0;
      const a = pts[j % pts.length];
      const b = pts[(j + 1) % pts.length];
      this.pos[i * 3] = a.x + (b.x - a.x) * f;
      this.pos[i * 3 + 1] = a.y + (b.y - a.y) * f;
      this.pos[i * 3 + 2] = a.z + (b.z - a.z) * f;
      const ra = raw.roll[j % pts.length];
      const rb = raw.roll[(j + 1) % pts.length];
      roll[i] = ra + (rb - ra) * f;
      const ca = raw.curl[j % pts.length],
        cb = raw.curl[(j + 1) % pts.length];
      this.curl[i] = ca + (cb - ca) * f;
      this.flags[i] = f < 0.5 ? raw.flags[j % pts.length] : raw.flags[(j + 1) % pts.length];
    }
    for (const k in raw.markers) this.markers[k] = cum[raw.markers[k]];

    const P = (i: number, v: THREE.Vector3) => {
      i = this.wrapI(i);
      return v.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
    };
    // tangents (smoothed central difference)
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      t = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      const i0 = closed ? i - 2 : Math.max(0, i - 2);
      const i1 = closed ? i + 2 : Math.min(N - 1, i + 2);
      P(i1, a).sub(P(i0, b)).normalize();
      this.tan.set([a.x, a.y, a.z], i * 3);
    }
    // rotation minimising frames (double reflection)
    const T = (i: number, v: THREE.Vector3) => v.set(this.tan[i * 3], this.tan[i * 3 + 1], this.tan[i * 3 + 2]);
    const Y = new THREE.Vector3(0, 1, 0);
    const rmfU: THREE.Vector3[] = [];
    T(0, t);
    const u0 = Y.clone().addScaledVector(t, -Y.dot(t)).normalize();
    rmfU.push(u0);
    const x0 = new THREE.Vector3(),
      x1 = new THREE.Vector3(),
      t0 = new THREE.Vector3(),
      t1 = new THREE.Vector3(),
      v1 = new THREE.Vector3(),
      rL = new THREE.Vector3(),
      tL = new THREE.Vector3(),
      v2 = new THREE.Vector3();
    for (let i = 0; i < N - 1; i++) {
      P(i, x0);
      P(i + 1, x1);
      T(i, t0);
      T(i + 1, t1);
      v1.subVectors(x1, x0);
      const c1 = v1.dot(v1);
      if (c1 < 1e-9) {
        rmfU.push(rmfU[i].clone());
        continue;
      }
      rL.copy(rmfU[i]).addScaledVector(v1, (-2 / c1) * v1.dot(rmfU[i]));
      tL.copy(t0).addScaledVector(v1, (-2 / c1) * v1.dot(t0));
      v2.subVectors(t1, tL);
      const c2 = v2.dot(v2);
      const r = rL.clone();
      if (c2 > 1e-12) r.addScaledVector(v2, (-2 / c2) * v2.dot(rL));
      r.addScaledVector(t1, -r.dot(t1)).normalize();
      rmfU.push(r);
    }
    // correction angle so that outside of loops, up == world-up projected
    const err = new Float64Array(N);
    const valid = new Uint8Array(N);
    const tgt = new THREE.Vector3();
    const cr = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      T(i, t);
      if (this.flags[i] & F_LOOP || Math.abs(t.y) > 0.9) continue;
      tgt.copy(Y).addScaledVector(t, -t.y).normalize();
      const u = rmfU[i];
      cr.crossVectors(u, tgt);
      err[i] = Math.atan2(cr.dot(t), u.dot(tgt));
      valid[i] = 1;
    }
    // unwrap & fill invalid spans
    let lastValid = -1;
    for (let i = 0; i < N; i++) {
      if (!valid[i]) continue;
      if (lastValid >= 0) {
        let d = err[i] - err[lastValid];
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        err[i] = err[lastValid] + d;
        for (let k = lastValid + 1; k < i; k++) err[k] = err[lastValid] + (d * (k - lastValid)) / (i - lastValid);
      } else {
        for (let k = 0; k < i; k++) err[k] = err[i];
      }
      lastValid = i;
    }
    for (let k = lastValid + 1; k < N; k++) err[k] = err[lastValid];

    // signed horizontal curvature for auto-banking
    const head = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      T(i, t);
      head[i] = Math.atan2(-t.z, t.x);
    }
    const kraw = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const ia = closed ? this.wrapI(i - 1) : Math.max(0, i - 1);
      const ib = closed ? this.wrapI(i + 1) : Math.min(N - 1, i + 1);
      let d = head[ib] - head[ia];
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      T(i, t);
      const horiz = Math.hypot(t.x, t.z);
      kraw[i] = this.flags[i] & F_LOOP || horiz < 0.5 ? 0 : (d / ((ib - ia) * this.ds)) * horiz;
    }
    const W = 45;
    const bank = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      let acc = 0,
        wsum = 0;
      for (let k = -W; k <= W; k++) {
        let ii = i + k;
        if (closed) ii = this.wrapI(ii);
        else if (ii < 0 || ii >= N) continue;
        const w = 1 - Math.abs(k) / (W + 1);
        acc += kraw[ii] * w;
        wsum += w;
      }
      const kk = acc / wsum;
      bank[i] = -clamp(kk * 75, -0.6, 0.6);
    }

    const U = new THREE.Vector3(),
      R = new THREE.Vector3();
    for (let i = 0; i < N; i++) {
      T(i, t);
      U.copy(rmfU[i]).applyAxisAngle(t, err[i] + bank[i] + roll[i]).normalize();
      R.crossVectors(t, U).normalize();
      U.crossVectors(R, t).normalize();
      this.up.set([U.x, U.y, U.z], i * 3);
      this.right.set([R.x, R.y, R.z], i * 3);
      this.curvature[i] = kraw[i];
    }
    // true in-plane curvature (for AI & physics): d(tangent)/ds . right
    for (let i = 0; i < N; i++) {
      const ia = closed ? this.wrapI(i - 1) : Math.max(0, i - 1);
      const ib = closed ? this.wrapI(i + 1) : Math.min(N - 1, i + 1);
      T(ib, a);
      T(ia, b);
      a.sub(b).divideScalar((ib - ia) * this.ds);
      R.set(this.right[i * 3], this.right[i * 3 + 1], this.right[i * 3 + 2]);
      this.curvature[i] = -a.dot(R); // positive = turning left
    }
    // light smoothing of curvature
    const cs = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let acc = 0,
        c = 0;
      for (let k = -6; k <= 6; k++) {
        let ii = i + k;
        if (closed) ii = this.wrapI(ii);
        else if (ii < 0 || ii >= N) continue;
        acc += this.curvature[ii];
        c++;
      }
      cs[i] = acc / c;
    }
    this.curvature = cs;
  }

  wrapI(i: number) {
    if (this.closed) return ((i % this.n) + this.n) % this.n;
    return i < 0 ? 0 : i >= this.n ? this.n - 1 : i;
  }
  wrapS(s: number) {
    if (!this.closed) return s;
    return ((s % this.length) + this.length) % this.length;
  }
  idx(s: number): [number, number, number] {
    let f = s / this.ds;
    if (this.closed) f = ((f % this.n) + this.n) % this.n;
    else f = clamp(f, 0, this.n - 1.0001);
    const i0 = Math.floor(f);
    const i1 = this.closed ? (i0 + 1) % this.n : Math.min(this.n - 1, i0 + 1);
    return [i0, i1, f - i0];
  }
  sample(s: number, out: Frame) {
    const [i0, i1, f] = this.idx(s);
    const g = 1 - f;
    const A = this.pos,
      T = this.tan,
      U = this.up,
      R = this.right;
    const a = i0 * 3,
      b = i1 * 3;
    out.p.set(A[a] * g + A[b] * f, A[a + 1] * g + A[b + 1] * f, A[a + 2] * g + A[b + 2] * f);
    out.t.set(T[a] * g + T[b] * f, T[a + 1] * g + T[b + 1] * f, T[a + 2] * g + T[b + 2] * f).normalize();
    out.u.set(U[a] * g + U[b] * f, U[a + 1] * g + U[b + 1] * f, U[a + 2] * g + U[b + 2] * f);
    out.r.crossVectors(out.t, out.u).normalize();
    out.u.crossVectors(out.r, out.t).normalize();
    return out;
  }
  ext(s: number): [number, number] {
    const [i0, i1, f] = this.idx(s);
    return [
      this.leftExt[i0] * (1 - f) + this.leftExt[i1] * f,
      this.rightExt[i0] * (1 - f) + this.rightExt[i1] * f,
    ];
  }
  curlAt(s: number) {
    const [i0, i1, f] = this.idx(s);
    return this.curl[i0] * (1 - f) + this.curl[i1] * f;
  }
  /** true where the cross-section is a closed tube/pipe: lateral position wraps, no walls */
  wraps(s: number) {
    return Math.abs(this.curlAt(s)) > WRAP_CURL;
  }
  /** circumference of the (closed) cross-section at s */
  girth(s: number) {
    const [L, R] = this.ext(s);
    return L + R;
  }
  /**
   * Point on the (possibly curled) road surface at lateral arc-length x, h above it.
   * outN = surface normal (vehicle up), outT = lateral tangent (vehicle right).
   */
  surf(s: number, x: number, h: number, outP: THREE.Vector3, outN: THREE.Vector3, outT?: THREE.Vector3, fr = tmpFrame) {
    this.sample(s, fr);
    const c = this.curlAt(s);
    let lat = x,
      up = 0,
      nx = 0,
      ny = 1;
    if (Math.abs(c) > 1e-4) {
      const k = (c * Math.PI * 2) / this.girth(s);
      const phi = x * k;
      lat = Math.sin(phi) / k;
      up = (1 - Math.cos(phi)) / k;
      nx = -Math.sin(phi);
      ny = Math.cos(phi);
    }
    outN.copy(fr.r).multiplyScalar(nx).addScaledVector(fr.u, ny);
    outP.copy(fr.p).addScaledVector(fr.r, lat).addScaledVector(fr.u, up).addScaledVector(outN, h);
    if (outT) outT.copy(fr.r).multiplyScalar(ny).addScaledVector(fr.u, -nx);
    return fr;
  }
  flagAt(s: number) {
    const [i0, i1, f] = this.idx(s);
    return f < 0.5 ? this.flags[i0] : this.flags[i1];
  }
  curvAt(s: number) {
    const [i0, i1, f] = this.idx(s);
    return this.curvature[i0] * (1 - f) + this.curvature[i1] * f;
  }
  /** world position of a point on the surface */
  point(s: number, x: number, h: number, out: THREE.Vector3, fr = tmpFrame) {
    this.sample(s, fr);
    return out.copy(fr.p).addScaledVector(fr.r, x).addScaledVector(fr.u, h);
  }
  /**
   * Project a world point onto the path, searching around sHint.
   * Returns [s, x, h].
   */
  project(p: THREE.Vector3, sHint: number, range = 80): [number, number, number] {
    const step = 2;
    let best = Infinity,
      bestS = sHint;
    for (let d = -range; d <= range; d += step) {
      let s = sHint + d;
      if (!this.closed && (s < 0 || s > this.length)) continue;
      s = this.wrapS(s);
      const [i0] = this.idx(s);
      const dx = p.x - this.pos[i0 * 3],
        dy = p.y - this.pos[i0 * 3 + 1],
        dz = p.z - this.pos[i0 * 3 + 2];
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd < best) {
        best = dd;
        bestS = s;
      }
    }
    // refine along tangent
    let s = bestS;
    for (let it = 0; it < 3; it++) {
      this.sample(s, tmpFrame);
      const along = tmpV.subVectors(p, tmpFrame.p).dot(tmpFrame.t);
      s = this.wrapS(s + along);
      if (!this.closed) s = clamp(s, 0, this.length);
    }
    this.sample(s, tmpFrame);
    tmpV.subVectors(p, tmpFrame.p);
    return [s, tmpV.dot(tmpFrame.r), tmpV.dot(tmpFrame.u)];
  }
}
const tmpFrame = makeFrame();
const tmpV = new THREE.Vector3();
