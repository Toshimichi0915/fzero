import * as THREE from 'three';
import { World } from '../world/World';
import { Vehicle, VehicleEvent, vehicleVsVehicle, emptyControls } from '../vehicles/Vehicle';
import { AIDriver, makePersona } from '../vehicles/AI';
import { makeRivals, playerSpec } from './Roster';
import { Thrusters } from '../fx/Thrusters';
import { Trails } from '../fx/Trails';
import { Particles } from '../fx/Particles';
import { lightUniforms, barrierUniforms, MAX_LIGHTS, MAX_HITS } from '../track/TrackMesh';
import { HALF_W } from '../track/Track';
import { mulberry32, clamp } from '../core/util';
import { makeFrame } from '../track/Path';
import { ROAD_LAYER } from '../fx/RoadReflection';

export const RIVALS = 30;
export type RaceState = 'idle' | 'countdown' | 'race' | 'finished';

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const tmpC = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

export class Race {
  vehicles: Vehicle[] = [];
  ais: AIDriver[] = [];
  player!: Vehicle;
  playerAI!: AIDriver; // drives the player's machine in attract mode
  thrusters: Thrusters;
  trails: Trails;
  particles: Particles;
  state: RaceState = 'idle';
  time = 0;
  raceTime = 0;
  countdown = 0;
  laps = 3;
  attract = false;
  events: VehicleEvent[] = [];
  listeners: ((e: VehicleEvent) => void)[] = [];
  finishOrder: Vehicle[] = [];
  standings: Vehicle[] = [];
  private hitSlot = 0;
  private rng = mulberry32(7);
  playerMachine = 0;
  autopilot = false;
  group = new THREE.Group();

