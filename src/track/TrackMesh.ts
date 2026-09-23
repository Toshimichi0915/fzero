import * as THREE from 'three';
import { Track, HALF_W } from './Track';
import { Path, F_GAP, F_NORAIL_L, F_NORAIL_R, F_TUNNEL, F_NOSUPPORT, F_LOOP, WRAP_CURL } from './Path';
import { fogParsGLSL, globalUniforms, noiseGLSL } from '../shaders/common';
import { reflectionUniforms, ROAD_LAYER } from '../fx/RoadReflection';

export const MAX_LIGHTS = 32;
/** Dynamic thruster lights that illuminate the road (position.xyz, intensity) */
export const lightUniforms = {
  uLights: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4(0, -1e5, 0, 0)) },
  uLightCols: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Color(0, 0, 0)) },
  uEnv: { value: null as THREE.Texture | null },
};
export const MAX_HITS = 8;
export const barrierUniforms = {
  // world position xyz + time of impact
  uHits: { value: Array.from({ length: MAX_HITS }, () => new THREE.Vector4(0, -1e5, 0, -100)) },
};

const STEP = 2;
export const GLASS_CURL = 0.6;

function ringCount(p: Path) {
  return Math.floor((p.n - 1) / STEP) + 1 + (p.closed ? 1 : 0);
}
function ringIndex(p: Path, k: number) {
  const i = k * STEP;
  return p.closed ? i % p.n : Math.min(i, p.n - 1);
}

