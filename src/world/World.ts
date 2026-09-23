import * as THREE from 'three';
import { Track, buildTrack } from '../track/Track';
import { buildTrackMeshes } from '../track/TrackMesh';
import { lightUniforms } from '../track/TrackMesh';
import { createSky, MOON_DIR } from './Sky';
import { buildCity } from './City';
import { StaticGlows } from '../fx/Glows';
import { globalUniforms } from '../shaders/common';
import { buildDecor } from './Decor';

export class World {
  scene = new THREE.Scene();
  track: Track;
  sky: THREE.Mesh;
  envMap!: THREE.Texture; // PMREM for physical materials
  glows = new StaticGlows();
  updaters: ((dt: number, t: number) => void)[] = [];

  constructor(public renderer: THREE.WebGLRenderer) {
    this.track = buildTrack();
    this.sky = createSky();
    this.scene.add(this.sky);
    this.scene.userData.sky = this.sky;
    this.scene.fog = new THREE.FogExp2(0x100820, 0.00035);

    const tm = buildTrackMeshes(this.track);
    this.scene.add(tm.group);
    const city = buildCity(this.track, this.glows);
    this.scene.add(city.group);
    const decor = buildDecor(this.track, city, this.scene);
    this.updaters.push(...decor.updaters);

    // lights for physically based materials (vehicles)
    this.scene.add(new THREE.HemisphereLight(0x6a4cff, 0x200818, 0.9));
    const moon = new THREE.DirectionalLight(0xc8b8ff, 1.6);
    moon.position.copy(MOON_DIR).multiplyScalar(1000);
    this.scene.add(moon);

    this.scene.add(this.glows.build());
    this.buildEnv();
  }

  /** Capture the city into a cubemap used for reflections everywhere. */
  buildEnv() {
    const rt = new THREE.WebGLCubeRenderTarget(512, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    const cam = new THREE.CubeCamera(1, 30000, rt);
    const f = this.track.main;
    cam.position.set(f.pos[0] + 400, 90, f.pos[2] + 400);
    this.sky.position.copy(cam.position);
    globalUniforms.uCamPos.value.copy(cam.position);
    cam.update(this.renderer, this.scene);
    lightUniforms.uEnv.value = rt.texture;
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pm.fromCubemap(rt.texture).texture;
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.9;
  }

  update(dt: number, t: number, camera: THREE.Camera) {
    this.sky.position.copy(camera.position);
    globalUniforms.uCamPos.value.copy(camera.position);
    globalUniforms.uTime.value = t;
    for (const u of this.updaters) u(dt, t);
  }
}
