import * as THREE from 'three';
import { Track, HALF_W, District } from '../track/Track';
import { fogParsGLSL, globalUniforms, noiseGLSL } from '../shaders/common';
import { lightUniforms } from '../track/TrackMesh';
import { mulberry32, rrange, RNG } from '../core/util';
import { StaticGlows } from '../fx/Glows';

const BLOCK = 150;
const STREET = 34;
export const DISTRICT_ID: Record<District, number> = { downtown: 0, core: 1, port: 2, kyoto: 3, arcology: 4, fire: 5 };

/**
 * Spatial lookup of the full road cross-sections (edges, centre, curled / rolled parts),
 * used to keep every structure clear of the course.
 */
export class TrackGrid {
  cell = 50;
  map = new Map<number, number[]>(); // flat [x,y,z,...]
  coarse: { x: number; z: number; prog: number }[] = [];
  constructor(track: Track) {
    const P = new THREE.Vector3(),
      N = new THREE.Vector3();
    for (const p of track.paths) {
      for (let s = 0; s < p.length; s += 3) {
        const [L, R] = p.ext(s);
        for (const fx of [-1, -0.5, 0, 0.5, 1]) {
          const x = fx < 0 ? fx * L : fx * R;
          for (const h of [-3, 4]) {
            p.surf(s, x, h, P, N);
            this.add(P.x, P.y, P.z);
          }
        }
      }
      for (let s = 0; s < p.length; s += 40) {
        const i = Math.floor(s / p.ds);
        this.coarse.push({ x: p.pos[i * 3], z: p.pos[i * 3 + 2], prog: track.progress(p.index, s) });
      }
    }
  }
  private key(cx: number, cz: number) {
    return (cx + 5000) * 10007 + (cz + 5000);
  }
  private add(x: number, y: number, z: number) {
    const k = this.key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let a = this.map.get(k);
    if (!a) this.map.set(k, (a = []));
    a.push(x, y, z);
  }
  /** min course height within radius r of (x,z), or Infinity */
  minYNear(x: number, z: number, r: number) {
    let minY = Infinity;
    const c = this.cell;
    const n = Math.ceil(r / c);
    const cx = Math.floor(x / c),
      cz = Math.floor(z / c);
    for (let i = -n; i <= n; i++)
      for (let j = -n; j <= n; j++) {
        const a = this.map.get(this.key(cx + i, cz + j));
        if (!a) continue;
        for (let k = 0; k < a.length; k += 3) {
          const dx = a[k] - x,
            dz = a[k + 2] - z;
          if (dx * dx + dz * dz < r * r && a[k + 1] < minY) minY = a[k + 1];
        }
      }
    return minY;
  }
  nearest(x: number, z: number) {
    let best = Infinity,
      prog = 0;
    for (const c of this.coarse) {
      const d = (c.x - x) ** 2 + (c.z - z) ** 2;
      if (d < best) {
        best = d;
        prog = c.prog;
      }
    }
    return { dist: Math.sqrt(best), prog };
  }
}

