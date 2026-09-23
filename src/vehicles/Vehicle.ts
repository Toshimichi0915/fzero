import * as THREE from 'three';
import { Track, HALF_W } from '../track/Track';
import { F_GAP, F_NORAIL_L, F_NORAIL_R, Frame, makeFrame, Path } from '../track/Path';
import { clamp, damp, wrapAngle } from '../core/util';
import { MachineSpec, buildMachine, BuiltModel } from './VehicleModel';
import { globalUniforms } from '../shaders/common';

export interface Controls {
  steer: number; // -1..1 (right positive)
  throttle: number; // 0..1
  brake: number; // 0..1
  lean: number; // -1..1 (L1/R1)
  pitch: number; // -1..1 air pitch (nose down positive)
  boost: boolean; // edge-triggered
  sideAttack: number; // -1/1 edge-triggered
  spin: boolean; // edge-triggered
}
export const emptyControls = (): Controls => ({ steer: 0, throttle: 0, brake: 0, lean: 0, pitch: 0, boost: false, sideAttack: 0, spin: false });

export const GRAVITY = 34;
export const HOVER = 0.75;
export const SPEED_TO_KMH = 7.2; // display speed multiplier (F-Zero feel)

export type VehicleEvent =
  | { type: 'wall'; v: Vehicle; pos: THREE.Vector3; strength: number; side: number }
  | { type: 'hit'; a: Vehicle; b: Vehicle; pos: THREE.Vector3; strength: number }
  | { type: 'boostpad'; v: Vehicle }
  | { type: 'boost'; v: Vehicle }
  | { type: 'land'; v: Vehicle; strength: number }
  | { type: 'launch'; v: Vehicle }
  | { type: 'fall'; v: Vehicle }
  | { type: 'explode'; v: Vehicle }
  | { type: 'lap'; v: Vehicle; lap: number }
  | { type: 'ko'; attacker: Vehicle; victim: Vehicle };