const roadVert = /* glsl */ `
  attribute vec2 aLat; // x lateral (m), s
  attribute vec2 aExt;
  attribute float aCurl;
  varying float vCurl;
  varying vec2 vLat;
  varying vec2 vExt;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main(){
    vLat = aLat; vExt = aExt; vCurl = aCurl;
    vec4 w = modelMatrix * vec4(position, 1.);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const roadFrag = /* glsl */ `
  ${fogParsGLSL}
  ${noiseGLSL}
  #define MAX_LIGHTS ${MAX_LIGHTS}
  uniform vec4 uLights[MAX_LIGHTS];
  uniform vec3 uLightCols[MAX_LIGHTS];
  uniform samplerCube uEnv;
  uniform vec3 uEdgeColA;
  uniform vec3 uEdgeColB;
  uniform sampler2D uReflTex;
  uniform mat4 uReflMatrix;
  uniform float uReflOn;
  uniform vec3 uReflNormal;
  uniform vec3 uReflPoint;
  uniform float uWet;
  varying float vCurl;
  varying vec2 vLat;
  varying vec2 vExt;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main(){
    float x = vLat.x, s = vLat.y;
    vec3 N = normalize(vNormal);
    if(!gl_FrontFacing) N = -N;
    vec3 V = normalize(uCamPos - vWorld);
    float dl = x + vExt.x;
    float dr = vExt.y - x;
    float de = abs(vCurl) > .97 ? 1e3 : min(dl, dr);
    // --- base plating
    vec2 pc = vec2(x / 5.5, s / 11.);
    vec2 pf = fract(pc);
    vec2 pid = floor(pc);
    float seam = smoothstep(.0, .03, pf.x) * smoothstep(1., .97, pf.x) * smoothstep(0., .015, pf.y) * smoothstep(1., .985, pf.y);
    float plateTone = hash12(pid) * .35 + .65;
    float grain = vnoise(vec2(x*3., s*.4)) * .5 + vnoise(vec2(x*20., s*20.)) * .5;
    vec3 base = vec3(.030, .034, .048) * plateTone * (.8 + .4*grain);
    base *= mix(.35, 1., seam);
    // subtle hex micro pattern
    float hex = smoothstep(.45,.5, abs(fract(x*.9 + .5*floor(s*.9)) - .5) + abs(fract(s*.9)-.5)*.2);
    base += hex * .004;
    // --- lane markings (dashed)
    float lane = 0.;
    for(int i=-1;i<=1;i++){
      float lx = float(i) * 11.;
      float d = abs(x - lx);
      lane += smoothstep(.22, .12, d) * step(.45, fract(s / 14.));
    }
    // --- edge striping (F-Zero style hazard band)
    float bandW = 2.2;
    float band = smoothstep(bandW, bandW - .1, de) * smoothstep(.55, .65, de);
    float stripes = step(.5, fract(s / 6.));
    vec3 bandCol = mix(vec3(.9,.05,.5), vec3(.85,.85,.95), stripes) * .45;
    // glowing edge line
    float edgeLine = exp(-max(de - .15, 0.) * 5.) ;
    vec3 edgeCol = mix(uEdgeColA, uEdgeColB, step(0., x));
    // --- lighting: reflections + dynamic lights
    vec3 R = reflect(-V, N);
    float fres = .04 + .96 * pow(1. - max(dot(N, V), 0.), 5.);
    vec3 env = textureLod(uEnv, R, 3.5 + grain * 2.).rgb;
    vec3 col = base + env * fres * .22;
    vec3 dyn = vec3(0.);
    for(int i=0;i<MAX_LIGHTS;i++){
      vec4 L = uLights[i];
      if(L.w <= 0.) continue;
      vec3 lv = L.xyz - vWorld;
      float d2 = dot(lv, lv);
      if(d2 > 3600.) continue;
      vec3 l = lv * inversesqrt(d2);
      float ndl = max(dot(N, l), 0.);
      vec3 H = normalize(l + V);
      float spec = pow(max(dot(N, H), 0.), 90.) * 6.;
      dyn += uLightCols[i] * L.w * (ndl * .25 + spec) / (1. + d2 * .25);
    }
    col += dyn * (.6 + .6*seam);
    // planar reflection of the scene (wet, glossy plating)
    if(uReflOn > .5){
      vec4 rp = uReflMatrix * vec4(vWorld, 1.);
      vec2 ruv = rp.xy / rp.w;
      ruv += (vec2(vnoise(vec2(x * 1.3, s * .25)), vnoise(vec2(x * 1.3 + 7., s * .25))) - .5) * .012;
      float dcam = length(vWorld - uCamPos);
      float lod = 1. + grain * 1.5 + dcam * .006;
      vec3 refl = textureLod(uReflTex, ruv, lod).rgb;
      float edgeFade = smoothstep(0., .04, ruv.x) * smoothstep(1., .96, ruv.x) * smoothstep(0., .04, ruv.y) * smoothstep(1., .96, ruv.y);
      float planeK = smoothstep(.86, .975, dot(N, uReflNormal)) * smoothstep(14., 2., abs(dot(vWorld - uReflPoint, uReflNormal)));
      float wet = (.35 + .65 * fres) * mix(.55, 1., seam) * exp(-dcam * .0025) * planeK;
      col += refl * wet * edgeFade * .85 * uWet;
    }
    if(uWet > 1.01){
      // rain ripples: expanding rings in a cell grid
      vec2 rc = vec2(x, s) * .9;
      vec2 id = floor(rc);
      vec2 fr = fract(rc) - .5;
      float ph = fract(uTime * 1.3 + hash12(id));
      float ring = smoothstep(.05, .0, abs(length(fr + (hash22(id) - .5) * .5) - ph * .5)) * (1. - ph);
      col += vec3(.4, .5, .7) * ring * .06 * (uWet - 1.);
      col *= .9;
    }
    col = mix(col, bandCol, band * .9);
    col += lane * vec3(.15,.6,.9) * .7;
    col += edgeCol * edgeLine * 2.5;
    #ifdef GLASS
      // glass tube / pipe: translucent panels with glowing frame lines
      float frame = 1. - seam;
      float rim = pow(1. - abs(dot(N, V)), 3.);
      col += vec3(.15, .55, 1.) * (frame * 1.4 + rim * .5);
      col += vec3(1., .2, .7) * smoothstep(.06, .0, abs(fract(s / 44.) - .5) * 44. / 44.) * .0;
      float a = clamp(.16 + frame * .75 + lane * .8 + edgeLine * .8 + band * .6 + rim * .35, 0., 1.);
      col = applyFog(col, vWorld);
      gl_FragColor = vec4(col, a);
    #else
      col = applyFog(col, vWorld);
      gl_FragColor = vec4(col, 1.);
    #endif
  }`;

const slabFrag = /* glsl */ `
  ${fogParsGLSL}
  ${noiseGLSL}
  uniform samplerCube uEnv;
  varying vec2 vLat;  // x: 0 top..1 bottom along the side; y: s
  varying vec2 vExt;  // x: side (0 left,1 right,2 bottom)
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main(){
    float s = vLat.y;
    float v = vLat.x;
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCamPos - vWorld);
    vec3 col = vec3(.018,.02,.03);
    float seam = step(.04, fract(s/16.));
    col *= mix(.5, 1., seam);
    float fres = pow(1. - max(dot(N, V), 0.), 4.);
    col += textureLod(uEnv, reflect(-V, N), 4.).rgb * (.03 + .3*fres) * .4;
    if(vExt.x < 1.5){
      // running light strip along the side
      float strip = smoothstep(.12, .0, abs(v - .38));
      float chase = pow(fract(s / 60. - uTime * 1.6), 12.);
      vec3 sc = vExt.x < .5 ? vec3(.1,.7,1.) : vec3(1.,.15,.6);
      col += sc * strip * (1.2 + 5.*chase);
      // small beacon every 32m
      float bx = fract(s/32.);
      col += vec3(1.,.8,.4) * smoothstep(.03,.0,abs(bx-.5)*.4) * smoothstep(.2, .0, abs(v-.75)) * 3.;
    } else {
      // underside: grid of lights
      float g = smoothstep(.06,.0,abs(fract(s/8.)-.5)*.3) * smoothstep(.3,.0,abs(v-.5));
      col += vec3(.2,.5,1.) * g * 1.5;
    }
    col = applyFog(col, vWorld);
    gl_FragColor = vec4(col, 1.);
  }`;

const barrierVert = /* glsl */ `
  attribute vec2 aLat; // x: 0..1 height, y: s
  attribute float aSide;
  varying vec2 vLat;
  varying float vSide;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main(){
    vLat = aLat; vSide = aSide;
    vec4 w = modelMatrix * vec4(position, 1.);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const barrierFrag = /* glsl */ `
  ${fogParsGLSL}
  #define MAX_HITS ${MAX_HITS}
  uniform vec4 uHits[MAX_HITS];
  varying vec2 vLat;
  varying float vSide;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main(){
    float h = vLat.x, s = vLat.y;
    vec3 base = vSide < .5 ? vec3(.1,.55,1.) : vec3(1.,.2,.75);
    // hex cells
    vec2 p = vec2(s * .9, h * 2.4 * 1.1547);
    p.x += mod(floor(p.y), 2.) * .5;
    vec2 f = fract(p) - .5;
    float hx = max(abs(f.x), abs(f.y) * .9);
    float cell = smoothstep(.40, .47, hx);
    float top = exp(-(1. - h) * 18.) * 2.2 + exp(-h * 22.) * 1.2;
    float pulse = pow(fract(s / 90. + uTime * .9 * (vSide < .5 ? 1. : -1.)), 20.) * 1.5;
    float a = cell * .18 + top + pulse * (.3 + h);
    float flash = 0.;
    for(int i=0;i<MAX_HITS;i++){
      vec4 hi = uHits[i];
      float age = uTime - hi.w;
      if(age < 0. || age > 1.2) continue;
      float d = length(vWorld - hi.xyz);
      flash += exp(-d * .12) * (1. - age / 1.2) * (1. + 2.*cell) * 1.4;
      // ripple ring
      flash += smoothstep(2., 0., abs(d - age * 40.)) * (1. - age/1.2) * .8;
    }
    vec3 col = base * a + vec3(1., .95, .9) * flash;
    float fogK = 1.;
    // fade out with distance (additive, so fog -> fade)
    float dist = length(vWorld - uCamPos);
    col *= exp(-dist * uFogDensity * .8);
    gl_FragColor = vec4(col, 1.);
  }`;

const tunnelFrag = /* glsl */ `
  ${fogParsGLSL}
  ${noiseGLSL}
  uniform samplerCube uEnv;
  varying vec2 vLat; // x: angle 0..1 around arch, y: s
  varying vec2 vExt;
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main(){
    float a = vLat.x, s = vLat.y;
    vec3 col = vec3(.02,.022,.03);
    float panel = step(.03, fract(s/6.)) * step(.04, fract(a*14.));
    col *= mix(.4, 1., panel);
    // light rings every 24m
    float ring = smoothstep(.6, 0., abs(fract(s/24.) - .5) * 24.);
    vec3 rc = mix(vec3(1.,.2,.7), vec3(.2,.8,1.), step(.5, fract(s/48.)));
    col += rc * ring * 4.;
    // longitudinal strips at 3 angles
    for(int i=1;i<4;i++){
      float ang = float(i) / 4.;
      col += vec3(.9,.8,.6) * smoothstep(.006, .0, abs(a - ang)) * 1.5;
    }
    // scrolling ad panels
    float adZone = step(.12, a) * step(a, .22) + step(.78, a) * step(a, .88);
    float ad = step(.5, vnoise(vec2(s*.05 - uTime*.5, a*20.)));
    col += adZone * mix(vec3(.05,.2,.4), vec3(.6,.1,.4), ad) * .8;
    vec3 N = normalize(vNormal);
    vec3 V = normalize(uCamPos - vWorld);
    col += textureCube(uEnv, reflect(-V, N)).rgb * .05;
    col = applyFog(col, vWorld);
    gl_FragColor = vec4(col, 1.);
  }`;

const padFrag = /* glsl */ `
  ${fogParsGLSL}
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform float uKind; // 0 = dash plate, 1 = pit zone, 2 = jump plate
  varying vec2 vLat; // x: 0..1 across, y: 0..1 along
  varying vec2 vExt; // x: length m, y: width m
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main(){
    vec2 uv = vLat;
    vec3 col;
    float border = step(min(min(uv.x, 1.-uv.x) * vExt.y, min(uv.y, 1.-uv.y) * vExt.x), .45);
    if(uKind < .5){
      // bright chevrons racing forward
      float along = uv.y * vExt.x / 3.5;
      float chev = fract(along - abs(uv.x - .5) * 1.6 - uTime * 3.);
      float c = smoothstep(.0, .08, chev) * smoothstep(.6, .5, chev);
      col = mix(uColB, uColA * 9., c) + border * uColA * 8.;
    } else if(uKind < 1.5){
      // energy field: hex cells, scanning bands and plus signs
      float along = uv.y * vExt.x;
      vec2 hp = vec2(uv.x * vExt.y * .6, along * .6);
      hp.x += mod(floor(hp.y), 2.) * .5;
      vec2 hf = fract(hp) - .5;
      float hex = smoothstep(.36, .46, max(abs(hf.x), abs(hf.y) * .9));
      float band = pow(fract(along / 24. - uTime * .7), 6.);
      vec2 pc = vec2(uv.x * vExt.y, along);
      vec2 pcell = fract(pc / vec2(vExt.y, 16.)) - .5;
      float plus = (step(abs(pcell.x), .09) * step(abs(pcell.y), .28) + step(abs(pcell.y), .09) * step(abs(pcell.x), .28)) * step(.5, fract(along / 32.));
      col = uColA * (.9 + hex * 1.6 + band * 5.) + vec3(1.) * min(plus, 1.) * 4.;
      float edge = smoothstep(.12, .0, min(uv.x, 1.-uv.x));
      col += uColA * edge * 7.;
    } else {
      // jump plate: rising arrows + pulsing rings
      vec2 q = vec2((uv.x - .5) * vExt.y, (uv.y - .5) * vExt.x);
      float r = length(q);
      float rings = pow(fract(r * .25 - uTime * 1.6), 5.);
      float arrow = fract(uv.y * vExt.x / 4. - abs(uv.x - .5) * 1.2 - uTime * 2.);
      float ar = smoothstep(.0, .08, arrow) * smoothstep(.45, .35, arrow);
      col = uColB + uColA * (ar * 7. + rings * 4.) + border * uColA * 8.;
    }
    // glow through the fog rather than being swallowed by it
    col *= exp(-length(vWorld - uCamPos) * uFogDensity * .35);
    gl_FragColor = vec4(col, 1.);
  }`;

const volumeFrag = /* glsl */ `
  uniform float uTime; uniform vec3 uCamPos; uniform float uFogDensity;
  uniform vec3 uColA;
  varying vec2 vUv; varying vec3 vWorld;
  void main(){
    float v = vUv.y;
    float fade = pow(1. - v, 1.8);
    float rise = pow(fract(v * 2. - uTime * 1.2 + vUv.x * .02), 10.);
    float lines = smoothstep(.9, 1., fract(vUv.x * .5)) * .6;
    vec3 col = uColA * fade * (.5 + rise * 2. + lines);
    col *= exp(-length(vWorld - uCamPos) * uFogDensity * .35);
    gl_FragColor = vec4(col, 1.);
  }`;

/** Additive light walls around a pad / zone (visible from far away) */
function buildVolume(path: Path, s0: number, s1: number, x0: number, x1: number, H: number, sides: ('l' | 'r' | 'f' | 'b')[]) {
  const pos: number[] = [],
    uvs: number[] = [];
  const idx: number[] = [];
  const P = new THREE.Vector3(),
    N = new THREE.Vector3();
  const wall = (pts: [number, number][]) => {
    let dist = 0;
    for (let i = 0; i < pts.length; i++) {
      const [s, x] = pts[i];
      if (i > 0) dist += Math.hypot(s - pts[i - 1][0], x - pts[i - 1][1]);
      const vi = pos.length / 3;
      path.surf(s, x, 0.1, P, N);
      pos.push(P.x, P.y, P.z);
      path.surf(s, x, H, P, N);
      pos.push(P.x, P.y, P.z);
      uvs.push(dist, 0, dist, 1);
      if (i > 0) idx.push(vi - 2, vi, vi - 1, vi - 1, vi, vi + 1);
    }
  };
  const along = (x: number) => {
    const pts: [number, number][] = [];
    for (let s = s0; s <= s1 + 0.01; s += Math.max(1, (s1 - s0) / 60)) pts.push([s, x]);
    return pts;
  };
  const across = (s: number): [number, number][] => [
    [s, x0],
    [s, x1],
  ];
  if (sides.includes('l')) wall(along(x0));
  if (sides.includes('r')) wall(along(x1));
  if (sides.includes('f')) wall(across(s0));
  if (sides.includes('b')) wall(across(s1));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export interface TrackMeshes {
  group: THREE.Group;
  roadMaterial: THREE.ShaderMaterial;
}

export function buildTrackMeshes(track: Track): TrackMeshes {
  const group = new THREE.Group();
  const roadMat = new THREE.ShaderMaterial({
    uniforms: {
      ...globalUniforms,
      ...lightUniforms,
      ...reflectionUniforms,
      uEdgeColA: { value: new THREE.Color(0.2, 0.8, 1.8) },
      uEdgeColB: { value: new THREE.Color(1.8, 0.25, 1.1) },
    },
    vertexShader: roadVert,
    fragmentShader: roadFrag,
    side: THREE.DoubleSide,
  });
  const slabMat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms, uEnv: lightUniforms.uEnv },
    vertexShader: roadVert,
    fragmentShader: slabFrag,
    side: THREE.DoubleSide,
  });
  const barrierMat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms, ...barrierUniforms },
    vertexShader: barrierVert,
    fragmentShader: barrierFrag,
    side: THREE.DoubleSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const tunnelMat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms, uEnv: lightUniforms.uEnv },
    vertexShader: roadVert,
    fragmentShader: tunnelFrag,
    side: THREE.DoubleSide,
  });

  const glassMat = new THREE.ShaderMaterial({
    uniforms: roadMat.uniforms,
    vertexShader: roadVert,
    fragmentShader: roadFrag,
    side: THREE.DoubleSide,
    defines: { GLASS: 1 },
    transparent: true,
    depthWrite: false,
  });
  const ribMat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms },
    vertexShader: `varying vec2 vUv; varying vec3 vWorld; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `${fogParsGLSL}
      varying vec2 vUv; varying vec3 vWorld;
      void main(){
        float chase = pow(fract(vUv.x * 2. - uTime * .8), 8.);
        vec3 col = mix(vec3(.2,.9,2.4), vec3(2.4,.3,1.6), step(.5, fract(vUv.x * 4.))) * (1. + chase * 3.);
        col *= smoothstep(0., .25, vUv.y) * smoothstep(1., .75, vUv.y) + .3;
        gl_FragColor = vec4(applyFog(col, vWorld), 1.);
      }`,
    side: THREE.DoubleSide,
  });
  for (const path of track.paths) {
    const rg = buildRoad(path);
    const road = new THREE.Mesh(rg.opaque, roadMat);
    road.layers.set(ROAD_LAYER);
    group.add(road);
    if (rg.glass) {
      const gm = new THREE.Mesh(rg.glass, glassMat);
      gm.renderOrder = 7;
      gm.layers.set(ROAD_LAYER);
      gm.layers.set(ROAD_LAYER);
      group.add(gm);
      const ribs = buildRibs(path);
      if (ribs) group.add(new THREE.Mesh(ribs, ribMat));
    }
    group.add(new THREE.Mesh(buildSlab(path), slabMat));
    group.add(new THREE.Mesh(buildBarriers(path, track), barrierMat));
    const tg = buildTunnel(path);
    if (tg) group.add(new THREE.Mesh(tg, tunnelMat));
  }
  // pads & pit: bright plates plus additive light walls so they read from far away
  const plateMat = (kind: number, a: THREE.Color, b: THREE.Color) =>
    new THREE.ShaderMaterial({
      uniforms: { ...globalUniforms, uColA: { value: a }, uColB: { value: b }, uKind: { value: kind } },
      vertexShader: roadVert,
      fragmentShader: padFrag,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  const volMat = (c: THREE.Color) =>
    new THREE.ShaderMaterial({
      uniforms: { ...globalUniforms, uColA: { value: c } },
      vertexShader: `varying vec2 vUv; varying vec3 vWorld; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: volumeFrag,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
  const DASH = new THREE.Color(1.0, 0.55, 0.08),
    JUMP = new THREE.Color(0.2, 1.0, 0.75),
    PIT = new THREE.Color(1.0, 0.12, 0.6);
  for (const kind of ['dash', 'jump'] as const) {
    const pads = track.boostPads.filter((p) => p.kind === kind);
    if (!pads.length) continue;
    const col = kind === 'dash' ? DASH : JUMP;
    const plates = new THREE.Mesh(
      mergeGeos(pads.map((pad) => buildPatch(track.paths[pad.path], pad.s0, pad.s1, pad.x0, pad.x1))),
      plateMat(kind === 'dash' ? 0 : 2, col, col.clone().multiplyScalar(0.25)),
    );
    plates.layers.set(ROAD_LAYER);
    group.add(plates);
    const vols = mergeVol(pads.map((pad) => buildVolume(track.paths[pad.path], pad.s0, pad.s1, pad.x0, pad.x1, kind === 'jump' ? 9 : 6, ['l', 'r', 'f'])));
    const vm = new THREE.Mesh(vols, volMat(col.clone().multiplyScalar(kind === 'jump' ? 1.2 : 1.2)));
    vm.renderOrder = 6;
    group.add(vm);
  }
  for (const z of track.pitZones) {
    const pit = new THREE.Mesh(buildPatch(track.paths[z.path], z.s0, z.s1, z.x0, z.x1), plateMat(1, PIT, PIT.clone().multiplyScalar(0.2)));
    pit.layers.set(ROAD_LAYER);
    group.add(pit);
    const curtain = new THREE.Mesh(buildVolume(track.paths[z.path], z.s0, z.s1, z.x0, z.x1, 7, ['l', 'f', 'b']), volMat(PIT.clone().multiplyScalar(0.9)));
    curtain.renderOrder = 6;
    group.add(curtain);
  }

  // start line: checker patch
  const startMat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms },
    vertexShader: roadVert,
    fragmentShader: /* glsl */ `
      ${fogParsGLSL}
      varying vec2 vLat; varying vec2 vExt; varying vec3 vWorld;
      void main(){
        vec2 c = floor(vec2(vLat.x * vExt.y / 1.6, vLat.y * vExt.x / 1.6));
        float ch = mod(c.x + c.y, 2.);
        vec3 col = mix(vec3(.02), vec3(1.4), ch);
        gl_FragColor = vec4(applyFog(col, vWorld), 1.);
      }`,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const startMesh = new THREE.Mesh(buildPatch(track.main, track.startS - 3.2, track.startS + 3.2, -HALF_W + 0.6, HALF_W - 0.6), startMat);
  startMesh.layers.set(ROAD_LAYER);
  group.add(startMesh);

  group.add(buildSupports(track));
  return { group, roadMaterial: roadMat };
}

