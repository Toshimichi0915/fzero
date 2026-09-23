import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  EffectPass,
  BloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  ChromaticAberrationEffect,
  Effect,
  BlendFunction,
  NoiseEffect,
  SMAAEffect,
  SMAAPreset,
  KernelSize,
} from 'postprocessing';
import { RoadReflection, ROAD_LAYER } from '../fx/RoadReflection';

/** Radial speed blur + subtle heat shimmer for boost. Operates on HDR input. */
export class SpeedEffect extends Effect {
  constructor() {
    super(
      'SpeedEffect',
      /* glsl */ `
      uniform float strength;
      uniform vec2 center;
      uniform float boost;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        vec2 d = uv - center;
        float r = length(d);
        float k = strength * smoothstep(.12, .75, r);
        if(k < .0005){ outputColor = inputColor; return; }
        vec3 acc = inputColor.rgb;
        float w = 1.;
        for(int i=1;i<12;i++){
          float t = float(i) / 12.;
          float wi = 1. - t * .6;
          acc += texture2D(inputBuffer, uv - d * t * k).rgb * wi;
          w += wi;
        }
        vec3 col = acc / w;
        // boost tint on the periphery
        col += vec3(.25,.55,1.) * boost * smoothstep(.35,.9,r) * .12;
        outputColor = vec4(col, inputColor.a);
      }`,
      {
        blendFunction: BlendFunction.NORMAL,
        uniforms: new Map<string, THREE.Uniform>([
          ['strength', new THREE.Uniform(0)],
          ['center', new THREE.Uniform(new THREE.Vector2(0.5, 0.52))],
          ['boost', new THREE.Uniform(0)],
        ]),
      },
    );
  }
  set strength(v: number) {
    this.uniforms.get('strength')!.value = v;
  }
  set boost(v: number) {
    this.uniforms.get('boost')!.value = v;
  }
}

/** Removes NaN/Inf and clamps extreme HDR values so bloom can't blow up the frame. */
export class SanitizeEffect extends Effect {
  constructor() {
    super(
      'SanitizeEffect',
      /* glsl */ `
      bool bad(float x){ return (floatBitsToUint(x) & 0x7fffffffu) >= 0x7f800000u; }
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        vec3 c = inputColor.rgb;
        if(bad(c.r) || bad(c.g) || bad(c.b)) c = vec3(0.);
        #ifdef DEBUG_NAN
        if(bad(inputColor.r) || bad(inputColor.g) || bad(inputColor.b) || bad(inputColor.a)) c = vec3(0.,40.,0.);
        #endif
        outputColor = vec4(clamp(c, vec3(0.), vec3(64.)), 1.);
      }`,
      { blendFunction: BlendFunction.SET, defines: new Map(location.search.includes('nan') ? [['DEBUG_NAN', '1']] : []) },
    );
  }
}

/** Screen flash/overlay for damage and energy warnings */
export class OverlayEffect extends Effect {
  constructor() {
    super(
      'OverlayEffect',
      /* glsl */ `
      uniform vec3 color;
      uniform float amount;
      uniform float lowEnergy;
      uniform float time;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
        vec2 d = uv - .5;
        float edge = smoothstep(.25, .75, length(d * vec2(1.2, 1.)));
        vec3 col = inputColor.rgb;
        col += color * amount * (.25 + edge);
        float pulse = .5 + .5 * sin(time * 9.);
        col = mix(col, col * vec3(1.,.25,.2) + vec3(.25,0.,0.) * edge, lowEnergy * edge * pulse * .8);
        outputColor = vec4(col, inputColor.a);
      }`,
      {
        uniforms: new Map<string, THREE.Uniform>([
          ['color', new THREE.Uniform(new THREE.Color(1, 1, 1))],
          ['amount', new THREE.Uniform(0)],
          ['lowEnergy', new THREE.Uniform(0)],
          ['time', new THREE.Uniform(0)],
        ]),
      },
    );
  }
}

export class GameRenderer {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloom: BloomEffect;
  speed: SpeedEffect;
  chroma: ChromaticAberrationEffect;
  overlay: OverlayEffect;
  renderPass: RenderPass;
  reflection: RoadReflection;
  scale = 1;

  constructor(
    public canvas: HTMLCanvasElement,
    public scene: THREE.Scene,
    public camera: THREE.PerspectiveCamera,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      powerPreference: 'high-performance',
      antialias: false,
      stencil: false,
      depth: true,
    });
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.reflection = new RoadReflection(this.renderer);
    camera.layers.enable(ROAD_LAYER);

    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 4,
    });
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new BloomEffect({
      mipmapBlur: true,
      intensity: 1.15,
      luminanceThreshold: 0.75,
      luminanceSmoothing: 0.25,
      radius: 0.78,
      levels: 8,
    });
    this.speed = new SpeedEffect();
    this.chroma = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(0.0008, 0.0006),
      radialModulation: true,
      modulationOffset: 0.25,
    });
    this.overlay = new OverlayEffect();
    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.55 });
    const noise = new NoiseEffect({ blendFunction: BlendFunction.OVERLAY, premultiply: false });
    noise.blendMode.opacity.value = 0.06;
    const smaa = new SMAAEffect({ preset: SMAAPreset.MEDIUM });
    void smaa;
    void KernelSize;

    this.composer.addPass(new EffectPass(camera, new SanitizeEffect()));
    this.composer.addPass(new EffectPass(camera, this.bloom));
    this.composer.addPass(new EffectPass(camera, this.speed));
    this.composer.addPass(new EffectPass(camera, this.chroma));
    this.composer.addPass(new EffectPass(camera, this.overlay, tone, vignette, noise));
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  setQuality(scale: number) {
    this.scale = scale;
    this.resize();
  }
  resize() {
    const w = window.innerWidth,
      h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5) * this.scale);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.reflection?.setSize(w * pr, h * pr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  render(dt: number) {
    this.composer.render(dt);
  }
}