const tmpF = makeFrame();
const shieldGeo = new THREE.SphereGeometry(1, 32, 16);
const shieldMat = (c: THREE.Color) =>
  new THREE.ShaderMaterial({
    uniforms: { uAmt: { value: 0 }, uColor: { value: c.clone().lerp(new THREE.Color(0.6, 0.9, 1), 0.5) }, uTime: globalUniforms.uTime },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vP; void main(){ vP = position; vec4 mv = modelViewMatrix * vec4(position,1.); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform float uAmt; uniform vec3 uColor; uniform float uTime; varying vec3 vN; varying vec3 vV; varying vec3 vP;
      void main(){
        float f = pow(1. - abs(dot(normalize(vN), normalize(vV))), 2.2);
        vec2 h = vec2(atan(vP.z, vP.x) * 6., vP.y * 10.);
        float hex = smoothstep(.42, .5, abs(fract(h.x + .5 * floor(h.y)) - .5) + abs(fract(h.y) - .5) * .5);
        float scan = .7 + .3 * sin(vP.y * 30. - uTime * 20.);
        gl_FragColor = vec4(uColor * (f * 2.5 + hex * .35 * f) * uAmt * scan * 1.6, 1.);
      }`,
  });
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();

export class Vehicle {
  id: number;
  spec: MachineSpec;
  model: BuiltModel;
  object = new THREE.Group();
  isPlayer = false;
  name: string;

  // track-relative state
  path = 0;
  s = 0;
  x = 0;
  h = HOVER;
  psi = 0; // heading relative to track tangent (radians, + = right)
  phi = 0; // velocity direction relative to tangent
  v = 0; // speed along velocity direction
  knock = 0; // lateral knock velocity (m/s)
  // airborne state
  air = false;
  airPos = new THREE.Vector3();
  airVel = new THREE.Vector3();
  airTime = 0;
  airPitch = 0;
  // race state
  energy = 100;
  lap = -1;
  rel = 0; // progress since start line (0..L)
  raceDist = 0;
  finished = false;
  finishTime = 0;
  lapTimes: number[] = [];
  lapStart = 0;
  place = 0;
  kos = 0;
  retired = false;
  respawnTimer = 0;
  lastAttacker: Vehicle | null = null;
  lastAttackTime = -10;
  // effects state
  boostTime = 0;
  padBoost = 0;
  padCooldown = 0;
  sideAttackTime = 0;
  sideDir = 0;
  spinTime = 0;
  spinAngle = 0;
  throttleVis = 0;
  steerVis = 0;
  roll = 0;
  pitchVis = 0;
  damageFlash = 0;
  inPit = false;
  wallScrape = 0;
  wasWrap = 0;
  hitCooldown = 0;
  bob = Math.random() * 10;
  controls = emptyControls();
  // world-space output
  pos = new THREE.Vector3();
  fwd = new THREE.Vector3(0, 0, -1);
  up = new THREE.Vector3(0, 1, 0);
  right = new THREE.Vector3(1, 0, 0);
  trackUp = new THREE.Vector3(0, 1, 0);
  vel = new THREE.Vector3();

  constructor(id: number, spec: MachineSpec, name: string) {
    this.id = id;
    this.spec = spec;
    this.name = name;
    this.model = buildMachine(spec);
    this.object.add(this.model.group);
    this.shield = new THREE.Mesh(shieldGeo, shieldMat(spec.thrust));
    this.shield.scale.set(this.model.width * 0.62, 1.3, 4.2);
    this.shield.visible = false;
    this.object.add(this.shield);
  }
  shield: THREE.Mesh;
  updateShield() {
    const m = this.shield.material as THREE.ShaderMaterial;
    const k = Math.max(this.damageFlash, this.inPit ? 0.35 : 0, this.spinTime > 0 ? 0.6 : 0);
    this.shield.visible = k > 0.01 && this.object.visible;
    m.uniforms.uAmt.value = k;
  }

  get boosting() {
    return this.boostTime > 0 || this.padBoost > 0;
  }
  get speedKmh() {
    return this.v * SPEED_TO_KMH;
  }

  placeOnGrid(path: number, s: number, x: number) {
    this.path = path;
    this.s = s;
    this.x = x;
    this.psi = this.phi = 0;
    this.v = 0;
    this.air = false;
    this.energy = 100;
    this.lap = -1;
    this.finished = false;
    this.retired = false;
    this.object.visible = true;
  }

  update(dt: number, track: Track, time: number, events: VehicleEvent[]) {
    if (this.retired) return;
    const c = this.controls;
    const sp = this.spec;
    this.padCooldown -= dt;
    this.boostTime = Math.max(0, this.boostTime - dt);
    this.padBoost = Math.max(0, this.padBoost - dt);
    this.sideAttackTime = Math.max(0, this.sideAttackTime - dt);
    this.spinTime = Math.max(0, this.spinTime - dt);
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2);
    this.hitCooldown -= dt;
    this.throttleVis = damp(this.throttleVis, c.throttle, 8, dt);

    if (this.respawnTimer > 0) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn(track);
      else return;
    }

    // boost trigger (from lap 2 onwards, costs energy)
    if (c.boost && this.boostTime <= 0 && this.lap >= 1 && this.energy > 12 && !this.finished) {
      this.boostTime = 1.7;
      this.energy -= 11;
      events.push({ type: 'boost', v: this });
    }
    if (c.sideAttack && this.sideAttackTime <= 0 && !this.air) {
      this.sideAttackTime = 0.45;
      this.sideDir = c.sideAttack;
      this.knock += c.sideAttack * 22;
    }
    if (c.spin && this.spinTime <= 0) this.spinTime = 0.7;
    if (this.spinTime > 0) this.spinAngle += dt * Math.PI * 2 / 0.7;
    else this.spinAngle = 0;

    if (this.air) this.updateAir(dt, track, events);
    else this.updateGround(dt, track, time, events);
    this.updateRace(track, time, events);
    this.updateTransform(dt, track);
  }

  private topSpeed() {
    const sp = this.spec;
    let t = sp.maxSpeed;
    if (this.boostTime > 0) t *= 1 + 0.3 * sp.boost;
    if (this.finished) t *= 0.6;
    return t;
  }

  private updateGround(dt: number, track: Track, time: number, events: VehicleEvent[]) {
    const c = this.controls;
    const sp = this.spec;
    let path = track.paths[this.path];
    const kappa = path.curvAt(this.s);
    const g = path.sample(this.s, tmpF);

    // --- steering
    const leanSame = c.lean !== 0 && Math.sign(c.lean) === Math.sign(c.steer || c.lean);
    let turn = sp.turn * clamp(0.35 + this.v / 60, 0.35, 1);
    turn *= 1 + (leanSame ? 0.55 * Math.abs(c.lean) : 0);
    this.psi += c.steer * turn * dt;
    // lean alone strafes a little (F-Zero style)
    if (c.lean && !c.steer) this.knock += c.lean * 18 * dt;
    // the course bends under the craft
    const dsdt = this.v * Math.cos(this.phi);
    this.psi -= -kappa * dsdt * dt; // kappa>0 = left turn; our psi is + right
    this.phi -= -kappa * dsdt * dt;
    // grip pulls velocity toward heading; leaning into turns reduces grip (drift)
    let grip = sp.grip * (c.brake > 0.3 ? 0.55 : 1) * (leanSame ? 0.8 : 1);
    this.phi += (this.psi - this.phi) * (1 - Math.exp(-grip * dt));
    const slip = Math.abs(this.psi - this.phi);
    this.v -= slip * this.v * 0.5 * dt;
    // alignment assist: heading tends back toward course direction at low input
    this.psi = clamp(this.psi, -1.1, 1.1);
    this.phi = clamp(this.phi, -1.1, 1.1);

    // --- speed
    const top = this.topSpeed();
    if (this.boostTime > 0) {
      this.v += 90 * dt * (this.v < top ? 1 : 0);
    }
    if (c.throttle > 0 && this.v < top) {
      const f = 1 - (this.v / top) ** 2;
      this.v += sp.accel * c.throttle * Math.max(0.08, f) * dt;
    }
    if (this.v > top) this.v = damp(this.v, top, this.padBoost > 0 ? 0.6 : 1.1, dt);
    if (c.throttle < 0.05) this.v -= 6 * dt;
    this.v -= c.brake * 70 * dt;
    // slope
    this.v -= GRAVITY * 0.55 * g.t.y * dt;
    if (this.v < 0) this.v = g.t.y > 0.05 ? Math.max(this.v, -15) : 0;

    // --- integrate
    const oldS = this.s;
    this.s += this.v * Math.cos(this.phi) * dt;
    this.x += (this.v * Math.sin(this.phi) + this.knock) * dt;
    this.knock = damp(this.knock, 0, 4, dt);

    // --- path transfers (forks)
    this.handleTransfers(track, oldS);
    path = track.paths[this.path];
    if (!path.closed) {
      if (this.s > path.length) this.s = path.length;
      if (this.s < 0) this.s = 0;
    } else this.s = path.wrapS(this.s);

    // --- jump gaps & open edges
    const fl = path.flagAt(this.s);
    const [L, R] = path.ext(this.s);
    const hw = this.model.width * 0.42;
    if (fl & F_GAP) {
      this.launch(track, events);
      return;
    }
    const noL = fl & F_NORAIL_L,
      noR = fl & F_NORAIL_R;
    const wrap = path.wraps(this.s);
    if (wrap) {
      // closed tube / pipe: lateral position wraps all the way around
      const G = L + R;
      this.x = ((((this.x + G / 2) % G) + G) % G) - G / 2;
      this.wasWrap = 0.6;
    } else if ((noL && this.x < -L - 0.5) || (noR && this.x > R + 0.5)) {
      this.launch(track, events, true);
      return;
    }
    // --- walls
    this.wallScrape = Math.max(0, this.wallScrape - dt * 4);
    this.wasWrap = Math.max(0, this.wasWrap - dt);
    if (!wrap) {
      if (!noL && this.x < -L + hw) {
        this.hitWall(-1, -L + hw, events, path);
      } else if (!noR && this.x > R - hw) {
        this.hitWall(1, R - hw, events, path);
      }
    }

    // --- pads & pit
    this.inPit = false;
    for (const pad of track.boostPads) {
      if (pad.path !== this.path) continue;
      if (this.s >= pad.s0 && this.s <= pad.s1 && this.x >= pad.x0 - 1 && this.x <= pad.x1 + 1 && this.padCooldown <= 0) {
        if (pad.kind === 'jump') {
          this.padCooldown = 0.5;
          events.push({ type: 'boostpad', v: this });
          this.launch(track, events, false, 24);
          return;
        }
        this.v = Math.min(this.v + 38, this.spec.maxSpeed * 1.5);
        this.padBoost = 1.2;
        this.padCooldown = 0.5;
        events.push({ type: 'boostpad', v: this });
      }
    }
    for (const z of track.pitZones) {
      if (z.path === this.path && this.s >= z.s0 && this.s <= z.s1 && this.x >= z.x0 - 1.5) {
        this.inPit = true;
        this.energy = Math.min(100, this.energy + 28 * dt);
      }
    }
    this.h = HOVER + Math.sin(time * 3 + this.bob) * 0.06;
  }

  private hitWall(side: number, clampX: number, events: VehicleEvent[], path: Path) {
    const inward = -side;
    if (this.wasWrap > 0) {
      // leaving a tube: the walls close in around us, ease back onto the road without damage
      this.x = clampX;
      this.knock = inward * 6;
      return;
    }
    const angle = Math.abs(this.phi) * (Math.sign(this.phi) === side ? 1 : 0);
    const impact = this.v * Math.sin(angle) + Math.abs(this.knock) * (Math.sign(this.knock) === side ? 1 : 0);
    this.x = clampX;
    // reflect
    if (Math.sign(this.phi) === side) this.phi = -this.phi * 0.25;
    if (Math.sign(this.psi) === side) this.psi *= 0.4;
    this.knock = inward * Math.min(25, 4 + impact * 0.4);
    const loss = clamp(impact / 50, 0.01, 0.35);
    this.v *= 1 - loss;
    if (impact > 2 || this.wallScrape <= 0) {
      const dmg = (0.25 + impact * 0.12) * this.spec.body;
      this.damage(dmg, null, events);
      const p = new THREE.Vector3();
      path.surf(this.s, clampX + side * 1.2, 0.8, p, tmpV2);
      events.push({ type: 'wall', v: this, pos: p, strength: impact, side });
      this.wallScrape = 0.25;
    }
  }

  damage(amount: number, attacker: Vehicle | null, events: VehicleEvent[]) {
    if (this.finished) return;
    this.damageFlash = Math.min(1, this.damageFlash + amount * 0.15);
    if (attacker) {
      this.lastAttacker = attacker;
      this.lastAttackTime = performance.now() / 1000;
    }
    if (this.energy <= 0) {
      // already empty: any damage destroys
      if (amount > 0.4) this.explode(events);
      return;
    }
    this.energy = Math.max(0, this.energy - amount);
  }

  explode(events: VehicleEvent[]) {
    if (this.retired) return;
    this.retired = true;
    this.object.visible = false;
    events.push({ type: 'explode', v: this });
    const now = performance.now() / 1000;
    if (this.lastAttacker && now - this.lastAttackTime < 3) events.push({ type: 'ko', attacker: this.lastAttacker, victim: this });
  }

  private handleTransfers(track: Track, oldS: number) {
    // splitting off onto a child branch
    for (let bi = 0; bi < track.branches.length; bi++) {
      const b = track.branches[bi];
      if (b.parent !== this.path) continue;
      const onSide = b.startOffset < 0 ? this.x < -HALF_W : this.x > HALF_W;
      if (onSide && oldS < b.startS && this.s >= b.startS) {
        this.path = bi + 1;
        this.s -= b.startS;
        this.x -= b.startOffset;
        return;
      }
    }
    // running off the end of a branch back onto its parent
    const b = track.branchOf(this.path);
    if (!b) return;
    if (this.s >= b.path.length) {
      this.s = b.endS + (this.s - b.path.length);
      this.x += b.endOffset;
      this.path = b.parent;
    } else if (this.s < 0) {
      this.s = b.startS + this.s;
      this.x += b.startOffset;
      this.path = b.parent;
    }
  }

  private launch(track: Track, events: VehicleEvent[], sideways = false, pop = 3) {
    const path = track.paths[this.path];
    const n = new THREE.Vector3(),
      lat = new THREE.Vector3();
    path.surf(this.s, this.x, this.h, this.airPos, n, lat, tmpF);
    this.air = true;
    this.airTime = 0;
    // velocity from heading
    const dir = tmpV.copy(tmpF.t).multiplyScalar(Math.cos(this.phi)).addScaledVector(lat, Math.sin(this.phi));
    this.airVel.copy(dir).multiplyScalar(this.v).addScaledVector(lat, this.knock);
    this.airVel.addScaledVector(n, sideways ? 0 : pop);
    this.airPitch = 0;
    events.push({ type: 'launch', v: this });
  }

  private updateAir(dt: number, track: Track, events: VehicleEvent[]) {
    const c = this.controls;
    this.airTime += dt;
    // air steering: rotate horizontal velocity
    const yawRate = -c.steer * 0.55;
    tmpQ.setFromAxisAngle(tmpV.set(0, 1, 0), yawRate * dt);
    this.airVel.applyQuaternion(tmpQ);
    // pitch: nose down to dive (faster fall, a bit of speed), nose up to float
    this.airPitch = damp(this.airPitch, c.pitch, 4, dt);
    const g = GRAVITY * (1 + this.airPitch * 0.6);
    this.airVel.y -= g * dt;
    if (this.boostTime > 0) this.airVel.addScaledVector(tmpV.copy(this.airVel).setY(0).normalize(), 40 * dt);
    this.airPos.addScaledVector(this.airVel, dt);
    const path = track.paths[this.path];
    const [s, x, h] = path.project(this.airPos, this.s, 120);
    const oldS = this.s;
    this.s = s;
    this.x = x;
    this.h = h;
    // path transfer while airborne
    this.handleTransfers(track, oldS);
    const p2 = track.paths[this.path];
    if (this.path !== path.index) {
      const r = p2.project(this.airPos, this.s, 30);
      this.s = r[0];
      this.x = r[1];
      this.h = r[2];
    }
    p2.sample(this.s, tmpF);
    const fl = p2.flagAt(this.s);
    const [L, R] = p2.ext(this.s);
    const overRoad = !(fl & F_GAP) && this.x > -L - 1.5 && this.x < R + 1.5;
    if (this.h <= HOVER && overRoad && this.h > -6) {
      // land
      const vn = this.airVel.dot(tmpF.u);
      const vt = this.airVel.dot(tmpF.t);
      const vr = this.airVel.dot(tmpF.r);
      this.v = Math.hypot(vt, vr);
      this.phi = this.psi = clamp(Math.atan2(vr, Math.max(vt, 1)), -0.8, 0.8);
      this.knock = 0;
      this.h = HOVER;
      this.air = false;
      const strength = Math.max(0, -vn);
      if (strength > 22) this.damage((strength - 22) * 0.35 * this.spec.body, null, events);
      this.v *= 1 - clamp((strength - 10) / 200, 0, 0.2);
      events.push({ type: 'land', v: this, strength });
      return;
    }
    if (this.h < -60 || this.airTime > 9) {
      events.push({ type: 'fall', v: this });
      this.air = false;
      this.object.visible = false;
      this.energy = Math.max(0, this.energy - 15);
      this.respawnTimer = 1.6;
    }
  }

  respawn(track: Track) {
    // put back on the road a bit further along from where we fell
    const path = track.paths[this.path];
    let s = this.s;
    for (let k = 0; k < 400; k += 5) {
      const ss = path.wrapS(s + k);
      if (!(path.flagAt(ss) & F_GAP)) {
        let ok = true;
        for (let j = 0; j < 30; j += 5) if (path.flagAt(path.wrapS(ss + j)) & F_GAP) ok = false;
        if (ok) {
          s = ss + 10;
          break;
        }
      }
    }
    this.s = path.closed ? path.wrapS(s) : Math.min(s, path.length - 1);
    this.x = 0;
    this.psi = this.phi = 0;
    this.knock = 0;
    this.v = this.spec.maxSpeed * 0.45;
    this.air = false;
    this.h = HOVER;
    this.object.visible = true;
    if (this.energy <= 0) this.energy = 1;
  }

  private updateRace(track: Track, time: number, events: VehicleEvent[]) {
    const L = track.lapLength;
    const prog = track.progress(this.path, this.s);
    let rel = prog - track.startS;
    rel = ((rel % L) + L) % L;
    const d = rel - this.rel;
    if (d < -L / 2) {
      this.lap++;
      if (this.lap >= 1) {
        this.lapTimes.push(time - this.lapStart);
      }
      this.lapStart = time;
      events.push({ type: 'lap', v: this, lap: this.lap });
    } else if (d > L / 2) this.lap--;
    this.rel = rel;
    this.raceDist = this.lap * L + rel;
  }

  private updateTransform(dt: number, track: Track) {
    const c = this.controls;
    this.steerVis = damp(this.steerVis, c.steer + c.lean * 0.6, 6, dt);
    if (this.air) {
      this.pos.copy(this.airPos);
      const f = tmpV.copy(this.airVel).normalize();
      // nose follows velocity, pitched by input
      this.fwd.lerp(f, 1 - Math.exp(-5 * dt)).normalize();
      this.up.lerp(tmpV2.set(0, 1, 0), 1 - Math.exp(-2 * dt)).normalize();
      this.vel.copy(this.airVel);
    } else {
      const path = track.paths[this.path];
      const lat = tmpV2;
      path.surf(this.s, this.x, this.h, this.pos, this.trackUp, lat, tmpF);
      const cp = Math.cos(this.psi),
        spp = Math.sin(this.psi);
      this.fwd.copy(tmpF.t).multiplyScalar(cp).addScaledVector(lat, spp).normalize();
      this.up.copy(this.trackUp);
      this.vel
        .copy(tmpF.t)
        .multiplyScalar(this.v * Math.cos(this.phi))
        .addScaledVector(lat, this.v * Math.sin(this.phi) + this.knock);
    }
    this.right.crossVectors(this.fwd, this.up).normalize();
    this.up.crossVectors(this.right, this.fwd).normalize();
    // visual roll & pitch
    const targetRoll = -this.steerVis * 0.32 - (this.sideAttackTime > 0 ? this.sideDir * 0.9 : 0);
    this.roll = damp(this.roll, targetRoll, 7, dt);
    this.pitchVis = damp(this.pitchVis, this.air ? -this.airPitch * 0.35 : (this.controls.brake * 0.06 - this.throttleVis * 0.03), 5, dt);
    tmpM.makeBasis(this.right, this.up, tmpV.copy(this.fwd).negate());
    this.object.quaternion.setFromRotationMatrix(tmpM);
    this.object.position.copy(this.pos);
    const q = tmpQ.setFromEuler(new THREE.Euler(this.pitchVis, this.spinAngle, this.roll, 'YXZ'));
    this.object.quaternion.multiply(q);
  }
}

export function vehicleVsVehicle(a: Vehicle, b: Vehicle, track: Track, events: VehicleEvent[]) {
  if (a.retired || b.retired || a.air || b.air || a.respawnTimer > 0 || b.respawnTimer > 0) return;
  if (a.path !== b.path) return;
  const path = track.paths[a.path];
  let ds = b.s - a.s;
  if (path.closed) {
    if (ds > path.length / 2) ds -= path.length;
    if (ds < -path.length / 2) ds += path.length;
  }
  let dx = b.x - a.x;
  if (path.wraps(a.s)) {
    const G = path.girth(a.s);
    dx = ((((dx + G / 2) % G) + G) % G) - G / 2;
  }
  const lenR = 5.6,
    widR = (a.model.width + b.model.width) * 0.3;
  const spinR = a.spinTime > 0 || b.spinTime > 0 ? 1.4 : 1;
  const q = (ds / lenR) ** 2 + (dx / (widR * spinR)) ** 2;
  if (q >= 1) return;
  const pen = 1 - Math.sqrt(q);
  const wa = a.spec.weight,
    wb = b.spec.weight;
  const tot = wa + wb;
  // relative velocities
  const va = a.v * Math.sin(a.phi) + a.knock,
    vb = b.v * Math.sin(b.phi) + b.knock;
  const vla = a.v * Math.cos(a.phi),
    vlb = b.v * Math.cos(b.phi);
  const sideways = Math.abs(dx) / widR > Math.abs(ds) / lenR;
  let strength = 0;
  if (sideways) {
    const dir = Math.sign(dx) || 1;
    const push = pen * widR * 0.6;
    a.x -= dir * push * (wb / tot);
    b.x += dir * push * (wa / tot);
    const rel = (va - vb) * dir; // closing speed
    strength = Math.max(0, rel);
    const imp = Math.max(4, rel * 1.1);
    let ka = -dir * imp * (wb / tot);
    let kb = dir * imp * (wa / tot);
    if (a.sideAttackTime > 0 && Math.sign(a.sideDir) === dir) {
      kb += dir * 28;
      strength += 20;
    }
    if (b.sideAttackTime > 0 && Math.sign(b.sideDir) === -dir) {
      ka -= dir * 28;
      strength += 20;
    }
    a.knock += ka;
    b.knock += kb;
  } else {
    const dir = Math.sign(ds) || 1; // b ahead of a if dir>0
    const push = pen * lenR * 0.5;
    a.s -= dir * push * (wb / tot);
    b.s += dir * push * (wa / tot);
    const rel = (vla - vlb) * dir;
    strength = Math.max(0, rel);
    if (rel > 0) {
      // exchange momentum partially
      const e = 0.6;
      const pa = vla,
        pb = vlb;
      const vaN = (wa * pa + wb * pb - wb * e * (pa - pb)) / tot;
      const vbN = (wa * pa + wb * pb + wa * e * (pa - pb)) / tot;
      a.v = Math.max(0, a.v + (vaN - pa));
      b.v = Math.max(0, b.v + (vbN - pb));
    }
    a.knock += (Math.sign(dx) || (Math.random() - 0.5)) * -3;
    b.knock += (Math.sign(dx) || (Math.random() - 0.5)) * 3;
  }
  if (a.spinTime > 0 || b.spinTime > 0) strength += 12;
  if (strength > 1 && (a.hitCooldown <= 0 || b.hitCooldown <= 0)) {
    a.hitCooldown = b.hitCooldown = 0.3;
    const dmg = 0.1 + strength * 0.045;
    a.damage(dmg * a.spec.body * (b.sideAttackTime > 0 || b.spinTime > 0 ? 3 : 1), b, events);
    b.damage(dmg * b.spec.body * (a.sideAttackTime > 0 || a.spinTime > 0 ? 3 : 1), a, events);
    const pos = a.pos.clone().lerp(b.pos, 0.5);
    events.push({ type: 'hit', a, b, pos, strength });
  }
}

export { wrapAngle, type Frame };