function mergeVol(geos: THREE.BufferGeometry[]) {
  return mergeGeos(geos);
}
function mergeGeos(geos: THREE.BufferGeometry[]) {
  // simple merge of non-indexed or indexed geometries with identical attributes
  const names = Object.keys(geos[0].attributes);
  const out = new THREE.BufferGeometry();
  let vcount = 0;
  const idx: number[] = [];
  for (const g of geos) {
    const ind = g.index!;
    for (let i = 0; i < ind.count; i++) idx.push(ind.getX(i) + vcount);
    vcount += g.attributes.position.count;
  }
  for (const n of names) {
    const size = geos[0].attributes[n].itemSize;
    const arr = new Float32Array(vcount * size);
    let off = 0;
    for (const g of geos) {
      arr.set(g.attributes[n].array as Float32Array, off);
      off += g.attributes[n].array.length;
    }
    out.setAttribute(n, new THREE.BufferAttribute(arr, size));
  }
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

/** Road top surface (curl aware). Returns separate index sets for opaque and glass sections. */
function buildRoad(path: Path) {
  const COLS = 24;
  const R = ringCount(path);
  const pos = new Float32Array(R * (COLS + 1) * 3);
  const nor = new Float32Array(R * (COLS + 1) * 3);
  const lat = new Float32Array(R * (COLS + 1) * 2);
  const ext = new Float32Array(R * (COLS + 1) * 2);
  const crl = new Float32Array(R * (COLS + 1));
  const opaque: number[] = [];
  const glass: number[] = [];
  const P = new THREE.Vector3(),
    N = new THREE.Vector3();
  for (let k = 0; k < R; k++) {
    const i = ringIndex(path, k);
    const s = i * path.ds;
    const sk = k * STEP * path.ds;
    const L = path.leftExt[i],
      Rr = path.rightExt[i];
    for (let c = 0; c <= COLS; c++) {
      const x = -L + ((L + Rr) * c) / COLS;
      const v = k * (COLS + 1) + c;
      path.surf(s, x, 0, P, N);
      pos.set([P.x, P.y, P.z], v * 3);
      nor.set([N.x, N.y, N.z], v * 3);
      lat[v * 2] = x;
      lat[v * 2 + 1] = sk;
      ext[v * 2] = L;
      ext[v * 2 + 1] = Rr;
      crl[v] = path.curl[i];
    }
    if (k > 0) {
      const iPrev = ringIndex(path, k - 1);
      if (path.flags[i] & F_GAP || path.flags[iPrev] & F_GAP) continue;
      const isGlass = Math.max(Math.abs(path.curl[i]), Math.abs(path.curl[iPrev])) > GLASS_CURL;
      const list = isGlass ? glass : opaque;
      for (let c = 0; c < COLS; c++) {
        const a = (k - 1) * (COLS + 1) + c;
        const b = k * (COLS + 1) + c;
        list.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const make = (idx: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aLat', new THREE.BufferAttribute(lat, 2));
    g.setAttribute('aExt', new THREE.BufferAttribute(ext, 2));
    g.setAttribute('aCurl', new THREE.BufferAttribute(crl, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  };
  return { opaque: make(opaque), glass: glass.length ? make(glass) : null };
}

/** Thick underside with side faces (opaque sections only), following the curled cross-section */
function buildSlab(path: Path) {
  const R = ringCount(path);
  const COLS = 12;
  const DEPTH = 2.6;
  const INSET = 1.6;
  const per = COLS + 1 + 4; // bottom row + 2 verts per side face
  const pos = new Float32Array(R * per * 3);
  const nor = new Float32Array(R * per * 3);
  const lat = new Float32Array(R * per * 2);
  const ext = new Float32Array(R * per * 2);
  const idx: number[] = [];
  const P = new THREE.Vector3(),
    N = new THREE.Vector3(),
    T = new THREE.Vector3(),
    q = new THREE.Vector3();
  for (let k = 0; k < R; k++) {
    const i = ringIndex(path, k);
    const s = i * path.ds;
    const sk = k * STEP * path.ds;
    const L = path.leftExt[i],
      Rr = path.rightExt[i];
    const base = k * per;
    const set = (v: number, p: THREE.Vector3, nn: THREE.Vector3, lx: number, side: number) => {
      pos.set([p.x, p.y, p.z], (base + v) * 3);
      nor.set([nn.x, nn.y, nn.z], (base + v) * 3);
      lat.set([lx, sk], (base + v) * 2);
      ext.set([side, 0], (base + v) * 2);
    };
    // bottom row (offset opposite to the surface normal, slightly inset)
    for (let c = 0; c <= COLS; c++) {
      const x = -L + INSET + ((L + Rr - INSET * 2) * c) / COLS;
      path.surf(s, x, -DEPTH, P, N);
      set(c, P, q.copy(N).negate(), c / COLS, 2);
    }
    // side faces: top edge (surface) -> bottom edge
    for (const [o, sx, side] of [
      [COLS + 1, -L, 0],
      [COLS + 3, Rr, 1],
    ] as [number, number, number][]) {
      path.surf(s, sx, 0, P, N, T);
      const outward = side === 0 ? -1 : 1;
      const nn = q.copy(T).multiplyScalar(outward).addScaledVector(N, -0.3).normalize();
      set(o, P, nn, 0, side);
      const bx = side === 0 ? -L + INSET : Rr - INSET;
      path.surf(s, bx, -DEPTH, P, N);
      set(o + 1, P, nn, 1, side);
    }
    if (k > 0) {
      const iPrev = ringIndex(path, k - 1);
      if (path.flags[i] & F_GAP || path.flags[iPrev] & F_GAP) continue;
      if (Math.max(Math.abs(path.curl[i]), Math.abs(path.curl[iPrev])) > GLASS_CURL) continue;
      const a = (k - 1) * per,
        b = k * per;
      for (let c = 0; c < COLS; c++) idx.push(a + c, b + c, a + c + 1, a + c + 1, b + c, b + c + 1);
      for (const o of [COLS + 1, COLS + 3]) idx.push(a + o, b + o, a + o + 1, a + o + 1, b + o, b + o + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aLat', new THREE.BufferAttribute(lat, 2));
  g.setAttribute('aExt', new THREE.BufferAttribute(ext, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Energy barriers at both edges (following the curled cross-section; none on closed tubes) */
function buildBarriers(path: Path, track: Track) {
  void track;
  const R = ringCount(path);
  const H = 2.8;
  const pos: number[] = [],
    nor: number[] = [],
    lat: number[] = [],
    side: number[] = [];
  const idx: number[] = [];
  const P = new THREE.Vector3(),
    N = new THREE.Vector3(),
    T = new THREE.Vector3();
  for (const sd of [0, 1]) {
    const flag = sd === 0 ? F_NORAIL_L : F_NORAIL_R;
    let prevOk = false;
    for (let k = 0; k < R; k++) {
      const i = ringIndex(path, k);
      const s = i * path.ds;
      const sk = k * STEP * path.ds;
      const ok = !(path.flags[i] & flag) && Math.abs(path.curl[i]) < WRAP_CURL;
      if (k > 0) {
        const ip = ringIndex(path, k - 1);
        const e0 = sd === 0 ? path.leftExt[ip] : path.rightExt[ip];
        const e1 = sd === 0 ? path.leftExt[i] : path.rightExt[i];
        if (Math.abs(e0 - e1) > 3) prevOk = false; // abrupt split: open the barrier
      }
      const x = sd === 0 ? -path.leftExt[i] : path.rightExt[i];
      const outward = sd === 0 ? -1 : 1;
      path.surf(s, x, 0, P, N, T);
      const topP = P.clone().addScaledVector(N, H).addScaledVector(T, outward * 0.4);
      const vi = pos.length / 3;
      pos.push(P.x, P.y, P.z, topP.x, topP.y, topP.z);
      const nn = T.clone().multiplyScalar(-outward);
      nor.push(nn.x, nn.y, nn.z, nn.x, nn.y, nn.z);
      lat.push(0, sk, 1, sk);
      side.push(sd, sd);
      if (k > 0 && ok && prevOk) idx.push(vi - 2, vi, vi - 1, vi - 1, vi, vi + 1);
      prevOk = ok;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aLat', new THREE.Float32BufferAttribute(lat, 2));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Glowing structural ribs around glass tubes and pipes */
function buildRibs(path: Path) {
  const pos: number[] = [],
    uvs: number[] = [];
  const idx: number[] = [];
  const P = new THREE.Vector3(),
    N = new THREE.Vector3(),
    P2 = new THREE.Vector3(),
    N2 = new THREE.Vector3();
  const COLS = 48;
  for (let s = 0; s < path.length; s += 22) {
    const c = Math.abs(path.curlAt(s));
    if (c < GLASS_CURL) continue;
    const [L, R] = path.ext(s);
    const vi = pos.length / 3;
    for (let k = 0; k <= COLS; k++) {
      const x = -L + ((L + R) * k) / COLS;
      path.surf(s, x, -0.35, P, N);
      path.surf(s + 1.6, x, -0.35, P2, N2);
      pos.push(P.x, P.y, P.z, P2.x, P2.y, P2.z);
      uvs.push(k / COLS, 0, k / COLS, 1);
      if (k > 0) idx.push(vi + (k - 1) * 2, vi + k * 2, vi + (k - 1) * 2 + 1, vi + (k - 1) * 2 + 1, vi + k * 2, vi + k * 2 + 1);
    }
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

function buildTunnel(path: Path) {
  const R = ringCount(path);
  const SEG = 24;
  const pos: number[] = [],
    nor: number[] = [],
    lat: number[] = [],
    ext: number[] = [];
  const idx: number[] = [];
  const P = new THREE.Vector3(),
    U = new THREE.Vector3(),
    Rv = new THREE.Vector3();
  let prev = -1;
  for (let k = 0; k < R; k++) {
    const i = ringIndex(path, k);
    const s = k * STEP * path.ds;
    // include a few rings of margin so the tunnel mouth isn't abrupt
    if (!(path.flags[i] & F_TUNNEL)) {
      prev = -1;
      continue;
    }
    P.fromArray(path.pos, i * 3);
    U.fromArray(path.up, i * 3);
    Rv.fromArray(path.right, i * 3);
    const rad = HALF_W + 4;
    const vi = pos.length / 3;
    for (let a = 0; a <= SEG; a++) {
      const ang = (a / SEG) * Math.PI;
      const cx = -Math.cos(ang) * rad;
      const cy = Math.sin(ang) * rad * 0.62 - 1.5;
      const p = P.clone().addScaledVector(Rv, cx).addScaledVector(U, cy);
      pos.push(p.x, p.y, p.z);
      const nn = Rv.clone().multiplyScalar(Math.cos(ang)).addScaledVector(U, -Math.sin(ang)).normalize();
      nor.push(nn.x, nn.y, nn.z);
      lat.push(a / SEG, s);
      ext.push(0, 0);
    }
    if (prev >= 0) {
      for (let a = 0; a < SEG; a++) idx.push(prev + a, vi + a, prev + a + 1, prev + a + 1, vi + a, vi + a + 1);
    }
    prev = vi;
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aLat', new THREE.Float32BufferAttribute(lat, 2));
  g.setAttribute('aExt', new THREE.Float32BufferAttribute(ext, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** A patch lying on the road surface (boost pad / pit zone). aLat = normalized uv, aExt = size */
export function buildPatch(path: Path, s0: number, s1: number, x0: number, x1: number, lift = 0.05) {
  const n = Math.max(2, Math.ceil((s1 - s0) / 1.0));
  const C = 6;
  const pos: number[] = [],
    nor: number[] = [],
    lat: number[] = [],
    ext: number[] = [];
  const idx: number[] = [];
  const P = new THREE.Vector3(),
    N = new THREE.Vector3();
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    for (let c = 0; c <= C; c++) {
      const x = x0 + ((x1 - x0) * c) / C;
      path.surf(s, x, lift, P, N);
      pos.push(P.x, P.y, P.z);
      nor.push(N.x, N.y, N.z);
      lat.push(c / C, k / n);
      ext.push(s1 - s0, x1 - x0);
      if (k > 0 && c > 0) {
        const a = (k - 1) * (C + 1) + c - 1,
          b = k * (C + 1) + c - 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aLat', new THREE.Float32BufferAttribute(lat, 2));
  g.setAttribute('aExt', new THREE.Float32BufferAttribute(ext, 2));
  g.setIndex(idx);
  return g;
}

/** Support pylons from the underside of the course down to the ground */
function buildSupports(track: Track) {
  const geo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
  geo.translate(0, 0.5, 0);
  const aH = [];
  const mats: THREE.Matrix4[] = [];
  const allPts: THREE.Vector3[] = [];
  for (const p of track.paths) for (let i = 0; i < p.n; i += 6) allPts.push(new THREE.Vector3().fromArray(p.pos, i * 3));
  for (const p of track.paths) {
    for (let s = 40; s < p.length - 20; s += 110) {
      const [i] = p.idx(s);
      if (p.flags[i] & (F_NOSUPPORT | F_LOOP | F_GAP)) continue;
      const u = new THREE.Vector3().fromArray(p.up, i * 3);
      if (u.y < 0.85) continue;
      const P = new THREE.Vector3().fromArray(p.pos, i * 3).addScaledVector(u, -2.6);
      if (P.y < 8) continue;
      // anything underneath?
      let blocked = false;
      for (const q of allPts) {
        if (q.y < P.y - 8 && Math.hypot(q.x - P.x, q.z - P.z) < HALF_W + 10) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      for (const side of [-1, 1]) {
        const r = new THREE.Vector3().fromArray(p.right, i * 3);
        const base = P.clone().addScaledVector(r, side * (HALF_W - 7));
        const m = new THREE.Matrix4().compose(
          new THREE.Vector3(base.x, 0, base.z),
          new THREE.Quaternion(),
          new THREE.Vector3(2.2, base.y, 2.2),
        );
        mats.push(m);
        aH.push(base.y);
      }
    }
  }
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms, uEnv: lightUniforms.uEnv },
    vertexShader: /* glsl */ `
      attribute float aH;
      varying vec3 vWorld; varying vec3 vN; varying float vY; varying float vH;
      void main(){
        vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.);
        vWorld = w.xyz; vY = w.y; vH = aH;
        vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${fogParsGLSL}
      uniform samplerCube uEnv;
      varying vec3 vWorld; varying vec3 vN; varying float vY; varying float vH;
      void main(){
        vec3 N = normalize(vN);
        vec3 V = normalize(uCamPos - vWorld);
        vec3 col = vec3(.02,.022,.03) + textureCube(uEnv, reflect(-V,N)).rgb * .12;
        float ring = smoothstep(.5, 0., abs(fract(vY / 14. - uTime*.15) - .5) * 14.);
        col += vec3(.2,.6,1.) * ring * 1.5;
        col += vec3(1.,.3,.7) * smoothstep(3., 0., vH - vY) * 1.5;
        gl_FragColor = vec4(applyFog(col, vWorld), 1.);
      }`,
  });
  const inst = new THREE.InstancedMesh(geo, mat, Math.max(1, mats.length));
  mats.forEach((m, i) => inst.setMatrixAt(i, m));
  inst.count = mats.length;
  geo.setAttribute('aH', new THREE.InstancedBufferAttribute(new Float32Array(aH.length ? aH : [0]), 1));
  inst.frustumCulled = false;
  return inst;
}
