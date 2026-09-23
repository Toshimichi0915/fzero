import * as THREE from 'three';
import { globalUniforms } from '../shaders/common';

/**
 * Static glow sprites (billboards, additive). Used for beacons, lamps, etc.
 * Each sprite: position, color (HDR), size, blink frequency/phase.
 */
export class StaticGlows {
  mesh: THREE.Mesh;
  private pos: number[] = [];
  private col: number[] = [];
  private prm: number[] = []; // size, blinkFreq, phase, minVisDist
  constructor() {
    this.mesh = new THREE.Mesh();
  }
  add(p: THREE.Vector3, c: THREE.Color, size: number, freq = 0, phase = 0) {
    this.pos.push(p.x, p.y, p.z);
    this.col.push(c.r, c.g, c.b);
    this.prm.push(size, freq, phase, 0);
  }
  build() {
    const n = this.pos.length / 3;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('iCol', new THREE.InstancedBufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('iPrm', new THREE.InstancedBufferAttribute(new Float32Array(this.prm), 4));
    g.instanceCount = n;
    const m = new THREE.ShaderMaterial({
      uniforms: { ...globalUniforms },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute vec3 iCol; attribute vec4 iPrm;
        uniform float uTime; uniform vec3 uCamPos; uniform float uFogDensity;
        varying vec2 vUv; varying vec3 vCol;
        void main(){
          vUv = position.xy;
          float blink = iPrm.y > 0. ? step(.5, fract(uTime * iPrm.y + iPrm.z)) : 1.;
          float d = length(iPos - uCamPos);
          // grow with distance so far lights stay visible as points
          float size = iPrm.x * (1. + d * .0012);
          vCol = iCol * blink * exp(-d * uFogDensity * .7);
          vec4 mv = viewMatrix * vec4(iPos, 1.);
          mv.xy += position.xy * size;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vCol;
        void main(){
          float r = length(vUv);
          float a = exp(-r*r*5.) + exp(-r*16.) * .8;
          a *= smoothstep(1., .8, r);
          gl_FragColor = vec4(vCol * a, 1.);
        }`,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    return this.mesh;
  }
}