// --------------------------------------------------------------------------- building shader
const buildingVert = /* glsl */ `
  attribute vec4 iInfo; // seed, style, litRatio, palette
  attribute vec2 iInfo2; // district, kind
  varying vec3 vLocal;
  varying vec3 vSize;
  varying vec3 vN;
  varying vec3 vWorld;
  varying vec4 vInfo;
  varying vec2 vInfo2;
  void main(){
    vec3 size = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    vSize = size;
    vLocal = position * size;
    vN = normal;
    vInfo = iInfo;
    vInfo2 = iInfo2;
    vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

const buildingFrag = /* glsl */ `
  ${fogParsGLSL}
  ${noiseGLSL}
  uniform samplerCube uEnv;
  varying vec3 vLocal;
  varying vec3 vSize;
  varying vec3 vN;
  varying vec3 vWorld;
  varying vec4 vInfo;
  varying vec2 vInfo2;
  vec3 palette(float p, float h, float dist){
    if(dist > 2.5 && dist < 3.5){ // kyoto: lantern warm
      if(p < .6) return mix(vec3(1.,.45,.15), vec3(1.,.62,.3), h);
      if(p < .85) return mix(vec3(1.,.2,.25), vec3(1.,.35,.4), h);
      return vec3(1.,.75,.5);
    }
    if(dist > 3.5 && dist < 4.5){ // arcology: clean white / cyan
      return mix(vec3(.7,.95,1.), vec3(.4,.8,1.), h * p);
    }
    if(dist > 4.5){ // fire field: sodium orange
      return mix(vec3(1.,.4,.08), vec3(1.,.6,.2), h);
    }
    if(p < .45) return mix(vec3(1.,.72,.42), vec3(1.,.85,.6), h);
    if(p < .75) return mix(vec3(.55,.8,1.), vec3(.8,.9,1.), h);
    if(p < .88) return mix(vec3(1.,.35,.75), vec3(.8,.4,1.), h);
    return mix(vec3(.3,1.,.85), vec3(.5,.9,1.), h);
  }
  void main(){
    float seed = vInfo.x, style = vInfo.y, litRatio = vInfo.z, pal = vInfo.w;
    float dist = vInfo2.x, kind = vInfo2.y;
    vec3 N = normalize(vN);
    vec3 V = normalize(uCamPos - vWorld);
    vec3 col;
    #ifdef ROUND
      float roof = step(.7, N.y);
    #else
      float roof = step(.5, abs(N.y));
    #endif
    if(kind > .5 && kind < 1.5){
      // shipping container / cargo: saturated paint with corrugation
      vec3 c = palette(pal, .5, 0.) * .12 + vec3(hash11(seed), hash11(seed + 1.), hash11(seed + 2.)) * .05;
      float rib = .7 + .3 * step(.5, fract((vLocal.x + vLocal.z) * 2.5));
      col = c * rib;
      col += palette(pal, .5, 0.) * step(.97, fract(vLocal.y / vSize.y)) * .6;
    } else if(kind > 1.5 && kind < 2.5){
      // pure emissive structure (torii, crane lights, roof trims)
      col = palette(pal, .5, dist) * (1.5 + .5 * sin(uTime * 2. + seed));
    } else if(roof > .5){
      col = vec3(.015,.016,.022);
      vec2 rp = vLocal.xz;
      float grid = step(.92, fract(rp.x/6.)) + step(.92, fract(rp.y/6.));
      col += grid * .01;
      #ifndef ROUND
      float edge = min(vSize.x*.5 - abs(rp.x), vSize.z*.5 - abs(rp.y));
      col += palette(pal, .5, dist) * smoothstep(1., 0., edge) * .8 * step(.5, hash11(seed*3.1));
      #endif
    } else {
      #ifdef ROUND
        float ang = atan(vLocal.z / max(vSize.z, .01), vLocal.x / max(vSize.x, .01));
        float hc = ang * vSize.x * .5;
        float faceW = 3.14159 * vSize.x;
        float faceId = 1.;
      #else
        float hc = abs(N.x) > .5 ? vLocal.z * sign(N.x) : -vLocal.x * sign(N.z);
        float faceW = abs(N.x) > .5 ? vSize.z : vSize.x;
        float faceId = abs(N.x) > .5 ? (N.x > 0. ? 1. : 2.) : (N.z > 0. ? 3. : 4.);
      #endif
      float y = vLocal.y;
      float floorH = style < .5 ? 3.6 : 4.2;
      float winW = mix(2.2, 3.6, hash11(seed*7.3));
      if(dist > 2.5 && dist < 3.5){ floorH = 3.2; winW = 1.6; }
      if(dist > 4.5){ floorH = 6.; winW = 6.; }
      vec2 cc = vec2((hc + faceW*.5) / winW, y / floorH);
      vec2 cell = floor(cc);
      vec2 f = fract(cc);
      float win;
      if(dist > 2.5 && dist < 3.5){
        // shoji screens: small lit panes with a lattice
        win = step(.08, f.x) * step(f.x, .92) * step(.15, f.y) * step(f.y, .8) * (1. - step(.47, abs(fract(f.x * 2.) - .5)) * .7);
      } else if(style < .33){
        win = step(.14, f.x) * step(f.x, .86) * step(.22, f.y) * step(f.y, .82);
      } else if(style < .66){
        win = step(.25, f.y) * step(f.y, .8);
        cell.x = floor(cell.x / 4.);
      } else {
        win = step(.35, f.x) * step(f.x, .65) * step(.1, f.y);
      }
      if(dist > 4.5) win *= step(.35, f.x) * step(f.x, .65) * step(.4, f.y) * step(f.y, .6);
      float h = hash12(cell + seed * 13.7 + faceId * 31.);
      float lit = step(1. - litRatio, h);
      lit *= step(.25, hash12(vec2(cell.y, seed*3. + faceId)));
      float flick = 1. - step(.995, hash12(cell + floor(uTime*3.))) * .8;
      vec3 wc = palette(pal, hash12(cell + 7.), dist) * (.15 + .75 * pow(hash12(cell*1.7 + seed), 2.)) * flick;
      float fw = max(fwidth(cc.x), fwidth(cc.y));
      float detail = clamp(1.5 - fw * 2.5, 0., 1.);
      float avg = litRatio * .12;
      vec3 facade = vec3(.012,.014,.02) * (0.8 + .4*hash11(seed));
      if(dist > 2.5 && dist < 3.5) facade = vec3(.03, .012, .01);
      if(dist > 3.5 && dist < 4.5) facade = vec3(.05, .06, .075);
      if(dist > 4.5) facade = vec3(.03, .02, .015) * (.7 + .6 * vnoise(vLocal.xy * .1 + seed));
      vec3 R = reflect(-V, N);
      float fres = .06 + .94 * pow(1. - max(dot(N, V), 0.), 5.);
      vec3 glass = textureLod(uEnv, R, 2.).rgb * fres * (dist > 3.5 && dist < 4.5 ? .7 : .25);
      vec3 winCol = mix(glass + vec3(.006,.007,.012), wc, lit);
      col = mix(facade + glass*.2, winCol, win);
      col = mix(facade + palette(pal,.5,dist) * avg + glass*.3, col, detail);
      float edgeD = faceW * .5 - abs(hc);
      #ifndef ROUND
      if(hash11(seed*5.7) > .55 && dist < 2.5){
        vec3 nc = hash11(seed*9.1) > .5 ? vec3(.2,.7,1.) : vec3(1.,.2,.7);
        col += nc * smoothstep(.6, 0., edgeD) * 2.2;
      }
      if(dist > 3.5 && dist < 4.5) col += vec3(.5,.9,1.2) * smoothstep(.8, 0., edgeD) * 1.5;
      #endif
      float top = vSize.y - y;
      if(hash11(seed*2.3) > .4){
        vec3 cc2 = palette(fract(pal + .37), .5, dist);
        col += cc2 * smoothstep(1.2, .2, abs(top - 3.)) * 2.5;
        col += cc2 * step(.93, fract(hc/8. - uTime*.5)) * smoothstep(8., 6., top) * step(top, 6.) * 1.5;
      }
      if(style > .5 && hash11(seed*11.) > .6) col += palette(fract(pal+.6), .3, dist) * step(.96, fract(y / 40.)) * 1.2;
      // industrial: hazard stripes at the base, rust
      if(dist > 4.5) col += vec3(.9,.5,.05) * step(y, 3.) * step(.5, fract((hc + y) / 2.)) * .4;
      col += vec3(1.,.5,.2) * exp(-y * .15) * .15;
    }
    col = applyFog(col, vWorld);
    gl_FragColor = vec4(col, 1.);
  }`;

export interface CityBuild {
  group: THREE.Group;
  glows: StaticGlows;
  hologramSpots: { pos: THREE.Vector3; normal: THREE.Vector3; w: number; h: number; district: District }[];
  roofSpots: THREE.Vector3[];
  grid: TrackGrid;
}

type Batch = { mats: THREE.Matrix4[]; info: number[]; info2: number[] };
const newBatch = (): Batch => ({ mats: [], info: [], info2: [] });

export function buildCity(track: Track, glows: StaticGlows): CityBuild {
  const grid = new TrackGrid(track);
  const group = new THREE.Group();
  const boxes = newBatch(),
    cyls = newBatch(),
    pyrs = newBatch();
  const hologramSpots: CityBuild['hologramSpots'] = [];
  const roofSpots: THREE.Vector3[] = [];
  const tower = track.towers[0];
  const q0 = new THREE.Quaternion();
  const put = (b: Batch, x: number, y0: number, z: number, w: number, h: number, d: number, info: number[], dist: number, kind = 0, rotY = 0) => {
    const q = rotY ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY) : q0;
    b.mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y0, z), q, new THREE.Vector3(w, h, d)));
    b.info.push(...info);
    b.info2.push(dist, kind);
  };
  const beacon = new THREE.Color(3, 0.1, 0.05);
  const lantern = new THREE.Color(3.2, 0.9, 0.25);
  const flame = new THREE.Color(5, 1.6, 0.3);

  /** Clearance: max height a structure of radius rad at (x,z) may have, or -1 if it can't exist */
  const clearance = (x: number, z: number, rad: number) => {
    const minY = grid.minYNear(x, z, rad + 18);
    if (minY === Infinity) return Infinity;
    return minY - 24;
  };

  // ---- generic tower (downtown / core)
  const tower_ = (x: number, z: number, w: number, d: number, h: number, maxH: number, r: RNG, dist: number) => {
    const seed = r() * 1000,
      style = r(),
      lit = rrange(r, 0.12, 0.55),
      pal = r();
    h = Math.min(h, maxH);
    put(boxes, x, 0, z, w, h, d, [seed, style, lit, pal], dist);
    let top = h,
      cw = w,
      cd = d;
    if (h > 90 && r() < 0.55) {
      const tiers = 1 + Math.floor(r() * 2);
      for (let t = 0; t < tiers; t++) {
        cw *= rrange(r, 0.55, 0.85);
        cd *= rrange(r, 0.55, 0.85);
        const th = Math.min(h * rrange(r, 0.15, 0.4), maxH - top);
        if (th < 8) break;
        put(boxes, x, top, z, cw, th, cd, [seed + t + 1, style, lit, pal], dist);
        top += th;
      }
    }
    if (h > 140 && r() < 0.4 && top + 20 < maxH) {
      const sh = Math.min(rrange(r, 20, 70), maxH - top);
      put(boxes, x, top, z, 1.2, sh, 1.2, [seed, 0, 0, pal], dist);
      top += sh;
    }
    if (h > 90 && roofSpots.length < 400 && r() < 0.3 && top + 40 < maxH) roofSpots.push(new THREE.Vector3(x, top, z));
    if (h > 60) glows.add(new THREE.Vector3(x, top + 1.5, z), beacon, 2.2, 0.5 + r() * 0.3, r());
    if (h > 110 && r() < 0.18) {
      const face = Math.floor(r() * 4);
      const nrm = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)][face];
      const fw = face < 2 ? d : w;
      const hw = Math.min(fw * 0.8, 60);
      const pos = new THREE.Vector3(x, h * rrange(r, 0.45, 0.8), z).addScaledVector(nrm, (face < 2 ? w : d) / 2 + 1.5);
      hologramSpots.push({ pos, normal: nrm, w: hw, h: hw * rrange(r, 0.5, 1.4), district: 'downtown' });
    }
  };

  // ---- Neo-Kyoto: low dense blocks with stacked pagoda eaves, lanterns and vertical signs
  const kyoto = (x: number, z: number, w: number, d: number, maxH: number, r: RNG) => {
    const seed = r() * 1000;
    const pal = r();
    const floors = 2 + Math.floor(r() * (r() < 0.12 ? 9 : 4));
    let y = 0;
    let cw = w,
      cd = d;
    const fh = rrange(r, 7, 10);
    for (let f = 0; f < floors; f++) {
      if (y + fh + 1.5 > maxH) break;
      put(boxes, x, y, z, cw, fh, cd, [seed + f, 0.2, rrange(r, 0.4, 0.8), pal], 3);
      y += fh;
      // eave: wide thin slab with a glowing lip
      put(boxes, x, y, z, cw * 1.25 + 3, 1.2, cd * 1.25 + 3, [seed, 0, 0, pal], 3);
      put(boxes, x, y - 0.25, z, cw * 1.25 + 3.2, 0.3, cd * 1.25 + 3.2, [seed, 0, 0, pal], 3, 2);
      y += 1.2;
      cw *= 0.86;
      cd *= 0.86;
    }
    if (y < 5) return;
    // roof spire
    if (floors > 5 && y + 12 < maxH) put(boxes, x, y, z, 1.4, 12, 1.4, [seed, 0, 0, pal], 3, 2);
    // lanterns at the corners of the ground floor
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ])
      glows.add(new THREE.Vector3(x + sx * (w * 0.62 + 1.5), 5 + r() * 3, z + sz * (d * 0.62 + 1.5)), lantern, 1.6, 0, 0);
    if (r() < 0.35) {
      const face = Math.floor(r() * 4);
      const nrm = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)][face];
      const pos = new THREE.Vector3(x, Math.min(y * 0.55, 30), z).addScaledVector(nrm, (face < 2 ? w : d) * 0.62 + 2.5);
      hologramSpots.push({ pos, normal: nrm, w: 10, h: 30, district: 'kyoto' });
    }
  };

  // ---- Port Town: container stacks, warehouses, cranes (on piers; the rest is the bay)
  const port = (x: number, z: number, w: number, d: number, maxH: number, r: RNG) => {
    const k = r();
    if (k < 0.45) {
      // container stacks
      const rows = Math.floor(w / 3.2),
        cols = Math.floor(d / 13);
      for (let i = 0; i < rows; i++)
        for (let j = 0; j < cols; j++) {
          const stack = 1 + Math.floor(r() * 4);
          for (let s = 0; s < stack; s++) {
            if ((s + 1) * 2.7 > maxH) break;
            put(boxes, x - w / 2 + (i + 0.5) * 3.2, s * 2.7, z - d / 2 + (j + 0.5) * 13, 2.5, 2.6, 12, [r() * 1000, 0, 0, r()], 2, 1);
          }
        }
    } else if (k < 0.75) {
      // warehouse
      const h = Math.min(rrange(r, 14, 26), maxH);
      if (h < 8) return;
      put(boxes, x, 0, z, w * 0.95, h, d * 0.9, [r() * 1000, 0.1, rrange(r, 0.05, 0.2), r()], 2);
    } else {
      // gantry crane
      const H = Math.min(rrange(r, 55, 85), maxH);
      if (H < 40) return;
      const span = Math.min(w, 40) * 0.8;
      for (const sx of [-1, 1])
        for (const sz of [-1, 1]) put(boxes, x + (sx * span) / 2, 0, z + sz * 6, 1.6, H, 1.6, [r(), 0, 0, 0.5], 2, 0);
      put(boxes, x, H, z, span + 4, 3, 14, [r(), 0, 0, 0.5], 2, 0);
      const ang = r() * Math.PI;
      put(boxes, x, H + 3, z, 90, 2, 3, [r(), 0, 0, 0.93], 2, 0, ang);
      put(boxes, x, H + 5, z, 90, 0.3, 0.3, [r(), 0, 0, 0.1], 2, 2, ang);
      for (const t of [-40, 0, 40]) glows.add(new THREE.Vector3(x + Math.cos(ang) * t, H + 6, z - Math.sin(ang) * t), beacon, 2.5, 0.8, r());
    }
  };

  // ---- Arcology: huge glass pyramids, domes and slender white spires
  const arcology = (x: number, z: number, w: number, maxH: number, r: RNG) => {
    const k = r();
    if (k < 0.35) {
      const b = Math.min(w * rrange(r, 1.6, 2.4), 320);
      const h = Math.min(b * rrange(r, 0.7, 1), maxH);
      if (h < 40) return;
      put(pyrs, x, 0, z, b, h, b, [r() * 1000, 0.5, rrange(r, 0.3, 0.6), r()], 4, 0, Math.PI / 4);
      glows.add(new THREE.Vector3(x, h + 2, z), new THREE.Color(1.5, 3, 4), 6, 0.3, r());
    } else if (k < 0.55) {
      const rad = Math.min(w * rrange(r, 0.6, 1.1), 150);
      if (rad * 0.8 > maxH) return;
      domes.push({ x, z, r: rad });
    } else {
      const h = Math.min(rrange(r, 160, 420), maxH);
      if (h < 60) return;
      const rad = rrange(r, 12, 26);
      put(cyls, x, 0, z, rad * 2, h, rad * 2, [r() * 1000, 0.7, rrange(r, 0.3, 0.7), r()], 4);
      for (let y = 40; y < h; y += rrange(r, 50, 90)) put(cyls, x, y, z, rad * 2.6, 2, rad * 2.6, [r(), 0, 0, 0.3], 4, 2);
      glows.add(new THREE.Vector3(x, h + 2, z), beacon, 3, 0.5, r());
    }
  };
  const domes: { x: number; z: number; r: number }[] = [];

  // ---- Fire Field: refinery tanks, flare stacks, pipe racks
  const fire = (x: number, z: number, w: number, d: number, maxH: number, r: RNG) => {
    const k = r();
    if (k < 0.45) {
      const n = 1 + Math.floor(r() * 3);
      for (let i = 0; i < n; i++) {
        const rad = rrange(r, 8, Math.min(w, d) / (n + 0.5));
        const h = Math.min(rrange(r, 12, 34), maxH);
        if (h < 6) continue;
        put(cyls, x - w / 2 + (w / n) * (i + 0.5), 0, z + rrange(r, -d / 4, d / 4), rad * 2, h, rad * 2, [r() * 1000, 0.9, rrange(r, 0.05, 0.2), r()], 5);
      }
    } else if (k < 0.75) {
      const h = Math.min(rrange(r, 70, 160), maxH);
      if (h < 30) return;
      const rad = rrange(r, 2.5, 5);
      put(cyls, x, 0, z, rad * 2, h, rad * 2, [r() * 1000, 0.9, 0.1, r()], 5);
      flames.push(new THREE.Vector3(x, h, z));
      glows.add(new THREE.Vector3(x, h + 6, z), flame, 12, 0, 0);
    } else {
      const h = Math.min(rrange(r, 18, 40), maxH);
      if (h < 8) return;
      put(boxes, x, 0, z, w * 0.8, h, d * 0.8, [r() * 1000, 0.8, rrange(r, 0.1, 0.3), r()], 5);
      // pipe rack
      put(boxes, x, h * 0.6, z + d * 0.45, w, 1.5, 1.5, [r(), 0, 0, 0.2], 5, 2);
    }
  };
  const flames: THREE.Vector3[] = [];

  // ---- walk the city grid
  const cx0 = 1200,
    cz0 = 1500;
  const portPts: THREE.Vector3[] = [];
  const firePts: THREE.Vector3[] = [];
  for (const c of grid.coarse) {
    const d = track.district(c.prog);
    if (d === 'port') portPts.push(new THREE.Vector3(c.x, 0, c.z));
    if (d === 'fire') firePts.push(new THREE.Vector3(c.x, 0, c.z));
  }
  const nearSet = (pts: THREE.Vector3[], x: number, z: number, r: number) => pts.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < r * r);

  for (let bx = -45; bx <= 45; bx++) {
    for (let bz = -45; bz <= 45; bz++) {
      const bxw = cx0 + bx * BLOCK;
      const bzw = cz0 + bz * BLOCK;
      const dist0 = Math.hypot(bx * BLOCK, bz * BLOCK);
      if (dist0 > 6800) continue;
      const r = mulberry32((bx + 100) * 7919 + (bz + 100) * 104729);
      const near = grid.nearest(bxw, bzw);
      let district: District = near.dist < 1300 ? track.district(near.prog) : 'downtown';
      // the bay: water around the port section, piers only close to the course
      const inBay = nearSet(portPts, bxw, bzw, 900);
      if (inBay) {
        district = 'port';
        if (near.dist > 420 || r() < 0.35) {
          // open water: the odd cargo ship riding at anchor
          if (r() < 0.12 && clearance(bxw, bzw, 60) > 30) {
            const ang = r() * Math.PI;
            const len = rrange(r, 80, 140);
            put(boxes, bxw, 0, bzw, len, 9, 16, [r() * 1000, 0.1, 0.05, r()], 2, 0, ang);
            const cx = bxw + Math.cos(ang) * len * 0.38,
              cz = bzw - Math.sin(ang) * len * 0.38;
            put(boxes, cx, 9, cz, 12, 14, 14, [r() * 1000, 0.2, 0.5, 0.3], 2, 0, ang);
            for (let k = -3; k <= 3; k++) {
              const t = (k / 3) * len * 0.45;
              glows.add(new THREE.Vector3(bxw + Math.cos(ang) * t, 10, bzw - Math.sin(ang) * t), k % 2 ? beacon : lantern, 1.8, 0, 0);
              if (r() < 0.8) put(boxes, bxw + Math.cos(ang) * t * 0.8, 9, bzw - Math.sin(ang) * t * 0.8, 10, 2.6 * (1 + Math.floor(r() * 3)), 13, [r() * 1000, 0, 0, r()], 2, 1, ang);
            }
          }
          continue;
        }
      }
      if (district !== 'port' && nearSet(firePts, bxw, bzw, 700)) district = 'fire';
      const far = near.dist > 1600;
      if (far && r() < 0.3) continue;
      if (!far && r() < 0.05) continue;
      const inner = BLOCK - STREET;
      const split = district === 'kyoto' ? 3 : district === 'arcology' || district === 'fire' || far ? 1 : r() < 0.5 ? 2 : r() < 0.5 ? 1 : 3;
      const lot = inner / split;
      for (let i = 0; i < split; i++)
        for (let j = 0; j < split; j++) {
          const w = lot * rrange(r, 0.7, 0.95);
          const d = lot * rrange(r, 0.7, 0.95);
          const x = bxw - inner / 2 + lot * (i + 0.5);
          const z = bzw - inner / 2 + lot * (j + 0.5);
          if (Math.hypot(x - tower.pos.x, z - tower.pos.z) < tower.radius + 60) continue;
          const bigRad = district === 'arcology' ? Math.hypot(w, d) * 1.2 : Math.hypot(w, d) / 2 + (district === 'kyoto' ? 6 : 0);
          const maxH = clearance(x, z, bigRad);
          if (maxH < 10) continue;
          switch (district) {
            case 'kyoto':
              kyoto(x, z, w * 0.8, d * 0.8, maxH, r);
              break;
            case 'port':
              port(x, z, w, d, maxH, r);
              break;
            case 'arcology':
              if (r() < 0.55) arcology(x, z, w, maxH, r);
              break;
            case 'fire':
              fire(x, z, w, d, maxH, r);
              break;
            default: {
              const dT = Math.hypot(x - tower.pos.x, z - tower.pos.z);
              const core = Math.exp(-dT / 1600) * (district === 'core' ? 1.4 : 1);
              let h = 25 + Math.pow(r(), 2.2) * (140 + 360 * core);
              if (r() < 0.05 + 0.1 * core) h += rrange(r, 150, 320);
              if (far) h = 40 + Math.pow(r(), 1.5) * 380;
              tower_(x, z, w, d, h, maxH, r, DISTRICT_ID[district]);
            }
          }
        }
    }
  }

  // ---- meshes
  const mkMat = (defines: Record<string, number> = {}) =>
    new THREE.ShaderMaterial({ uniforms: { ...globalUniforms, uEnv: lightUniforms.uEnv }, vertexShader: buildingVert, fragmentShader: buildingFrag, defines });
  const addInst = (geo: THREE.BufferGeometry, b: Batch, mat: THREE.Material) => {
    if (!b.mats.length) return;
    const inst = new THREE.InstancedMesh(geo, mat, b.mats.length);
    b.mats.forEach((m, i) => inst.setMatrixAt(i, m));
    geo.setAttribute('iInfo', new THREE.InstancedBufferAttribute(new Float32Array(b.info), 4));
    geo.setAttribute('iInfo2', new THREE.InstancedBufferAttribute(new Float32Array(b.info2), 2));
    inst.frustumCulled = false;
    group.add(inst);
  };
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  boxGeo.translate(0, 0.5, 0);
  addInst(boxGeo, boxes, mkMat());
  const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 1);
  cylGeo.translate(0, 0.5, 0);
  addInst(cylGeo, cyls, mkMat({ ROUND: 1 }));
  const pyrGeo = new THREE.ConeGeometry(0.7071, 1, 4, 1);
  pyrGeo.translate(0, 0.5, 0);
  addInst(pyrGeo, pyrs, mkMat({ ROUND: 1 }));

  if (domes.length) group.add(buildDomes(domes));
  if (flames.length) group.add(buildFlames(flames));
  group.add(buildGround(portPts, firePts));
  group.add(buildMegaTower(tower.pos, tower.radius, glows));
  group.add(buildKyotoGates(track, grid));
  return { group, glows, hologramSpots, roofSpots, grid };
}

// --------------------------------------------------------------------------- extras
function buildDomes(domes: { x: number; z: number; r: number }[]) {
  const g = new THREE.Group();
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms, uEnv: lightUniforms.uEnv },
    vertexShader: `varying vec3 vN; varying vec3 vWorld; varying vec3 vP; void main(){ vP = position; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      ${fogParsGLSL}
      uniform samplerCube uEnv;
      varying vec3 vN; varying vec3 vWorld; varying vec3 vP;
      void main(){
        vec3 N = normalize(vN); vec3 V = normalize(uCamPos - vWorld);
        vec2 h = vec2(atan(vP.z, vP.x) * 12., asin(clamp(vP.y, -1., 1.)) * 14.);
        h.x += mod(floor(h.y), 2.) * .5;
        vec2 f = fract(h) - .5;
        float frame = smoothstep(.4, .47, max(abs(f.x), abs(f.y)));
        float fres = .08 + .92 * pow(1. - max(dot(N, V), 0.), 4.);
        vec3 col = textureLod(uEnv, reflect(-V, N), 1.).rgb * fres * .9 + vec3(.02,.05,.07);
        col += vec3(.4,.9,1.4) * frame * .9;
        col += vec3(.2,.9,.6) * .15 * (1. - vP.y); // gardens glowing inside
        gl_FragColor = vec4(applyFog(col, vWorld), 1.);
      }`,
  });
  const geo = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);
  for (const d of domes) {
    const m = new THREE.Mesh(geo, mat);
    m.scale.set(d.r, d.r * 0.8, d.r);
    m.position.set(d.x, 0, d.z);
    g.add(m);
  }
  return g;
}

function buildFlames(pts: THREE.Vector3[]) {
  const geo = new THREE.ConeGeometry(1, 1, 12, 6, true);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uTime; varying float vY; varying float vSeed;
      void main(){
        vec3 p = position;
        float seed = instanceMatrix[3].x * .13;
        vSeed = seed;
        vY = p.y;
        p.x += sin(uTime * 7. + p.y * 5. + seed) * .25 * p.y;
        p.z += cos(uTime * 6. + p.y * 4. + seed) * .25 * p.y;
        p.y *= .8 + .35 * sin(uTime * 11. + seed);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.);
      }`,
    fragmentShader: `uniform float uTime; varying float vY; varying float vSeed;
      void main(){ vec3 c = mix(vec3(6.,2.5,.6), vec3(2.,.3,.05), vY); gl_FragColor = vec4(c * (1. - vY) * (.7 + .3 * sin(uTime * 23. + vSeed)), 1.); }`,
  });
  const inst = new THREE.InstancedMesh(geo, mat, pts.length);
  pts.forEach((p, i) => inst.setMatrixAt(i, new THREE.Matrix4().compose(p, new THREE.Quaternion(), new THREE.Vector3(4, 22, 4))));
  inst.frustumCulled = false;
  return inst;
}

