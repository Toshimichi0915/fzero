import * as THREE from 'three';
import { Vehicle } from '../vehicles/Vehicle';
import { Track, HALF_W } from '../track/Track';
import { makeFrame } from '../track/Path';
import { damp } from '../core/util';

type Shot = 'chase' | 'trackside' | 'heli' | 'front' | 'orbit' | 'wheel';

/** TV-style race director camera used for attract mode and post-race. */
export class CineCamera {
  shot: Shot = 'chase';
  timer = 0;
  target: Vehicle | null = null;
  private fixed = new THREE.Vector3();
  private look = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private orbitA = 0;
  private side = 1;
  private fr = makeFrame();
  forceTarget: Vehicle | null = null;
  private snapFov = false;
  constructor(public camera: THREE.PerspectiveCamera) {}
  private k(rate: number, dt: number) {
    return this.snapFov ? 1 : 1 - Math.exp(-rate * dt);
  }

  cut(vehicles: Vehicle[], track: Track) {
    const alive = vehicles.filter((v) => !v.retired && !v.air);
    if (!alive.length) return;
    // prefer interesting targets: the pack leader or a machine in traffic
    if (this.forceTarget) this.target = this.forceTarget;
    else {
      const sorted = alive.slice().sort((a, b) => b.raceDist - a.raceDist);
      this.target = Math.random() < 0.35 ? sorted[0] : sorted[Math.floor(Math.random() * Math.min(sorted.length, 20))];
    }
    const shots: Shot[] = ['chase', 'trackside', 'trackside', 'heli', 'front', 'orbit', 'wheel'];
    let next = shots[Math.floor(Math.random() * shots.length)];
    if (next === this.shot) next = shots[(shots.indexOf(next) + 1) % shots.length];
    this.shot = next;
    this.snapFov = true;
    this.timer = next === 'trackside' ? 4.5 : 5 + Math.random() * 2;
    this.side = Math.random() < 0.5 ? -1 : 1;
    this.orbitA = Math.random() * Math.PI * 2;
    const v = this.target!;
    if (next === 'trackside') {
      const path = track.paths[v.path];
      const ahead = Math.max(120, v.v * 2.2);
      const s = path.closed ? path.wrapS(v.s + ahead) : Math.min(path.length - 1, v.s + ahead);
      path.sample(s, this.fr);
      this.fixed
        .copy(this.fr.p)
        .addScaledVector(this.fr.r, this.side * (HALF_W + 6 + Math.random() * 20))
        .addScaledVector(this.fr.u, 3 + Math.random() * 14);
      this.up.copy(this.fr.u);
    }
  }

  update(dt: number, vehicles: Vehicle[], track: Track) {
    this.timer -= dt;
    if (this.timer <= 0 || !this.target || this.target.retired) this.cut(vehicles, track);
    const v = this.target;
    if (!v) return;
    const cam = this.camera;
    let fov = 60;
    const up = v.air ? new THREE.Vector3(0, 1, 0) : v.trackUp;
    switch (this.shot) {
      case 'chase': {
        const p = v.pos.clone().addScaledVector(v.fwd, -9).addScaledVector(up, 2.2).addScaledVector(v.right, this.side * 3);
        cam.position.lerp(p, this.k(8, dt));
        this.look.copy(v.pos).addScaledVector(v.fwd, 12);
        this.up.lerp(up, this.k(4, dt));
        fov = 55;
        break;
      }
      case 'wheel': {
        const p = v.pos.clone().addScaledVector(v.fwd, -3.5).addScaledVector(up, 0.9).addScaledVector(v.right, this.side * (v.model.width * 0.5 + 1.6));
        cam.position.copy(p);
        this.look.copy(v.pos).addScaledVector(v.fwd, 30);
        this.up.copy(up);
        fov = 75;
        break;
      }
      case 'trackside': {
        cam.position.copy(this.fixed);
        this.look.lerp(v.pos, this.k(12, dt));
        const d = cam.position.distanceTo(v.pos);
        fov = THREE.MathUtils.clamp(2400 / Math.max(d, 1), 18, 70);
        break;
      }
      case 'heli': {
        const p = v.pos.clone().addScaledVector(v.fwd, -45).addScaledVector(up, 28).addScaledVector(v.right, this.side * 20);
        cam.position.lerp(p, this.k(3, dt));
        this.look.copy(v.pos).addScaledVector(v.fwd, 20);
        this.up.lerp(up, this.k(2, dt));
        fov = 55;
        break;
      }
      case 'front': {
        const p = v.pos.clone().addScaledVector(v.fwd, 14).addScaledVector(up, 1.8).addScaledVector(v.right, this.side * 1.5);
        cam.position.lerp(p, this.k(10, dt));
        this.look.copy(v.pos).addScaledVector(v.fwd, -10);
        this.up.lerp(up, this.k(5, dt));
        fov = 50;
        break;
      }
      case 'orbit': {
        this.orbitA += dt * 0.35;
        const off = v.right
          .clone()
          .multiplyScalar(Math.cos(this.orbitA) * 11)
          .addScaledVector(v.fwd, Math.sin(this.orbitA) * 11)
          .addScaledVector(up, 3.5);
        cam.position.copy(v.pos).add(off);
        this.look.copy(v.pos);
        this.up.lerp(up, this.k(5, dt));
        fov = 50;
        break;
      }
    }
    cam.up.copy(this.up);
    cam.lookAt(this.look);
    cam.fov = this.snapFov ? fov : damp(cam.fov, fov, 6, dt);
    this.snapFov = false;
    cam.updateProjectionMatrix();
  }
}
