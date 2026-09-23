import * as THREE from 'three';
import { Path, Turtle, makeFrame, F_NORAIL_R, F_TUNNEL, RawLine } from './Path';
import { smooth } from '../core/util';

export const HALF_W = 30; // half road width (m)
const W = HALF_W * 2;

export interface Branch {
  path: Path;
  parent: number; // index of the parent path
  startS: number; // s on parent where the branch splits off
  endS: number; // s on parent where it re-joins
  startOffset: number; // lateral offset of branch centre vs parent at the split (negative = left)
  endOffset: number; // ... and at the join
}

export interface Pad {
  path: number;
  s0: number;
  s1: number;
  x0: number;
  x1: number;
  kind: 'dash' | 'jump';
}

export interface Zone {
  path: number;
  s0: number;
  s1: number;
  x0: number;
  x1: number;
}

/** Scenery districts, keyed by race progress along the main course */
export type District = 'downtown' | 'core' | 'port' | 'kyoto' | 'arcology' | 'fire';

export class Track {
  paths: Path[] = [];
  main!: Path;
  branches: Branch[] = []; // branches[i].path.index === i + 1
  boostPads: Pad[] = [];
  pitZones: Zone[] = [];
  towers: { pos: THREE.Vector3; radius: number }[] = [];
  districts: { s0: number; s1: number; d: District }[] = [];
  startS = 0;
  lapLength = 0;

  addPath(p: Path) {
    p.index = this.paths.length;
    this.paths.push(p);
    return p;
  }
  branchOf(path: number) {
    return path === 0 ? null : this.branches[path - 1];
  }
  /** Race-progress distance along the main course for a position on any path. */
  progress(path: number, s: number): number {
    if (path === 0) return s;
    const b = this.branches[path - 1];
    const a = this.progress(b.parent, b.startS);
    const e = this.progress(b.parent, b.endS);
    return a + (s / b.path.length) * (e - a);
  }
  district(prog: number): District {
    for (const d of this.districts) if (prog >= d.s0 && prog < d.s1) return d.d;
    return 'downtown';
  }
}

/** Widen the parent path on one side before the split and after the join, for smooth forks. */
function applyFork(parent: Path, b: Branch, taper = 220) {
  const widen = (sAt: number, offset: number, before: boolean) => {
    const side = offset < 0 ? parent.leftExt : parent.rightExt;
    const extra = Math.abs(offset);
    for (let i = 0; i < parent.n; i++) {
      const s = i * parent.ds;
      const d = before ? sAt - s : s - sAt;
      if (d >= 0 && d < taper) side[i] = Math.max(side[i], HALF_W + extra * smooth(1 - d / taper));
    }
  };
  widen(b.startS, b.startOffset, true);
  widen(b.endS, b.endOffset, false);
}

/**
 * Build a branch as a smooth offset of its parent between sa and sb.
 * u runs 0..1 along the branch; offsets are in the parent's lateral/up frame.
 */
function offsetBranch(
  parent: Path,
  sa: number,
  sb: number,
  fn: { offset: (u: number) => number; height?: (u: number) => number; roll?: (u: number) => number; curl?: (u: number) => number },
): RawLine {
  const f = makeFrame();
  const line: RawLine = { pts: [], roll: [], curl: [], flags: [], markers: {} };
  const n = Math.ceil(sb - sa);
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const s = sa + (sb - sa) * u;
    parent.sample(s, f);
    // use a level frame so heights are world-vertical-ish even where the parent is curled or banked
    const right = new THREE.Vector3(-f.t.z, 0, f.t.x).normalize();
    const p = f.p.clone().addScaledVector(right, fn.offset(u));
    p.y += fn.height?.(u) ?? 0;
    line.pts.push(p);
    line.roll.push(fn.roll?.(u) ?? 0);
    line.curl.push(fn.curl?.(u) ?? 0);
    line.flags.push(0);
  }
  return line;
}

