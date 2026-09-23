import * as THREE from 'three';

/** Global uniforms shared by all custom shaders. */
export const globalUniforms = {
  uTime: { value: 0 },
  uFogColor: { value: new THREE.Color(0.03, 0.014, 0.06) },
  uFogDensity: { value: 0.00045 },
  uFogHeight: { value: 260 },
  uCamPos: { value: new THREE.Vector3() },
};

export const noiseGLSL = /* glsl */ `
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), f.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float a = .5, s = 0.; for(int i=0;i<5;i++){ s += a*vnoise(p); p = p*2.03 + 17.1; a *= .5; } return s; }
`;

export const fogParsGLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFogHeight;
uniform vec3 uCamPos;
vec3 applyFog(vec3 col, vec3 wpos){
  float d = length(wpos - uCamPos);
  float hy = max(0., (wpos.y + uCamPos.y) * .5);
  float dens = uFogDensity * (0.35 + 0.65 * exp(-hy / uFogHeight));
  float f = 1. - exp(-d * dens);
  // glow toward the horizon: fog picks up city light near ground
  vec3 fc = uFogColor * (1. + 1.6 * exp(-max(wpos.y, 0.) / 120.));
  return mix(col, fc, clamp(f, 0., 1.));
}
`;
