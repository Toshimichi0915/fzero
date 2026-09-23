import * as THREE from 'three';
import { globalUniforms } from '../shaders/common';

/**
 * CPU-simulated additive particles rendered as velocity-stretched billboards.
 * kind: 0 = spark (streak), 1 = soft glow puff, 2 = debris/fire
 */
export class Particles {
  mesh: THREE.Mesh;
  private p: Float32Array; // pos
  private v: Float32Array; // vel
  private c: Float32Array; // color
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private drag: Float32Array;
  private grav: Float32Array;
  private stretch: Float32Array;
  private iPos: Float32Array;
  private iVel: Float32Array;
  private iCol: Float32Array;
  private iPrm: Float32Array;
  private next = 0;
  constructor(public max = 6000) {
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.c = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.stretch = new Float32Array(max);
    this.iPos = new Float32Array(max * 3);
    this.iVel = new Float32Array(max * 3);
    this.iCol = new Float32Array(max * 3);
    this.iPrm = new Float32Array(max * 2);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.iPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iVel', new THREE.InstancedBufferAttribute(this.iVel, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iCol', new THREE.InstancedBufferAttribute(this.iCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iPrm', new THREE.InstancedBufferAttribute(this.iPrm, 2).setUsage(THREE.DynamicDrawUsage));
    const m = new THREE.ShaderMaterial({
      uniforms: { ...globalUniforms },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute vec3 iVel; attribute vec3 iCol; attribute vec2 iPrm;
        uniform vec3 uCamPos;
        varying vec2 vUv; varying vec3 vCol;
        void main(){
          vUv = position.xy;
          vCol = iCol;
          vec3 toCam = normalize(uCamPos - iPos);
          vec3 vel = iVel * iPrm.y;
          float vl = length(vel);
          vec3 ax = vl > .01 ? vel / vl : vec3(0.,1.,0.);
          vec3 side = cross(ax, toCam); side /= max(length(side), 1e-4);
          if(vl < .01){ ax = normalize(cross(toCam, vec3(0.,1.,0.)+1e-3)); side = cross(ax, toCam); }
          float len = iPrm.x + vl;
          vec3 w = iPos + ax * position.y * len * .5 - ax * len * .5 + side * position.x * iPrm.x;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vCol;
        void main(){
          float r = length(vUv);
          float a = exp(-r * r * 3.5) * smoothstep(1., .6, r);
          gl_FragColor = vec4(vCol * a, 1.);
        }`,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
  }
  spawn(pos: THREE.Vector3, vel: THREE.Vector3, color: THREE.Color, life: number, size: number, opts: { drag?: number; grav?: number; stretch?: number } = {}) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.p.set([pos.x, pos.y, pos.z], i * 3);
    this.v.set([vel.x, vel.y, vel.z], i * 3);
    this.c.set([color.r, color.g, color.b], i * 3);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.drag[i] = opts.drag ?? 1;
    this.grav[i] = opts.grav ?? 0;
    this.stretch[i] = opts.stretch ?? 0.03;
  }
  update(dt: number) {
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) continue;
      const k = Math.exp(-this.drag[i] * dt);
      this.v[i * 3] *= k;
      this.v[i * 3 + 1] = this.v[i * 3 + 1] * k - this.grav[i] * dt;
      this.v[i * 3 + 2] *= k;
      this.p[i * 3] += this.v[i * 3] * dt;
      this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt;
      this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      const f = this.life[i] / this.maxLife[i];
      this.iPos.set(this.p.subarray(i * 3, i * 3 + 3), n * 3);
      this.iVel.set(this.v.subarray(i * 3, i * 3 + 3), n * 3);
      const fade = f * f;
      this.iCol[n * 3] = this.c[i * 3] * fade;
      this.iCol[n * 3 + 1] = this.c[i * 3 + 1] * fade;
      this.iCol[n * 3 + 2] = this.c[i * 3 + 2] * fade;
      this.iPrm[n * 2] = this.size[i] * (0.4 + 0.6 * f);
      this.iPrm[n * 2 + 1] = this.stretch[i];
      n++;
    }
    const g = this.mesh.geometry as THREE.InstancedBufferGeometry;
    g.instanceCount = n;
    for (const k of ['iPos', 'iVel', 'iCol', 'iPrm']) (g.attributes[k] as THREE.BufferAttribute).needsUpdate = true;
  }
}
