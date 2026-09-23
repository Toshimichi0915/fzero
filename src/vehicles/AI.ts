import { Track, HALF_W } from '../track/Track';
import { F_GAP } from '../track/Path';
import { clamp, RNG } from '../core/util';
import { Vehicle } from './Vehicle';

export interface AIPersona {
  skill: number; // 0.85..1.05 pace multiplier
  aggression: number; // 0..1
  line: number; // preferred lateral bias -1..1
  branchPref: number[]; // per branch probability of taking it
  wobble: number; // steering noise
  boostHappy: number;
}

export function makePersona(r: RNG, idx: number, count: number): AIPersona {
  // better drivers start further back so the pack spreads naturally
  const tier = idx / Math.max(1, count - 1);
  return {
    skill: 0.9 + r() * 0.08 + tier * 0.07,
    aggression: r() * r(),
    line: (r() - 0.5) * 0.8,
    branchPref: [0.25 + r() * 0.5, 0.3 + r() * 0.5],
    wobble: 0.02 + r() * 0.05,
    boostHappy: 0.3 + r() * 0.7,
  };
}

export class AIDriver {
  takeBranch: boolean[] = [];
  noiseT = Math.random() * 100;
  targetX = 0;
  laneOffset = 0;
  startDelay = 0;
  constructor(
    public v: Vehicle,
    public p: AIPersona,
    private rng: RNG,
  ) {}

