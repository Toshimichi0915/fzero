import * as THREE from 'three';
import { globalUniforms } from '../shaders/common';

/** Camera-facing light ribbons behind the engines. */
export class Trails {
  mesh: THREE.Mesh;
  private hist: Float32Array; // [trail][point][xyz]
  private head: Int32Array;
  private filled: Int32Array;
  private colors: Float32Array;
  private widths: Float32Array;
  private intens: Float32Array;
  private active: Uint8Array;
  private pos: Float32Array;
  private col: Float32Array;
  private uv: Float32Array;
  constructor(
    public maxTrails: number,
    public N = 14,
  ) {
    this.hist = new Float32Array(maxTrails * N * 3);
    this.head = new Int32Array(maxTrails);
    this.filled = new Int32Array(maxTrails);
    this.colors = new Float32Array(maxTrails * 3);
    this.widths = new Float32Array(maxTrails);
    this.intens = new Float32Array(maxTrails);
    this.active = new Uint8Array(maxTrails);
    const verts = maxTrails * N * 2;
    this.pos = new Float32Array(verts * 3);
    this.col = new Float32Array(verts * 3);
    this.uv = new Float32Array(verts * 2);
    const idx: number[] = [];
    for (let t = 0; t < maxTrails; t++)
      for (let i = 0; i < N - 1; i++) {
        const a = (t * N + i) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    const m = new THREE.ShaderMaterial({
      uniforms: { ...globalUniforms },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 color; varying vec3 vCol; varying vec2 vUv;
        void main(){ vCol = color; vUv = uv; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol; varying vec2 vUv;
        void main(){
          float across = 1. - abs(vUv.y * 2. - 1.);
          float a = pow(clamp(across, 0., 1.), 2.) * pow(clamp(1. - vUv.x, 0., 1.), 2.5);
          gl_FragColor = vec4(vCol * a, 1.);
        }`,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
  }
  push(t: number, p: THREE.Vector3, color: THREE.Color, width: number, intensity: number) {
    const N = this.N;
    this.head[t] = (this.head[t] + 1) % N;
    const i = (t * N + this.head[t]) * 3;
    this.hist[i] = p.x;
    this.hist[i + 1] = p.y;
    this.hist[i + 2] = p.z;
    this.filled[t] = Math.min(N, this.filled[t] + 1);
    this.colors.set([color.r, color.g, color.b], t * 3);
    this.widths[t] = width;
    this.intens[t] = intensity;
    this.active[t] = 1;
  }
  /** update only the newest point (between samples) */
  keep(t: number, p: THREE.Vector3) {
    if (this.filled[t] === 0) return;
    const i = (t * this.N + this.head[t]) * 3;
    this.hist[i] = p.x;
    this.hist[i + 1] = p.y;
    this.hist[i + 2] = p.z;
    this.active[t] = 1;
  }
  reset(t: number) {
    this.filled[t] = 0;
    this.active[t] = 0;
  }
  update(cam: THREE.Vector3) {
    const N = this.N;
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      tan = new THREE.Vector3(),
      view = new THREE.Vector3(),
      side = new THREE.Vector3();
    for (let t = 0; t < this.maxTrails; t++) {
      const f = this.filled[t];
      for (let k = 0; k < N; k++) {
        const vi = (t * N + k) * 2;
        if (!this.active[t] || k >= f) {
          // collapse
          this.pos.fill(0, vi * 3, vi * 3 + 6);
          this.col.fill(0, vi * 3, vi * 3 + 6);
          continue;
        }
        const idx = (this.head[t] - k + N) % N;
        const idx2 = (this.head[t] - Math.min(k + 1, f - 1) + N) % N;
        a.fromArray(this.hist, (t * N + idx) * 3);
        b.fromArray(this.hist, (t * N + idx2) * 3);
        tan.subVectors(a, b);
        if (tan.lengthSq() < 1e-6) tan.set(0, 0, 1);
        view.subVectors(cam, a);
        side.crossVectors(tan, view);
        const sl = side.length();
        if (sl < 1e-6) side.set(0, 1, 0);
        else side.multiplyScalar(1 / sl);
        const age = k / (N - 1);
        const w = this.widths[t] * (1 - age * 0.5);
        this.pos[vi * 3] = a.x + side.x * w;
        this.pos[vi * 3 + 1] = a.y + side.y * w;
        this.pos[vi * 3 + 2] = a.z + side.z * w;
        this.pos[vi * 3 + 3] = a.x - side.x * w;
        this.pos[vi * 3 + 4] = a.y - side.y * w;
        this.pos[vi * 3 + 5] = a.z - side.z * w;
        const I = this.intens[t];
        for (let c = 0; c < 3; c++) {
          this.col[vi * 3 + c] = this.colors[t * 3 + c] * I;
          this.col[vi * 3 + 3 + c] = this.colors[t * 3 + c] * I;
        }
        this.uv[vi * 2] = age;
        this.uv[vi * 2 + 1] = 0;
        this.uv[vi * 2 + 2] = age;
        this.uv[vi * 2 + 3] = 1;
      }
      this.active[t] = 0; // must be pushed again next frame
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
  }
}
