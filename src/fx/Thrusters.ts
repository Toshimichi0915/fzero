import * as THREE from 'three';
import { globalUniforms } from '../shaders/common';

/**
 * Engine glow system. Each engine gets:
 *  - a camera-facing glow billboard whose intensity/size explodes when viewed from behind
 *    (with an anamorphic horizontal streak), and
 *  - an exhaust plume (additive cone) whose length depends on throttle/boost.
 */
export class Thrusters {
  glowMesh: THREE.Mesh;
  plumeMesh: THREE.Mesh;
  private gPos: Float32Array;
  private gDir: Float32Array;
  private gCol: Float32Array;
  private gPrm: Float32Array; // radius, intensity, flicker seed, boost
  private gLod: Float32Array;
  private pPos: Float32Array;
  private pDir: Float32Array;
  private pUp: Float32Array;
  private pCol: Float32Array;
  private pPrm: Float32Array; // radius, length, intensity, seed
  count = 0;
  constructor(public max: number) {
    // glows
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.gPos = new Float32Array(max * 3);
    this.gDir = new Float32Array(max * 3);
    this.gCol = new Float32Array(max * 3);
    this.gPrm = new Float32Array(max * 4);
    this.gLod = new Float32Array(max);
    g.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.gPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iDir', new THREE.InstancedBufferAttribute(this.gDir, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iCol', new THREE.InstancedBufferAttribute(this.gCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iPrm', new THREE.InstancedBufferAttribute(this.gPrm, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('iLod', new THREE.InstancedBufferAttribute(this.gLod, 1).setUsage(THREE.DynamicDrawUsage));
    const gm = new THREE.ShaderMaterial({
      uniforms: { ...globalUniforms },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute vec3 iDir; attribute vec3 iCol; attribute vec4 iPrm; attribute float iLod;
        uniform vec3 uCamPos; uniform float uTime; uniform float uFogDensity;
        varying vec2 vUv; varying vec3 vCol; varying float vBehind; varying float vCross; varying float vArms;
        void main(){
          vec3 toCam = uCamPos - iPos;
          float dist = length(toCam);
          vec3 vd = toCam / max(dist, .001);
          float behind = max(dot(vd, iDir), 0.);   // 1 when looking straight into the nozzle
          float b = pow(behind, 3.);
          vBehind = b;
          // LOD: individual nozzles up close, one merged light per machine further away
          float far = smoothstep(45., 95., dist);
          float lodW = iLod < .5 ? 1. - far : far;
          // don't overdo it up close
          float nearK = smoothstep(8., 60., dist);
          float flick = .9 + .1 * sin(uTime * 60. + iPrm.z * 17.) * sin(uTime * 37. + iPrm.z * 3.);
          float inten = iPrm.y * flick * (.25 + 1.5 * b) * (1. + iPrm.w * .8) * mix(.35, 1., nearK) * lodW;
          float size = iPrm.x * (1.4 + 2.2 * b * mix(.3, 1., nearK) + iPrm.w * 1.2) * (1. + dist * .0035);
          // cross flare arms extend the quad when seen from behind
          float arms = 1. + 2.2 * b * nearK;
          vCross = b * mix(.25, 1., nearK);
          vArms = arms;
          vCol = iCol * inten * exp(-dist * uFogDensity * .5);
          vUv = position.xy * arms;
          vec4 mv = viewMatrix * vec4(iPos + vd * .4, 1.);
          mv.xy += position.xy * size * arms;
          gl_Position = projectionMatrix * mv;
          if(lodW < .002) gl_Position = vec4(2., 2., 2., 1.);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vCol; varying float vBehind; varying float vCross; varying float vArms;
        void main(){
          vec2 p = vUv;
          float r = length(p);
          float core = exp(-r * r * 30.);
          // round halo that fully fades before the quad border (r = 1 is the halo edge)
          float halo = exp(-r * 3.) * .45 * smoothstep(1., .55, r);
          // four-point cross flare (horizontal + vertical), tapering to zero at the arm tips
          float tipX = smoothstep(vArms, vArms * .35, abs(p.x));
          float tipY = smoothstep(vArms, vArms * .35, abs(p.y));
          float cross = (exp(-abs(p.y) * 38.) * exp(-abs(p.x) * 1.6) * tipX + exp(-abs(p.x) * 38.) * exp(-abs(p.y) * 1.6) * tipY) * vCross;
          vec3 col = vCol * (core * 1.6 + halo);
          float lum = min(dot(vCol, vec3(.3333)), 14.);
          col += vec3(1.) * lum * (core * .35 + cross * .9);
          col += vCol * cross * .35;
          gl_FragColor = vec4(col, 1.);
        }`,
    });
    this.glowMesh = new THREE.Mesh(g, gm);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 10;

    // plumes: cone along +Z (local), apex at z=len
    const cone = new THREE.CylinderGeometry(0, 1, 1, 16, 8, true);
    cone.rotateX(-Math.PI / 2); // along +Z... apex towards -z; fix below
    cone.translate(0, 0, 0.5);
    const pg = new THREE.InstancedBufferGeometry();
    pg.index = cone.index;
    pg.setAttribute('position', cone.attributes.position);
    pg.setAttribute('uv', cone.attributes.uv);
    this.pPos = new Float32Array(max * 3);
    this.pDir = new Float32Array(max * 3);
    this.pUp = new Float32Array(max * 3);
    this.pCol = new Float32Array(max * 3);
    this.pPrm = new Float32Array(max * 4);
    pg.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('iDir', new THREE.InstancedBufferAttribute(this.pDir, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('iUp', new THREE.InstancedBufferAttribute(this.pUp, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('iCol', new THREE.InstancedBufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('iPrm', new THREE.InstancedBufferAttribute(this.pPrm, 4).setUsage(THREE.DynamicDrawUsage));
    const pm = new THREE.ShaderMaterial({
      uniforms: { ...globalUniforms },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute vec3 iDir; attribute vec3 iUp; attribute vec3 iCol; attribute vec4 iPrm;
        uniform vec3 uCamPos; uniform float uTime;
        varying float vZ; varying vec3 vCol; varying float vFres; varying float vSeed;
        void main(){
          // cone local: z in [0,1] (0 = nozzle, wide end after rotate... ) radius shrinks along z
          vec3 p = position;
          float z = p.z;           // 0..1
          vZ = z;
          vec3 right = normalize(cross(iDir, iUp));
          vec3 up = cross(right, iDir);
          float rad = iPrm.x * (1. - z * .85);
          float wob = 1. + .08 * sin(uTime * 70. + z * 20. + iPrm.w);
          vec3 w = iPos + iDir * (z * iPrm.y) + (right * p.x + up * p.y) * rad * wob / max(length(p.xy), 1e-4) * length(p.xy);
          vec3 n = (right * p.x + up * p.y); n = n / max(length(n), 1e-4);
          vec3 vd = normalize(uCamPos - w);
          vFres = abs(dot(n, vd));
          vCol = iCol * iPrm.z;
          vSeed = iPrm.w;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying float vZ; varying vec3 vCol; varying float vFres; varying float vSeed;
        void main(){
          float zc = clamp(vZ, 0., 1.);
          float fade = pow(1. - zc, 1.6);
          float bands = .75 + .25 * sin(vZ * 40. - uTime * 90. + vSeed);
          float a = fade * bands * pow(clamp(vFres, 0., 1.), 1.5);
          vec3 col = mix(vCol, vec3(length(vCol)) * .8, pow(1. - zc, 8.) * .6);
          gl_FragColor = vec4(col * a, 1.);
        }`,
    });
    // cone geometry from Cylinder(0 top radius): after rotateX(-90) the top (radius 0) points to -Z.
    // flip so z=0 is the wide nozzle end and z=1 is the apex
    const pos = cone.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, 1 - pos.getZ(i));
    this.plumeMesh = new THREE.Mesh(pg, pm);
    this.plumeMesh.frustumCulled = false;
    this.plumeMesh.renderOrder = 9;
  }

  begin() {
    this.count = 0;
  }
  add(pos: THREE.Vector3, back: THREE.Vector3, up: THREE.Vector3, color: THREE.Color, radius: number, intensity: number, plumeLen: number, boost: number, seed: number, lod = 0) {
    const i = this.count++;
    if (i >= this.max) return;
    this.gPos.set([pos.x, pos.y, pos.z], i * 3);
    this.gDir.set([back.x, back.y, back.z], i * 3);
    this.gCol.set([color.r, color.g, color.b], i * 3);
    this.gPrm.set([radius, intensity, seed, boost], i * 4);
    this.gLod[i] = lod;
    this.pPos.set([pos.x, pos.y, pos.z], i * 3);
    this.pDir.set([back.x, back.y, back.z], i * 3);
    this.pUp.set([up.x, up.y, up.z], i * 3);
    this.pCol.set([color.r, color.g, color.b], i * 3);
    this.pPrm.set([radius * 0.95, lod ? 0 : plumeLen, lod ? 0 : intensity * 0.8, seed], i * 4);
  }
  end() {
    const n = Math.min(this.count, this.max);
    const g = this.glowMesh.geometry as THREE.InstancedBufferGeometry;
    g.instanceCount = n;
    for (const k of ['iPos', 'iDir', 'iCol', 'iPrm', 'iLod']) (g.attributes[k] as THREE.BufferAttribute).needsUpdate = true;
    const p = this.plumeMesh.geometry as THREE.InstancedBufferGeometry;
    p.instanceCount = n;
    for (const k of ['iPos', 'iDir', 'iUp', 'iCol', 'iPrm']) (p.attributes[k] as THREE.BufferAttribute).needsUpdate = true;
  }
}