  update(dt: number, track: Track, all: Vehicle[], player: Vehicle | null, time: number) {
    const v = this.v;
    const c = v.controls;
    c.boost = false;
    c.sideAttack = 0;
    c.spin = false;
    c.lean = 0;
    c.pitch = 0;
    if (v.retired || v.respawnTimer > 0) return;
    if (this.startDelay > 0) {
      // reaction time at the start
      this.startDelay -= dt;
      c.throttle = 0;
      c.steer = 0;
      c.brake = 0;
      return;
    }
    this.noiseT += dt;
    const path = track.paths[v.path];
    const turnMax = v.spec.turn;

    if (v.air) {
      // steer toward the road centre while airborne
      c.steer = clamp(-v.x * 0.12, -1, 1);
      c.throttle = 1;
      c.pitch = v.h > 25 ? 0.6 : 0;
      return;
    }

    // --- look ahead: curvature → safe speed; racing line → target x
    const look = Math.max(40, v.v * 1.6);
    let maxK = 0;
    let lineK = 0;
    let wsum = 0;
    for (let d = 10; d <= look; d += 10) {
      const s = path.closed ? path.wrapS(v.s + d) : Math.min(path.length, v.s + d);
      const k = path.curvAt(s);
      maxK = Math.max(maxK, Math.abs(k) * (1 - d / (look * 2.5)));
      const w = 1 - d / (look + 10);
      lineK += k * w;
      wsum += w;
    }
    lineK /= wsum;
    const [L, R] = path.ext(v.s);
    const half = Math.min(L, R);
    // hug the inside of upcoming bends (k>0 = left = negative x)
    let tx = clamp(-lineK * 3500, -1, 1) * (half - 6) + this.p.line * 6;
    // pit lane when low on energy
    for (const z of track.pitZones) {
      const ds = z.s0 - v.s;
      if (z.path === v.path && ((ds > -10 && ds < 400) || (v.s > z.s0 && v.s < z.s1)) && v.energy < 60) tx = z.x0 + 3;
    }
    // fork decisions (branches splitting off the path we're on)
    for (let bi = 0; bi < track.branches.length; bi++) {
      const b = track.branches[bi];
      if (b.parent !== v.path) continue;
      const ds = b.startS - v.s;
      if (ds > 0 && ds < 550) {
        if (this.takeBranch[bi] === undefined) this.takeBranch[bi] = this.rng() < (this.p.branchPref[bi] ?? 0.4);
        if (this.takeBranch[bi]) tx = b.startOffset;
        else tx = b.startOffset < 0 ? Math.max(tx, -HALF_W + 7) : Math.min(tx, HALF_W - 7);
      } else if (ds < -50 || ds > 2000) delete this.takeBranch[bi];
    }
    // avoid gaps' edges: aim for the centre before jumps
    for (let d = 0; d < 250; d += 25) {
      const s = path.closed ? path.wrapS(v.s + d) : Math.min(path.length, v.s + d);
      if (path.flagAt(s) & F_GAP) {
        tx = tx * 0.2;
        break;
      }
    }

    // --- traffic: overtake around vehicles ahead
    let closestAhead: Vehicle | null = null;
    let closestD = 1e9;
    for (const o of all) {
      if (o === v || o.retired || o.path !== v.path || o.air) continue;
      let ds = o.s - v.s;
      if (path.closed) {
        if (ds > path.length / 2) ds -= path.length;
        if (ds < -path.length / 2) ds += path.length;
      }
      if (ds > 0 && ds < 45 && Math.abs(o.x - v.x) < 5.5) {
        if (ds < closestD) {
          closestD = ds;
          closestAhead = o;
        }
      }
      // opportunistic side attack
      if (Math.abs(ds) < 4 && Math.abs(o.x - v.x) < 6 && Math.abs(o.x - v.x) > 2 && this.rng() < this.p.aggression * dt * 1.2 && (o.isPlayer || this.rng() < 0.3)) {
        c.sideAttack = Math.sign(o.x - v.x);
      }
      if (Math.abs(ds) < 5 && Math.abs(o.x - v.x) < 4 && this.rng() < this.p.aggression * dt * 0.5) c.spin = true;
    }
    // keep a little lateral room from machines alongside
    for (const o of all) {
      if (o === v || o.retired || o.path !== v.path || o.air) continue;
      let ds = o.s - v.s;
      if (path.closed) {
        if (ds > path.length / 2) ds -= path.length;
        if (ds < -path.length / 2) ds += path.length;
      }
      const dx = o.x - v.x;
      if (Math.abs(ds) < 9 && Math.abs(dx) < 5) tx -= Math.sign(dx || 1) * (5 - Math.abs(dx)) * 1.5;
    }
    // make way for much faster machines closing in from behind (rocket starts, boosts)
    for (const o of all) {
      if (o === v || o.retired || o.path !== v.path || o.air) continue;
      let ds = o.s - v.s;
      if (path.closed) {
        if (ds > path.length / 2) ds -= path.length;
        if (ds < -path.length / 2) ds += path.length;
      }
      if (ds < 0 && ds > -80 && o.v > v.v + 25 && Math.abs(o.x - v.x) < 7) tx = v.x + (o.x > v.x ? -9 : 9);
    }
    if (closestAhead && closestAhead.v < v.v + 5) {
      const side = closestAhead.x > v.x ? -1 : 1;
      let ox = closestAhead.x + side * 6;
      if (Math.abs(ox) > half - 3) ox = closestAhead.x - side * 6;
      tx = ox;
    }
    tx = clamp(tx, -L + 3, R - 3);
    this.targetX += (tx - this.targetX) * (1 - Math.exp(-2.5 * dt));

    // --- steering: desired heading toward target x plus curvature feed-forward
    const kappaHere = path.curvAt(v.s);
    const lookDist = Math.max(22, v.v * 0.55);
    const desiredPsi = clamp(Math.atan2(this.targetX - v.x, lookDist), -0.3, 0.3);
    let steer = (desiredPsi - v.psi) * 5 + ((-kappaHere * v.v) / turnMax) * 1.0;
    steer += -(v.phi - v.psi) * 0.6; // counter drift
    steer += Math.sin(this.noiseT * 1.7) * this.p.wobble;
    c.steer = clamp(steer, -1, 1);
    if (Math.abs(steer) > 1.05) c.lean = Math.sign(steer);

    // --- speed control
    const vCorner = (turnMax * 1.45) / Math.max(maxK, 1e-4);
    let target = Math.min(v.spec.maxSpeed * 1.4 * this.p.skill, vCorner);
    // rubber band relative to player
    if (player && !player.finished) {
      const gap = player.raceDist - v.raceDist;
      if (gap > 600) target *= 1.05;
      else if (gap < -900) target *= 0.95;
    }
    const cap = v.spec.maxSpeed * this.p.skill;
    c.throttle = v.v < Math.min(target, cap + (v.boosting ? 100 : 0)) ? 1 : 0.3;
    c.brake = v.v > target + 15 ? clamp((v.v - target - 15) / 40, 0, 1) : 0;

    // --- boost on straights
    if (v.lap >= 1 && v.energy > 45 && maxK < 0.0015 && v.boostTime <= 0 && this.rng() < dt * 0.35 * this.p.boostHappy) c.boost = true;
    void time;
  }
}