/** Red torii gates straddling the course through Neo-Kyoto */
function buildKyotoGates(track: Track, grid: TrackGrid) {
  void grid;
  const g = new THREE.Group();
  const main = track.main;
  const m = main.markers;
  const wood = new THREE.MeshStandardMaterial({ color: 0x5a0a08, emissive: new THREE.Color(0.9, 0.08, 0.04), emissiveIntensity: 1.4, roughness: 0.6 });
  const trim = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.2, 0.3) });
  const P = new THREE.Vector3(),
    N = new THREE.Vector3(),
    T = new THREE.Vector3();
  const f = { p: new THREE.Vector3(), t: new THREE.Vector3(), u: new THREE.Vector3(), r: new THREE.Vector3() };
  for (let s = m.db1 + 350; s < m.loop0 - 60; s += 120) addGate(s);
  for (let s = m.boostC; s < m.wall0 - 220; s += 120) addGate(s);
  for (let s = m.hairpin - 500; s < m.climb0 - 30; s += 110) addGate(s);
  function addGate(s: number) {
    main.sample(s, f);
    if (f.u.y < 0.8 || Math.abs(main.curlAt(s)) > 0.02 || main.flagAt(s) & 1) return;
    const [L, R] = main.ext(s);
    const span = L + R + 12;
    const H = 26;
    const gate = new THREE.Group();
    for (const sx of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.5, H + 8, 12), wood);
      pillar.position.set((sx * span) / 2, (H + 8) / 2 - 8, 0);
      gate.add(pillar);
    }
    const kasagi = new THREE.Mesh(new THREE.BoxGeometry(span + 14, 2.4, 3.2), wood);
    kasagi.position.set(0, H, 0);
    gate.add(kasagi);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(span + 14.4, 0.35, 3.4), trim);
    lip.position.set(0, H + 1.3, 0);
    gate.add(lip);
    const nuki = new THREE.Mesh(new THREE.BoxGeometry(span + 4, 1.4, 1.6), wood);
    nuki.position.set(0, H - 5, 0);
    gate.add(nuki);
    main.surf(s, 0, 0, P, N, T);
    gate.position.copy(f.p);
    // stand upright even on banked road
    const up = new THREE.Vector3(0, 1, 0);
    const rr = new THREE.Vector3().crossVectors(f.t, up).normalize();
    const tt = new THREE.Vector3().crossVectors(up, rr).normalize();
    gate.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(rr, up, tt.negate()));
    g.add(gate);
  }
  return g;
}