export function buildTrack(): Track {
  const track = new Track();
  const START = new THREE.Vector3(-800, 40, 1150);
  const t = new Turtle(START, 0);

  // ================= MUTE CITY: start / finish straight with pit lane
  t.mark('grid').straight(330).mark('start').straight(90).mark('pit0').straight(380).mark('pit1').straight(60);
  // rolling S into the climbing sweeper
  t.turn(-15, 500, 5).turn(30, 500, 5).turn(-15, 500, 5).mark('boostA');
  t.turn(95, 330, 25).straight(100, 10);
  // ================= DOWNTOWN CORE: helix around the megatower
  t.mark('helix0');
  const hdir = t.dir();
  const helixCenter = t.pos.clone().add(new THREE.Vector3(-hdir.z, 0, hdir.x).multiplyScalar(-370));
  t.helix(300, 370, 125).mark('helix1');
  t.straight(120).mark('boostB');
  t.turn(-70, 360, -15);
  t.straight(120).mark('db0');
  // ================= PORT TOWN: DOUBLE BRANCHES (main route = outside pipe)
  t.straight(250, -10);
  t.curlTo(-1, 170, -10).mark('pipe0');
  t.turn(-12, 900, -5).turn(24, 900, 0).turn(-12, 900, 5);
  t.curlTo(0, 170, 10).mark('pipe1');
  t.straight(300, 10).mark('db1');
  // ================= NEO-KYOTO: loop, wall ride, corkscrew
  t.straight(160);
  t.turn(-80, 360, -35).straight(100).mark('loop0');
  t.loop(100, W * 1.25);
  t.straight(120).mark('boostC');
  t.turn(-50, 450, 0);
  t.rollTo(-90, 200).mark('wall0').straight(260).rollTo(0, 200).mark('wall1');
  t.with(F_TUNNEL, () => t.corkscrew(460, 1, -10));
  t.straight(60);
  // hairpin back towards the arcology
  t.turn(180, 230, 0).mark('hairpin');
  t.straight(150).mark('climb0');
  t.climb(90, 140).mark('climb1');
  t.straight(250).mark('boostE');
  t.turn(-20, 600, 0).turn(20, 600, 0).straight(100).mark('jump0');
  t.jump(120, 220, 600, 150, 5).mark('jump1');
  t.turn(-65, 520, -60).straight(60, -30);
  // ================= FIRE FIELD: half-pipe canyon, glass tube, open-edge hills
  t.curlTo(0.42, 160, -10).mark('half0');
  t.turn(-45, 420, -10).turn(25, 420, 0);
  t.curlTo(0, 140).mark('half1');
  t.straight(60);
  t.curlTo(1, 150, -5).mark('gtube0');
  t.turn(-20, 600, -5).turn(20, 600, 0);
  t.curlTo(0, 150).mark('gtube1');
  t.straight(80).mark('nr0');
  t.with(F_NORAIL_R, () => {
    t.straight(150, 12).straight(150, -12);
  });
  t.mark('nr1');
  // ---- tail: auto-sized so the circuit closes onto the start straight
  const tailEnd = new THREE.Vector3(START.x - 120, START.y, START.z);
  const closeTail = (tt: Turtle, A: number, B: number) => {
    // turn to head north, run A, turn east onto the start straight, run B
    const hdg = ((((tt.heading * 180) / Math.PI) % 360) + 360) % 360;
    let d1 = 90 - hdg;
    while (d1 > 180) d1 -= 360;
    while (d1 < -180) d1 += 360;
    const y0 = tt.pos.y;
    tt.turn(d1, 420, 0).straight(A, (tailEnd.y - y0) * 0.7).mark('boostD');
    tt.turn(-90, 380, (tailEnd.y - y0) * 0.3).straight(B, 0);
  };
  let A = 400,
    B = 200;
  for (let it = 0; it < 6; it++) {
    const probe = t.clone();
    closeTail(probe, A, B);
    A += probe.pos.z - tailEnd.z;
    B += tailEnd.x - probe.pos.x;
    A = Math.max(60, A);
    B = Math.max(20, B);
  }
  closeTail(t, A, B);
  t.joinTo(START, new THREE.Vector3(1, 0, 0), Math.round(t.roll / (Math.PI * 2)) * Math.PI * 2);

  const main = track.addPath(new Path('main', t.line, true, HALF_W));
  track.main = main;
  track.towers.push({ pos: helixCenter, radius: 130 });
  const m = main.markers;

  // ================= DOUBLE BRANCHES
  // B1 "skyway": splits left, weaves over the main pipe three times (ending on its right), and
  // runs upside down in the middle.
  const ease = (u: number, a: number, b: number) => smooth((u - a) / (b - a));
  const b1raw = offsetBranch(main, m.db0, m.db1, {
    offset: (u) => -W * Math.cos(Math.PI * 3 * ease(u, 0.12, 0.88)),
    height: (u) => 38 * ease(u, 0.04, 0.2) * (1 - ease(u, 0.8, 0.96)),
    roll: (u) => Math.PI * ease(u, 0.36, 0.44) - Math.PI * ease(u, 0.6, 0.68) + Math.PI * 2 * ease(u, 0.6, 0.68),
  });
  const b1 = track.addPath(new Path('skyway', b1raw, false, HALF_W));
  const br1: Branch = { path: b1, parent: 0, startS: m.db0, endS: m.db1, startOffset: -W, endOffset: W };
  track.branches.push(br1);
  // B2 "glass tube": splits off the skyway to its left, climbs above it and curls into a closed tube.
  const b2s0 = b1.length * 0.1,
    b2s1 = b1.length * 0.9;
  const b2raw = offsetBranch(b1, b2s0, b2s1, {
    offset: (u) => -W - 70 * Math.sin(Math.PI * ease(u, 0.1, 0.9)),
    height: (u) => 30 * Math.sin(Math.PI * ease(u, 0.08, 0.92)),
    curl: (u) => ease(u, 0.2, 0.3) * (1 - ease(u, 0.72, 0.82)),
  });
  const b2 = track.addPath(new Path('tube', b2raw, false, HALF_W));
  const br2: Branch = { path: b2, parent: 1, startS: b2s0, endS: b2s1, startOffset: -W, endOffset: -W };
  track.branches.push(br2);
  b1.markers.inv0 = b1.length * 0.45;
  b2.markers.tube0 = b2.length * 0.32;

  applyFork(main, br1);
  applyFork(b1, br2);

  // ================= districts (race progress)
  track.districts = [
    { s0: 0, s1: m.helix0 - 200, d: 'downtown' },
    { s0: m.helix0 - 200, s1: m.db0 - 150, d: 'core' },
    { s0: m.db0 - 150, s1: m.db1 + 300, d: 'port' },
    { s0: m.db1 + 300, s1: m.climb0 - 200, d: 'kyoto' },
    { s0: m.climb0 - 200, s1: m.jump1 - 100, d: 'arcology' },
    { s0: m.jump1 - 100, s1: m.nr1 + 400, d: 'fire' },
    { s0: m.nr1 + 400, s1: 1e9, d: 'downtown' },
  ];

  // ================= features
  track.startS = m.start;
  track.lapLength = main.length;
  track.pitZones.push({ path: 0, s0: m.pit0, s1: m.pit1, x0: HALF_W - 13, x1: HALF_W });
  const pads = (path: number, s: number, xs: number[], rows = 1, spacing = 40, kind: Pad['kind'] = 'dash') => {
    for (let r = 0; r < rows; r++)
      for (const x of xs) track.boostPads.push({ path, s0: s + r * spacing, s1: s + r * spacing + 14, x0: x - 5, x1: x + 5, kind });
  };
  pads(0, m.boostA, [-14, 14], 2, 70);
  pads(0, m.boostB, [0], 3, 50);
  pads(0, m.pipe0 + 250, [-12, 12], 2, 90);
  pads(0, m.boostC, [-12, 12], 2, 60);
  pads(0, m.boostE, [-14, 0, 14], 1);
  pads(0, m.jump0 + 30, [-10, 10], 1);
  pads(0, m.jump0 + 70, [0], 1);
  pads(0, m.boostD, [-10, 10], 2, 80);
  pads(0, m.nr0 + 20, [0], 1, 0, 'jump');
  pads(1, b1.markers.inv0 - 300, [-10, 10], 2, 70);
  pads(2, b2.markers.tube0 + 80, [0], 3, 60);
  return track;
}
