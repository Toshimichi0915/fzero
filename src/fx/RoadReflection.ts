import * as THREE from 'three';
import { globalUniforms } from '../shaders/common';

export const ROAD_LAYER = 1;

export const reflectionUniforms = {
  uReflTex: { value: null as THREE.Texture | null },
  uReflMatrix: { value: new THREE.Matrix4() },
  uReflOn: { value: 0 },
  uReflNormal: { value: new THREE.Vector3(0, 1, 0) },
  uReflPoint: { value: new THREE.Vector3() },
  uWet: { value: 1 },
};

/**
 * Planar reflection of the scene about the local road plane (under the followed
 * vehicle). Rendered at reduced resolution with mipmaps so the road shader can
 * blur it by roughness. Objects on ROAD_LAYER are not rendered into it.
 */
export class RoadReflection {
  rt: THREE.WebGLRenderTarget;
  cam = new THREE.PerspectiveCamera();
  scale = 0.5;
  enabled = true;
  private plane = new THREE.Plane();
  private clip = new THREE.Vector4();
  private q = new THREE.Vector4();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private rot = new THREE.Matrix4();
  constructor(private renderer: THREE.WebGLRenderer) {
    this.rt = new THREE.WebGLRenderTarget(512, 256, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      samples: 0,
    });
    reflectionUniforms.uReflTex.value = this.rt.texture;
    this.cam.layers.set(0);
  }

  disable() {
    reflectionUniforms.uReflOn.value = 0;
  }
  setSize(w: number, h: number) {
    const W = Math.max(64, Math.floor(w * this.scale)),
      H = Math.max(64, Math.floor(h * this.scale));
    if (this.rt.width !== W || this.rt.height !== H) this.rt.setSize(W, H);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, point: THREE.Vector3, normal: THREE.Vector3) {
    if (!this.enabled) {
      reflectionUniforms.uReflOn.value = 0;
      return;
    }
    const camPos = this.tmp.setFromMatrixPosition(camera.matrixWorld);
    const view = this.tmp2.subVectors(point, camPos);
    if (view.dot(normal) > 0) {
      reflectionUniforms.uReflOn.value = 0;
      return; // camera below the plane
    }
    reflectionUniforms.uReflOn.value = 1;
    reflectionUniforms.uReflNormal.value.copy(normal);
    reflectionUniforms.uReflPoint.value.copy(point);
    view.reflect(normal).negate().add(point);
    this.rot.extractRotation(camera.matrixWorld);
    this.lookAt.set(0, 0, -1).applyMatrix4(this.rot).add(camPos);
    const target = new THREE.Vector3().subVectors(point, this.lookAt).reflect(normal).negate().add(point);
    const c = this.cam;
    c.position.copy(view);
    c.up.set(0, 1, 0).applyMatrix4(this.rot).reflect(normal);
    c.lookAt(target);
    c.far = camera.far;
    c.near = camera.near;
    c.updateMatrixWorld();
    c.projectionMatrix.copy(camera.projectionMatrix);
    c.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    // texture matrix (world -> reflection uv)
    const m = reflectionUniforms.uReflMatrix.value;
    m.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    m.multiply(c.projectionMatrix);
    m.multiply(c.matrixWorldInverse);
    // oblique near plane clipping so nothing under the road leaks in
    this.plane.setFromNormalAndCoplanarPoint(normal, point);
    this.plane.applyMatrix4(c.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const p = c.projectionMatrix.elements;
    this.q.x = (Math.sign(this.clip.x) + p[8]) / p[0];
    this.q.y = (Math.sign(this.clip.y) + p[9]) / p[5];
    this.q.z = -1;
    this.q.w = (1 + p[10]) / p[14];
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    p[2] = this.clip.x;
    p[6] = this.clip.y;
    p[10] = this.clip.z + 1 - 0.003;
    p[14] = this.clip.w;

    const r = this.renderer;
    const oldTarget = r.getRenderTarget();
    const oldCam = globalUniforms.uCamPos.value.clone();
    globalUniforms.uCamPos.value.copy(c.position);
    const sky = scene.userData.sky as THREE.Object3D | undefined;
    const skyPos = sky?.position.clone();
    if (sky) sky.position.copy(c.position);
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(scene, c);
    r.setRenderTarget(oldTarget);
    globalUniforms.uCamPos.value.copy(oldCam);
    if (sky && skyPos) sky.position.copy(skyPos);
  }
}
