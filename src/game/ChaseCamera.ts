import * as THREE from 'three';
import { Vehicle } from '../vehicles/Vehicle';
import { damp } from '../core/util';

export const CAMERA_MODES = ['CHASE', 'FAR', 'COCKPIT'] as const;

export class ChaseCamera {
  mode = 0;
  rear = false;
  pos = new THREE.Vector3();
  up = new THREE.Vector3(0, 1, 0);
  look = new THREE.Vector3();
  fwd = new THREE.Vector3(0, 0, -1);
  fov = 72;
  shake = 0;
  private shakeT = 0;
  private initialized = false;
  constructor(public camera: THREE.PerspectiveCamera) {}

  addShake(a: number) {
    this.shake = Math.min(1.5, this.shake + a);
  }
  snap() {
    this.initialized = false;
  }

  update(dt: number, v: Vehicle, speedFrac: number, boost: number) {
    const [dist, height, lookAhead, lookUp] = [
      [10.5, 3.1, 14, 1.4],
      [17, 5.2, 18, 1.8],
      [-1.2, 0.95, 30, 0.8],
    ][this.mode];
    // heading used by camera = blend of nose and velocity direction
    const vdir = v.vel.lengthSq() > 4 ? v.vel.clone().normalize() : v.fwd.clone();
    const want = v.fwd.clone().lerp(vdir, 0.45).normalize();
    const upTarget = v.air ? new THREE.Vector3(0, 1, 0).lerp(v.trackUp, 0.3).normalize() : v.trackUp;
    if (!this.initialized) {
      this.fwd.copy(want);
      this.up.copy(upTarget);
      this.initialized = true;
      this.pos.copy(v.pos).addScaledVector(want, -dist).addScaledVector(upTarget, height);
    }
    const coc = this.mode === 2;
    this.fwd.lerp(want, 1 - Math.exp(-(coc ? 20 : 7) * dt)).normalize();
    this.up.lerp(upTarget, 1 - Math.exp(-(coc ? 14 : 5) * dt)).normalize();
    const back = this.rear ? -1 : 1;
    const d = dist * (1 + speedFrac * 0.12 - boost * 0.08);
    const target = v.pos
      .clone()
      .addScaledVector(this.fwd, -d * back)
      .addScaledVector(this.up, height);
    if (coc) this.pos.copy(target);
    else {
      // stiff in the direction of travel, softer laterally
      this.pos.x = damp(this.pos.x, target.x, 16, dt);
      this.pos.y = damp(this.pos.y, target.y, 12, dt);
      this.pos.z = damp(this.pos.z, target.z, 16, dt);
      // never lag too far behind at high speed
      const off = this.pos.clone().sub(target);
      if (off.length() > 4) this.pos.copy(target).addScaledVector(off.normalize(), 4);
    }
    this.look.copy(v.pos).addScaledVector(this.fwd, lookAhead * back).addScaledVector(this.up, lookUp);
    // shake
    this.shakeT += dt;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const s = this.shake * this.shake * 0.5 + speedFrac * boost * 0.04;
    const sh = new THREE.Vector3(Math.sin(this.shakeT * 53) * s, Math.sin(this.shakeT * 61 + 1) * s, Math.sin(this.shakeT * 47 + 2) * s * 0.5);
    this.camera.position.copy(this.pos).add(sh);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.look);
    const fovTarget = (coc ? 80 : 70) + speedFrac * 20 + boost * 12;
    this.fov = damp(this.fov, fovTarget, 3, dt);
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }
}