function buildGround(portPts: THREE.Vector3[], firePts: THREE.Vector3[]) {
  const g = new THREE.Group();
  const geo = new THREE.PlaneGeometry(40000, 40000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms, uEnv: lightUniforms.uEnv },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main(){ vec4 w = modelMatrix * vec4(position,1.); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      ${fogParsGLSL}
      ${noiseGLSL}
      uniform samplerCube uEnv;
      varying vec3 vWorld;
      void main(){
        vec2 p = vWorld.xz - vec2(${1200 - (BLOCK - STREET) / 2 - STREET}., ${1500 - (BLOCK - STREET) / 2 - STREET}.);
        vec2 b = mod(p, ${BLOCK}.);
        vec2 bid = floor(p / ${BLOCK}.);
        vec2 ds = abs(b - ${STREET / 2}.);
        float street = step(min(ds.x, ds.y), ${STREET / 2}.);
        vec3 col = vec3(.008,.008,.012);
        vec3 V = normalize(uCamPos - vWorld);
        float fres = .02 + .98 * pow(1. - max(V.y, 0.), 5.);
        col += textureLod(uEnv, reflect(-V, vec3(0,1,0)), 3.).rgb * fres * .3 * street;
        float fw = fwidth(p.x) + fwidth(p.y);
        float traffic = 0.;
        if(ds.y < ${STREET / 2}.){
          float lane = step(ds.y, 8.);
          float t = fract((p.x + (b.y > ${STREET / 2}. ? 1. : -1.) * uTime * 25.) / 30. + hash11(bid.y));
          traffic += lane * smoothstep(.04, 0., abs(t - .5)) ;
        }
        if(ds.x < ${STREET / 2}.){
          float lane = step(ds.x, 8.);
          float t = fract((p.y + (b.x > ${STREET / 2}. ? 1. : -1.) * uTime * 25.) / 30. + hash11(bid.x));
          traffic += lane * smoothstep(.04, 0., abs(t - .5));
        }
        float glowLine = exp(-min(ds.x, ds.y) * .08) * .25;
        col += vec3(1.,.45,.12) * glowLine * street;
        col += mix(vec3(1.,.2,.1), vec3(1.,.9,.7), step(.5, hash12(bid))) * traffic * 1.2 / (1. + fw * 3.);
        col += vec3(.1,.3,.6) * .03 * (1. - street) * step(.95, fract(b.x / 10.));
        col = applyFog(col, vWorld);
        gl_FragColor = vec4(col, 1.);
      }`,
  });
  g.add(new THREE.Mesh(geo, mat));
  // regional overlays: the bay (water) and the fire field (glowing magma cracks)
  const overlay = (pts: THREE.Vector3[], radius: number, y: number, frag: string) => {
    if (!pts.length) return;
    let minX = 1e9,
      maxX = -1e9,
      minZ = 1e9,
      maxZ = -1e9;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const MAXP = 48;
    const step = Math.max(1, Math.ceil(pts.length / MAXP));
    const sel = pts.filter((_, i) => i % step === 0).slice(0, MAXP);
    while (sel.length < MAXP) sel.push(sel[sel.length - 1]);
    const pg = new THREE.PlaneGeometry(maxX - minX + radius * 2, maxZ - minZ + radius * 2, 1, 1);
    pg.rotateX(-Math.PI / 2);
    pg.translate((minX + maxX) / 2, y, (minZ + maxZ) / 2);
    const m = new THREE.ShaderMaterial({
      uniforms: { ...globalUniforms, uEnv: lightUniforms.uEnv, uPts: { value: sel.map((p) => new THREE.Vector2(p.x, p.z)) }, uRad: { value: radius } },
      vertexShader: `varying vec3 vWorld; void main(){ vec4 w = modelMatrix * vec4(position,1.); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        ${fogParsGLSL}
        ${noiseGLSL}
        uniform samplerCube uEnv;
        uniform vec2 uPts[${MAXP}];
        uniform float uRad;
        varying vec3 vWorld;
        void main(){
          float dmin = 1e9;
          for(int i = 0; i < ${MAXP}; i++) dmin = min(dmin, length(vWorld.xz - uPts[i]));
          float mask = smoothstep(uRad, uRad - 120., dmin);
          if(mask < .01) discard;
          ${frag}
        }`,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(pg, m);
    mesh.renderOrder = -10;
    g.add(mesh);
  };
  overlay(
    portPts,
    900,
    0.6,
    /* glsl */ `
          vec2 q = vWorld.xz * .02;
          float w1 = fbm(q + vec2(uTime * .05, uTime * .03));
          float w2 = fbm(q * 2.3 - vec2(uTime * .04, 0.));
          vec3 N = normalize(vec3((w1 - .5) * .35, 1., (w2 - .5) * .35));
          vec3 V = normalize(uCamPos - vWorld);
          float fres = .03 + .97 * pow(1. - max(dot(N, V), 0.), 5.);
          vec3 col = vec3(.004, .012, .02) + textureLod(uEnv, reflect(-V, N), 1.5).rgb * fres * 1.3;
          // shimmering light columns from the city on the water
          float streak = pow(vnoise(vec2(vWorld.x * .05, vWorld.z * .004 + uTime * .2)), 6.) * 2.;
          col += vec3(1., .5, .8) * streak * fres;
          col = applyFog(col, vWorld);
          gl_FragColor = vec4(col, mask);`,
  );
  overlay(
    firePts,
    700,
    0.4,
    /* glsl */ `
          vec2 q = vWorld.xz * .012;
          vec2 id = floor(q), fr = fract(q);
          float d1 = 9., d2 = 9.;
          for(int i=-1;i<=1;i++) for(int j=-1;j<=1;j++){
            vec2 o = vec2(float(i), float(j));
            vec2 c = o + hash22(id + o) - fr;
            float d = dot(c, c);
            if(d < d1){ d2 = d1; d1 = d; } else if(d < d2) d2 = d;
          }
          float crack = smoothstep(.06, .0, sqrt(d2) - sqrt(d1));
          float pulse = .7 + .3 * sin(uTime * 1.5 + vWorld.x * .01);
          vec3 col = vec3(.02, .008, .004) + vec3(4., .9, .1) * crack * pulse + vec3(.3, .06, .01) * fbm(q * 3. + uTime * .05);
          col = applyFog(col, vWorld);
          gl_FragColor = vec4(col, mask);`,
  );
  return g;
}

function buildMegaTower(pos: THREE.Vector3, radius: number, glows: StaticGlows) {
  const g = new THREE.Group();
  const H = 720;
  const shaft = new THREE.CylinderGeometry(radius * 0.45, radius * 0.8, H, 8, 40, true);
  shaft.translate(0, H / 2, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...globalUniforms, uEnv: lightUniforms.uEnv },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorld; varying vec3 vN; varying vec2 vUv;
      void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.); vWorld = w.xyz; vN = normalize(mat3(modelMatrix)*normal); gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: /* glsl */ `
      ${fogParsGLSL}
      ${noiseGLSL}
      uniform samplerCube uEnv;
      varying vec3 vWorld; varying vec3 vN; varying vec2 vUv;
      void main(){
        vec3 N = normalize(vN); vec3 V = normalize(uCamPos - vWorld);
        float y = vWorld.y;
        vec2 cc = vec2(vUv.x * 160., y / 4.);
        vec2 cell = floor(cc); vec2 f = fract(cc);
        float win = step(.1, f.x) * step(f.x,.9) * step(.2,f.y) * step(f.y,.8);
        float lit = step(.45, hash12(cell));
        float fres = .05 + .95*pow(1.-max(dot(N,V),0.),5.);
        vec3 col = vec3(.01,.012,.02) + textureCube(uEnv, reflect(-V,N)).rgb * fres * .8;
        col += win * lit * mix(vec3(.5,.8,1.), vec3(1.,.8,.6), hash12(cell+3.)) * .9;
        float edge = abs(fract(vUv.x * 8.) - .5);
        col += vec3(.2,.7,1.) * smoothstep(.49, .5, edge) * 4.;
        float ring = pow(fract(y / 120. - uTime * .25), 30.);
        col += vec3(1.,.3,.8) * ring * 3.;
        col = applyFog(col, vWorld);
        gl_FragColor = vec4(col, 1.);
      }`,
  });
  g.add(new THREE.Mesh(shaft, mat));
  const crown = new THREE.CylinderGeometry(radius * 0.2, radius * 0.45, 90, 8, 4, true);
  crown.translate(0, H + 45, 0);
  g.add(new THREE.Mesh(crown, mat));
  const spire = new THREE.CylinderGeometry(0.5, 4, 220, 6);
  spire.translate(0, H + 90 + 110, 0);
  g.add(new THREE.Mesh(spire, new THREE.MeshBasicMaterial({ color: new THREE.Color(2, 2.5, 3) })));
  glows.add(new THREE.Vector3(pos.x, H + 312, pos.z), new THREE.Color(8, 0.5, 0.3), 14, 0.7, 0);
  for (let i = 0; i < 5; i++) {
    const y = 160 + i * 115;
    const rr = radius * (0.8 - (y / H) * 0.35) + 6;
    const ringGeo = new THREE.TorusGeometry(rr, 1.2, 8, 96);
    ringGeo.rotateX(Math.PI / 2);
    ringGeo.translate(0, y, 0);
    const c = i % 2 ? new THREE.Color(0.4, 2.4, 4) : new THREE.Color(4, 0.6, 2.6);
    g.add(new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: c })));
  }
  g.position.set(pos.x, 0, pos.z);
  return g;
}

void HALF_W;
