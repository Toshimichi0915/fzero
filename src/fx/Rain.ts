import * as THREE from 'three';
import { globalUniforms } from '../shaders/common';

/**
 * Camera-wrapped GPU rain. Streaks are stretched along their velocity relative
 * to the camera, so at 1000+ km/h the rain whips past almost horizontally.
 */
export class Rain {
  mesh: THREE.Mesh;
  uniforms = {
    uCamVel: { value: new THREE.Vector3() },
    uIntensity: { value: 0 },
  };
  constructor(count = 14000) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i++) seeds[i] = Math.random();
    g.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = count;
    const m = new THREE.ShaderMaterial({
      uniforms: { ...globalUniforms, ...this.uniforms },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec4 iSeed;
        uniform vec3 uCamPos; uniform vec3 uCamVel; uniform float uTime; uniform float uIntensity;
        varying float vA; varying vec2 vUv;
        void main(){
          vec3 box = vec3(90., 50., 90.);
          vec3 fall = vec3(6., -38. - iSeed.w * 12., 3.);
          vec3 p0 = iSeed.xyz * box + fall * uTime;
          vec3 wp = uCamPos + (fract((p0 - uCamPos) / box) - .5) * box;
          vec3 rel = fall - uCamVel;
          vec3 dir = normalize(rel);
          float len = clamp(length(rel) * .025, .4, 6.);
          vec3 toCam = normalize(uCamPos - wp);
          vec3 side = normalize(cross(dir, toCam)) * .018 * (1. + length(wp - uCamPos) * .01);
          vec3 w = wp + side * position.x + dir * position.y * len;
          float d = length(wp - uCamPos);
          vA = uIntensity * smoothstep(45., 20., d) * smoothstep(.5, 3., d) * step(iSeed.w, uIntensity * 1.2);
          vUv = position.xy;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.);
        }`,
      fragmentShader: /* glsl */ `
        varying float vA; varying vec2 vUv;
        void main(){
          float a = (1. - abs(vUv.x)) * sin(vUv.y * 3.14159);
          gl_FragColor = vec4(vec3(.55, .7, 1.) * a * vA * .32, 1.);
        }`,
    });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12;
    this.mesh.visible = false;
  }
  set(on: boolean) {
    this.mesh.visible = on;
    this.uniforms.uIntensity.value = on ? 1 : 0;
  }
}