  shadows: THREE.InstancedMesh;
  constructor(public world: World) {
    const sg = new THREE.PlaneGeometry(1, 1);
    sg.rotateX(-Math.PI / 2);
    this.shadows = new THREE.InstancedMesh(
      sg,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        vertexShader: `attribute float aFade; varying vec2 vUv; varying float vFade; void main(){ vUv = uv; vFade = aFade; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position,1.); }`,
        fragmentShader: `varying vec2 vUv; varying float vFade; void main(){ vec2 p = (vUv - .5) * 2.; float d = length(p); float a = smoothstep(1., .2, d) * .75 * vFade; gl_FragColor = vec4(0.,0.,0.,a); }`,
      }),
      40,
    );
    this.shadowFade = new Float32Array(40);
    sg.setAttribute('aFade', new THREE.InstancedBufferAttribute(this.shadowFade, 1));
    this.shadows.frustumCulled = false;
    this.shadows.layers.set(ROAD_LAYER);
    this.shadows.renderOrder = 5;
    world.scene.add(this.shadows);
    this.thrusters = new Thrusters(240);
    this.trails = new Trails(140);
    this.particles = new Particles(7000);
    world.scene.add(this.group);
    world.scene.add(this.thrusters.plumeMesh, this.thrusters.glowMesh, this.trails.mesh, this.particles.mesh);
  }

  setup(playerMachine: number, laps: number, attract: boolean) {
    for (const v of this.vehicles) this.group.remove(v.object);
    this.vehicles = [];
    this.ais = [];
    this.finishOrder = [];
    this.laps = laps;
    this.attract = attract;
    this.playerMachine = playerMachine;
    const rivals = makeRivals(RIVALS, 42);
    const ps = playerSpec(playerMachine);
    const track = this.world.track;
    const playerSlot = attract ? 30 : 27;
    let ri = 0;
    const total = RIVALS + 1;
    for (let slot = 0; slot < total; slot++) {
      const isPlayer = slot === playerSlot;
      const spec = isPlayer ? ps : rivals[ri++];
      const v = new Vehicle(slot, spec, isPlayer ? ps.pilot : (spec as { pilot: string }).pilot);
      v.isPlayer = isPlayer && !attract;
      // staggered grid: 4 per row, odd rows shifted half a lane, 30 m between rows.
      // The slot two rows ahead of the player's (same lane) is left empty so a rocket start has room.
      const gslot = slot >= playerSlot - 8 && slot !== playerSlot && slot < playerSlot ? (slot === playerSlot - 8 ? 31 : slot) : slot;
      const row = Math.floor(gslot / 4);
      const col = gslot % 4;
      const s = track.startS - 20 - row * 30;
      const x = (col - 1.5) * 13 + (row % 2 ? 6.5 : 0) - 3.25;
      v.placeOnGrid(0, s, x);
      v.rel = track.lapLength - (track.startS - s);
      v.lap = -1;
      this.vehicles.push(v);
      this.group.add(v.object);
      const persona = makePersona(this.rng, slot, total);
      const ai = new AIDriver(v, persona, mulberry32(slot * 31 + 5));
      if (isPlayer) {
        this.player = v;
        this.playerAI = ai;
        persona.skill = 1;
      } else this.ais.push(ai);
    }
    for (let i = 0; i < this.trails.maxTrails; i++) this.trails.reset(i);
    this.state = attract ? 'race' : 'countdown';
    this.countdown = attract ? 0 : 4.2;
    this.raceTime = 0;
    this.standings = this.vehicles.slice();
    // settle transforms
    for (const v of this.vehicles) v.update(0, track, this.time, []);
  }

  get started() {
    return this.state === 'race' || this.state === 'finished';
  }

  update(dt: number) {
    this.time += dt;
    const track = this.world.track;
    this.events.length = 0;
    if (this.state === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.state = 'race';
        for (const v of this.vehicles) v.lapStart = this.time;
        for (const ai of this.ais) ai.startDelay = 0.08 + this.rng() * 0.55;
      }
    }
    const racing = this.started;
    if (racing) this.raceTime += dt;

    // AI & controls
    for (const ai of this.ais) ai.update(dt, track, this.vehicles, this.player, this.time);
    if (this.attract || this.player.finished || this.autopilot) this.playerAI.update(dt, track, this.vehicles, null, this.time);
    if (!racing) {
      for (const v of this.vehicles) {
        // rev on the grid, but hold position
        const thr = v.controls.throttle;
        v.controls = emptyControls();
        v.controls.throttle = thr;
      }
    }
    // physics (substeps for stability at high speed)
    const sub = 2;
    const h = dt / sub;
    for (let k = 0; k < sub; k++) {
      for (const v of this.vehicles) {
        if (!racing) {
          v.throttleVis += (v.controls.throttle - v.throttleVis) * 0.1;
          v.update(0, track, this.time, this.events);
          continue;
        }
        v.update(h, track, this.time, this.events);
        if (k > 0) {
          v.controls.boost = false;
          v.controls.sideAttack = 0;
          v.controls.spin = false;
        }
      }
      if (racing) {
        // collisions (sorted sweep on progress)
        const vs = this.vehicles;
        for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) vehicleVsVehicle(vs[i], vs[j], track, this.events);
      }
    }
    // KO check: energy depleted & took a hit
    for (const v of this.vehicles) {
      if (!v.retired && v.energy <= 0 && v.damageFlash > 0.5) v.explode(this.events);
    }

    // finishing
    for (const v of this.vehicles) {
      if (!v.finished && !v.retired && v.lap >= this.laps) {
        v.finished = true;
        v.finishTime = this.raceTime;
        this.finishOrder.push(v);
        if (v === this.player && !this.attract) this.state = 'finished';
      }
    }
    // standings
    this.standings = this.vehicles.slice().sort((a, b) => {
      const fa = this.finishOrder.indexOf(a),
        fb = this.finishOrder.indexOf(b);
      if (fa >= 0 || fb >= 0) return (fa < 0 ? 1e9 : fa) - (fb < 0 ? 1e9 : fb);
      if (a.retired !== b.retired) return a.retired ? 1 : -1;
      return b.raceDist - a.raceDist;
    });
    this.standings.forEach((v, i) => (v.place = i + 1));

    for (const e of this.events) {
      this.handleEvent(e);
      for (const l of this.listeners) l(e);
    }
    this.updateFx(dt);
  }

  private handleEvent(e: VehicleEvent) {
    const P = this.particles;
    switch (e.type) {
      case 'wall': {
        const n = Math.min(40, 6 + e.strength * 1.5);
        for (let i = 0; i < n; i++) {
          tmp.copy(e.v.vel).multiplyScalar(0.55 + Math.random() * 0.3).add(tmp2.set((Math.random() - 0.5) * 30, Math.random() * 18, (Math.random() - 0.5) * 30));
          P.spawn(e.pos, tmp, tmpC.setRGB(4, 2.2 + Math.random(), 0.8), 0.25 + Math.random() * 0.35, 0.12, { drag: 2, grav: 25, stretch: 0.03 });
        }
        const hit = barrierUniforms.uHits.value[this.hitSlot++ % MAX_HITS];
        hit.set(e.pos.x, e.pos.y, e.pos.z, this.time);
        break;
      }
      case 'hit': {
        const n = Math.min(60, 10 + e.strength * 2);
        for (let i = 0; i < n; i++) {
          tmp.copy(e.a.vel).multiplyScalar(0.8).add(tmp2.set((Math.random() - 0.5) * 40, Math.random() * 20, (Math.random() - 0.5) * 40));
          P.spawn(e.pos, tmp, tmpC.setRGB(3, 3, 4), 0.2 + Math.random() * 0.3, 0.1, { drag: 2, grav: 20 });
        }
        P.spawn(e.pos, e.a.vel.clone().multiplyScalar(0.9), tmpC.setRGB(6, 5, 8), 0.12, 3, { stretch: 0 });
        break;
      }
      case 'boostpad':
      case 'boost': {
        const v = e.v;
        for (let i = 0; i < 24; i++) {
          tmp.copy(v.pos).addScaledVector(v.right, (Math.random() - 0.5) * 3).addScaledVector(v.up, Math.random() * 1.5 - 0.3);
          tmp2.copy(v.vel).multiplyScalar(0.7).addScaledVector(v.right, (Math.random() - 0.5) * 20).addScaledVector(v.up, Math.random() * 6);
          const c = e.type === 'boostpad' ? tmpC.setRGB(4, 2, 0.4) : tmpC.copy(v.spec.thrust).multiplyScalar(4);
          P.spawn(tmp, tmp2, c, 0.3 + Math.random() * 0.2, 0.2, { drag: 3, stretch: 0.05 });
        }
        break;
      }
      case 'land': {
        const v = e.v;
        for (let i = 0; i < 30; i++) {
          tmp.copy(v.pos).addScaledVector(v.right, (Math.random() - 0.5) * 4);
          tmp2.copy(v.vel).multiplyScalar(0.8).addScaledVector(v.right, (Math.random() - 0.5) * 30).addScaledVector(v.up, Math.random() * 8);
          P.spawn(tmp, tmp2, tmpC.setRGB(3, 2, 1.2), 0.3, 0.12, { drag: 2, grav: 20 });
        }
        break;
      }
      case 'explode': {
        const v = e.v;
        for (let i = 0; i < 220; i++) {
          const dir = tmp2.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize();
          tmp.copy(v.vel).multiplyScalar(0.6).addScaledVector(dir, 10 + Math.random() * 50);
          const hot = Math.random();
          const c = hot < 0.6 ? tmpC.setRGB(6, 2 + hot * 3, 0.5) : tmpC.copy(v.spec.thrust).multiplyScalar(5);
          P.spawn(v.pos, tmp, c, 0.6 + Math.random() * 1.2, hot < 0.3 ? 2.2 : 0.25, { drag: 1.5, grav: 12, stretch: hot < 0.3 ? 0 : 0.04 });
        }
        P.spawn(v.pos, v.vel.clone().multiplyScalar(0.6), tmpC.setRGB(20, 14, 10), 0.35, 16, { stretch: 0, drag: 1 });
        break;
      }
    }
  }

  private shadowFade: Float32Array;
  private shM = new THREE.Matrix4();
  private shF = makeFrame();
  private trailAcc = 0;
  private trailTick = false;
  private updateFx(dt: number) {
    this.trailAcc += dt;
    this.trailTick = this.trailAcc >= 1 / 60;
    if (this.trailTick) this.trailAcc = 0;
    const T = this.thrusters;
    const cam = this.world.scene.userData.camPos as THREE.Vector3 | undefined;
    T.begin();
    let trailIdx = 0;
    let lightIdx = 0;
    const lights = lightUniforms.uLights.value;
    const lcols = lightUniforms.uLightCols.value;
    // nearest vehicles get road lights
    const byDist = cam ? this.vehicles.slice().sort((a, b) => a.pos.distanceToSquared(cam) - b.pos.distanceToSquared(cam)) : this.vehicles;
    const lit = new Set(byDist.slice(0, MAX_LIGHTS));
    for (const v of this.vehicles) {
      v.object.updateMatrixWorld();
      const alive = !v.retired && v.object.visible;
      const boost = v.boosting ? 1 : 0;
      const thr = v.throttleVis;
      const back = tmp2.setFromMatrixColumn(v.object.matrixWorld, 2).normalize();
      const intensity = (1.2 + thr * 2.2 + boost * 3.5) * (v.finished ? 0.7 : 1);
      const flick = 0.9 + Math.random() * 0.1;
      const engines = v.model.engines;
      let t = 0;
      // merged single rear light (shown at distance)
      if (alive) {
        const c = tmp.set(0, 0, 0);
        let r2 = 0;
        for (const e of engines) {
          c.add(e.pos);
          r2 += e.radius * e.radius;
        }
        c.divideScalar(engines.length).applyMatrix4(v.object.matrixWorld);
        T.add(c, back, v.up, v.spec.thrust, Math.sqrt(r2) * 1.25, intensity * 1.15, 0, boost, v.id * 3.1, 1);
      }
      for (const e of engines) {
        tmp.copy(e.pos).applyMatrix4(v.object.matrixWorld);
        if (alive) {
          T.add(tmp, back, v.up, v.spec.thrust, e.radius * 1.15, intensity * flick, e.radius * (2.5 + thr * 5 + boost * 10), boost, v.id * 3.1 + t);
          if (t < 2 || e.radius > 0.35) {
            if (trailIdx < this.trails.maxTrails) if (this.trailTick) this.trails.push(trailIdx, tmp, v.spec.thrust, e.radius * 0.3 * (1 + boost * 0.6), 0.35 + thr * 0.5 + boost * 1.2);
            else this.trails.keep(trailIdx, tmp);
          }
        }
        if (t < 2 || e.radius > 0.35) {
          if (!alive && trailIdx < this.trails.maxTrails) this.trails.reset(trailIdx);
          trailIdx++;
        }
        t++;
      }
      // road light
      if (lit.has(v) && lightIdx < MAX_LIGHTS) {
        const L = lights[lightIdx];
        const C = lcols[lightIdx];
        lightIdx++;
        if (alive) {
          tmp.copy(v.pos).addScaledVector(back, 3.6).addScaledVector(v.trackUp, -0.1);
          L.set(tmp.x, tmp.y, tmp.z, (0.8 + thr * 1.2 + boost * 2.5) * (v.air ? 0.3 : 1));
          C.copy(v.spec.thrust);
        } else L.w = 0;
      }
      v.updateShield();
      // pit refill: energy streams rising around the machine
      if (alive && v.inPit && Math.random() < 0.8) {
        tmp.copy(v.pos).addScaledVector(v.right, (Math.random() - 0.5) * 5).addScaledVector(v.fwd, (Math.random() - 0.5) * 6).addScaledVector(v.trackUp, -0.6);
        this.particles.spawn(tmp, tmp2.copy(v.vel).addScaledVector(v.trackUp, 6 + Math.random() * 6), tmpC.setRGB(3, 0.4, 2), 0.45, 0.12, { drag: 0.5, stretch: 0.08 });
      }
      // damaged machines trail sparks
      if (alive && v.energy < 25 && Math.random() < (25 - v.energy) / 25) {
        tmp.copy(v.pos).addScaledVector(v.fwd, -2).addScaledVector(v.right, (Math.random() - 0.5) * 2);
        this.particles.spawn(tmp, tmp2.copy(v.vel).multiplyScalar(0.8).add(new THREE.Vector3((Math.random() - 0.5) * 8, Math.random() * 6, (Math.random() - 0.5) * 8)), tmpC.setRGB(4, 1.6, 0.4), 0.4, 0.08, { drag: 1.5, grav: 18 });
      }
      // engine sparkle particles when boosting
      if (alive && boost && Math.random() < 0.6) {
        const e = engines[Math.floor(Math.random() * engines.length)];
        tmp.copy(e.pos).applyMatrix4(v.object.matrixWorld);
        this.particles.spawn(tmp, tmp2.copy(v.vel).multiplyScalar(0.6).addScaledVector(back, 15), tmpC.copy(v.spec.thrust).lerp(WHITE, 0.4).multiplyScalar(3), 0.25, 0.15, { drag: 2, stretch: 0.04 });
      }
    }
    for (; lightIdx < MAX_LIGHTS; lightIdx++) lights[lightIdx].w = 0;
    // contact shadows
    let si = 0;
    const tr = this.world.track;
    for (const v of this.vehicles) {
      if (si >= 40) break;
      if (v.retired || !v.object.visible) continue;
      const path = tr.paths[v.path];
      const h = v.air ? Math.max(0, v.h) : v.h;
      if (v.air && (h > 60 || path.flagAt(v.s) & 1)) continue;
      const k = Math.max(0, 1 - h / 40);
      const p = new THREE.Vector3(),
        n = new THREE.Vector3(),
        lat = new THREE.Vector3();
      const f = path.surf(v.s, v.x, 0.06, p, n, lat, this.shF);
      const back = tmp2.copy(f.t).negate();
      this.shM.makeBasis(lat, n, back);
      const w = v.model.width * (0.75 + (1 - k) * 0.8);
      this.shM.scale(new THREE.Vector3(w, 1, 7.5 * (1 + (1 - k) * 0.5)));
      this.shM.setPosition(p);
      this.shadows.setMatrixAt(si, this.shM);
      this.shadowFade[si] = k;
      si++;
    }
    this.shadows.count = si;
    this.shadows.instanceMatrix.needsUpdate = true;
    (this.shadows.geometry.attributes.aFade as THREE.BufferAttribute).needsUpdate = true;
    T.end();
    if (cam) this.trails.update(cam);
    this.particles.update(dt);
  }

  /** Speed-line streaks around the camera. */
  speedLines(cam: THREE.Camera, v: Vehicle, frac: number, boost: number) {
    if (frac < 0.55 || v.air) return;
    const n = Math.floor((frac - 0.55) * 14 + boost * 8);
    const f = makeFrame();
    const path = this.world.track.paths[v.path];
    for (let i = 0; i < n; i++) {
      const ahead = 30 + Math.random() * 60;
      path.sample(path.wrapS(v.s + ahead), f);
      const ang = Math.random() * Math.PI * 2;
      const r = 6 + Math.random() * 14;
      tmp.copy(f.p).addScaledVector(f.r, v.x + Math.cos(ang) * r * 1.6).addScaledVector(f.u, 2 + Math.sin(ang) * r * 0.7);
      tmp2.copy(v.vel).multiplyScalar(0.001);
      this.particles.spawn(tmp, tmp2.copy(f.t).multiplyScalar(1), tmpC.setRGB(0.5, 0.7, 1).multiplyScalar(0.6 + boost), 0.35, 0.04, { drag: 0, stretch: 8 + boost * 10 });
    }
    void cam;
    void clamp;
    void HALF_W;
  }
}
