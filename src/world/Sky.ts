import * as THREE from 'three';
import { globalUniforms, noiseGLSL } from '../shaders/common';

export const MOON_DIR = new THREE.Vector3(-0.55, 0.32, -0.77).normalize();
export const PLANET_DIR = new THREE.Vector3(0.75, 0.12, 0.65).normalize();

export function createSky() {
  const geo = new THREE.SphereGeometry(1, 64, 32);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uTime: globalUniforms.uTime,
      uMoonDir: { value: MOON_DIR },
      uPlanetDir: { value: PLANET_DIR },
      uFogColor: globalUniforms.uFogColor,
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position * 18000., 1.);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uMoonDir;
      uniform vec3 uPlanetDir;
      uniform vec3 uFogColor;
      varying vec3 vDir;
      ${noiseGLSL}
      vec3 stars(vec3 d){
        vec3 col = vec3(0.);
        for(int i=0;i<3;i++){
          float sc = 180. + float(i)*170.;
          vec3 p = d * sc;
          vec3 cell = floor(p);
          float h = hash13(cell + float(i)*13.1);
          if(h > .985){
            vec3 c = cell + .5 + (vec3(hash13(cell+1.), hash13(cell+2.), hash13(cell+3.)) - .5) * .6;
            float dist = length(p - c);
            float tw = .6 + .4*sin(uTime*(2.+h*6.) + h*100.);
            float b = smoothstep(.35, 0., dist) * (h - .985) * 66. * tw;
            vec3 tint = mix(vec3(.7,.8,1.), vec3(1.,.8,.7), hash13(cell+7.));
            col += tint * b * 1.4;
          }
        }
        return col;
      }
      void main(){
        vec3 d = normalize(vDir);
        float y = d.y;
        float az = atan(d.z, d.x);
        // base gradient
        vec3 top = vec3(.004,.006,.022);
        vec3 mid = vec3(.03,.018,.075);
        vec3 hor = vec3(.32,.07,.30);
        vec3 low = vec3(.55,.16,.12);
        float hy = max(y, 0.);
        vec3 col = mix(mid, top, smoothstep(.05, .7, hy));
        col = mix(col, hor, exp(-hy*9.) * .9);
        col = mix(col, low, exp(-hy*28.) * .6);
        // nebula / aurora bands
        vec2 np = vec2(az*2.2, y*4.);
        float n = fbm(np*1.3 + vec2(uTime*.003, 0.));
        float n2 = fbm(np*2.7 - 3.1);
        float band = smoothstep(.45,.9, n) * smoothstep(.0,.25, y) * smoothstep(.9,.3,y);
        col += band * mix(vec3(.12,.02,.25), vec3(.02,.18,.25), n2) * .9;
        // stars
        col += stars(d) * smoothstep(.02, .25, y);
        // moon
        float md = dot(d, uMoonDir);
        float mAng = acos(clamp(md, -1., 1.));
        float mR = .075;
        if(mAng < mR){
          vec3 mx = normalize(cross(uMoonDir, vec3(0,1,0)));
          vec3 my = cross(mx, uMoonDir);
          vec2 mp = vec2(dot(d, mx), dot(d, my)) / mR;
          float crater = fbm(mp*4. + 3.) * .6 + fbm(mp*11.)*.4;
          float limb = sqrt(max(0., 1. - dot(mp,mp)));
          vec3 mc = vec3(1.,.93,.98) * (.55 + .7*crater) * (.35 + .65*limb);
          col = mix(col, mc * 2.4, smoothstep(mR, mR*.97, mAng));
        }
        col += vec3(.7,.5,1.) * exp(-mAng*9.) * .35 + vec3(.9,.7,1.) * exp(-mAng*40.) * .5;
        // ringed gas giant, partially below horizon
        float pd = dot(d, uPlanetDir);
        float pAng = acos(clamp(pd,-1.,1.));
        float pR = .33;
        vec3 px = normalize(cross(uPlanetDir, vec3(0,1,0)));
        vec3 py = cross(px, uPlanetDir);
        vec2 pp = vec2(dot(d, px), dot(d, py)) / pR;
        // rings (tilted ellipse)
        float ca = cos(.35), sa = sin(.35);
        vec2 rp = vec2(ca*pp.x - sa*pp.y, sa*pp.x + ca*pp.y);
        float rr = length(vec2(rp.x, rp.y*4.2));
        float ringMask = smoothstep(1.35,1.4,rr) * smoothstep(2.5,2.3,rr);
        float ringBands = .5 + .5*sin(rr*38.) * sin(rr*11.+1.);
        bool behind = rp.y > 0. && length(pp) < 1.; // ring behind planet
        if(pAng < pR*1.02 && pd > 0.){
          float r2 = dot(pp,pp);
          float limb = sqrt(max(0., 1. - r2));
          float bands = fbm(vec2(pp.y*9. + fbm(pp*3.)*1.5, pp.x*.6));
          vec3 pc = mix(vec3(.18,.07,.28), vec3(.55,.25,.35), bands);
          pc = mix(pc, vec3(.1,.35,.45), smoothstep(.6,.8,bands));
          // lit from the moon side
          float light = clamp(dot(normalize(vec3(pp, limb)), normalize(vec3(-.8,.5,.6))), 0., 1.);
          pc *= (.08 + 1.1*light);
          pc += vec3(.3,.5,1.) * pow(1.-limb, 3.) * .5; // atmosphere rim
          col = mix(col, pc, smoothstep(pR*1.02, pR, pAng));
        }
        if(!behind && pd > 0.) col += ringMask * ringBands * vec3(.55,.45,.6) * .45;
        col += vec3(.3,.15,.5) * exp(-max(pAng - pR, 0.)*14.) * .12;
        // distant skyline silhouette
        float azq = az * 180.;
        float cellId = floor(azq);
        float bh = hash11(cellId*.37) * .035 + hash11(floor(azq*.25)) * .03 + .004;
        if(hash11(cellId+5.) > .93) bh += .05 * hash11(cellId+9.);
        if(y < bh && y > -.2){
          vec3 sk = vec3(.012,.008,.02);
          vec2 wc = vec2(fract(azq)*6., y*600.);
          vec2 wi = floor(wc);
          float lit = step(.72, hash12(wi + cellId*17.)) * step(.2, fract(wc.x)) * step(.3, fract(wc.y));
          sk += lit * mix(vec3(1.,.6,.3), vec3(.3,.8,1.), hash12(wi+cellId)) * .5;
          // aircraft warning lights on top
          if(y > bh - .0015) sk += vec3(1.,.05,.05) * 2. * step(.5, sin(uTime*2.+cellId));
          col = mix(sk, col, .15);
          col += uFogColor * 1.5 * (1. - y/bh) * .6;
        }
        if(y < 0.) col = mix(col, uFogColor*2.2, smoothstep(0., -.05, y));
        gl_FragColor = vec4(col, 1.);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}
