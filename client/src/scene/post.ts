import {
  HalfFloatType,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * The lens.
 *
 * Everything up to here is a room. This is the eye it is seen through, and most
 * of what makes a dark room frightening rather than merely unlit is in the eye:
 * a bulb that blooms because it is too bright to look at, corners that fall
 * away, grain in the blacks where a camera — or a tired person — starts making
 * things up.
 *
 * Three things happen to the picture, in this order (after a guard against the
 * one-pixel highlights that would otherwise wreck the first of them — see
 * `CEILING`):
 *
 * 1. **Bloom**, on what is genuinely brighter than white: the bulb, the two
 *    lights in the hood, a candle flame, the edge of the door. Nothing else.
 *    The threshold is above anything a lit surface reaches, so the felt never
 *    glows; only sources do.
 * 2. **The grade**: a vignette, a little colour fringing toward the edges,
 *    grain, and a drift toward something colder and less saturated.
 * 3. **Output**: tone mapping and the screen's colour space, once, at the end.
 *
 * The grade answers to two dials and both are already on every client: the
 * room's `dread`, which everybody shares, and the local player's own `fear`,
 * which is theirs alone and comes from `feel/pulse.ts`. Neither is new
 * information. This file draws; it decides nothing.
 */

const GRADE = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    dread: { value: 0 },
    fear: { value: 0 },
    aspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float dread;
    uniform float fear;
    uniform float aspect;
    varying vec2 vUv;

    float hash(vec2 p) {
      vec3 q = fract(vec3(p.xyx) * 0.1031);
      q += dot(q, q.yzx + 33.33);
      return fract((q.x + q.y) * q.z);
    }

    void main() {
      vec2 fromCentre = vUv - 0.5;
      float edge = dot(fromCentre, fromCentre);

      // Fringing: a cheap lens at the best of times, a worse one when the
      // heart is going. Nothing in the middle of the frame, where the cards are.
      vec2 spread = fromCentre * edge * (0.007 + 0.03 * fear + 0.008 * dread);
      vec3 colour = vec3(
        texture2D(tDiffuse, vUv - spread).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv + spread).b
      );

      // The grade. Colour drains as the evening goes, and what is left leans
      // cold in the dark and sour in the light.
      float luma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
      colour = mix(colour, vec3(luma), 0.12 + 0.3 * dread);
      vec3 shadowTint = mix(vec3(0.94, 1.0, 1.04), vec3(0.86, 0.98, 1.06), dread);
      vec3 lightTint = mix(vec3(1.03, 1.0, 0.95), vec3(1.1, 0.96, 0.86), dread);
      colour *= mix(shadowTint, lightTint, smoothstep(0.02, 0.5, luma));

      // The corners go. Wider than tall, like the frame.
      float corner = length(fromCentre * vec2(1.0, 1.0 / max(aspect, 1.0)) * 1.9);
      float vignette = smoothstep(1.15, 0.32, corner);
      colour *= mix(0.42 - 0.2 * dread, 1.0, vignette);

      // Grain, heaviest in the blacks, where an eye starts inventing things.
      float noise = hash(gl_FragCoord.xy + fract(time * 7.13) * 311.0) - 0.5;
      float grain = (0.012 + 0.014 * dread) * (1.0 - smoothstep(0.0, 0.6, luma) * 0.6);
      colour += noise * grain;

      gl_FragColor = vec4(max(colour, 0.0), 1.0);
    }
  `,
};

/**
 * A ceiling on how bright one pixel may be before the bloom sees it.
 *
 * A glossy thing seen edge-on can throw a highlight thousands of times brighter
 * than anything around it — one pixel of it, for one frame. Tone mapping hides
 * that; a bloom does the opposite, and smears the one pixel into a white disc
 * a third of the screen across. An eyeball did exactly this from across the
 * table. Nothing in the room is meant to be brighter than the bulb, so nothing
 * is allowed to be.
 */
const CEILING = {
  uniforms: { tDiffuse: { value: null }, limit: { value: 64 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float limit;
    varying vec2 vUv;
    void main() {
      vec4 colour = texture2D(tDiffuse, vUv);
      // Scaled rather than clipped, so a capped highlight keeps its colour.
      float brightest = max(colour.r, max(colour.g, colour.b));
      // A number that is not a number fails every comparison, this one included.
      if (!(brightest >= 0.0)) colour = vec4(0.0, 0.0, 0.0, 1.0);
      else if (brightest > limit) colour.rgb *= limit / brightest;
      gl_FragColor = colour;
    }
  `,
};

/** How hard the bloom is, at no dread and at full. */
const BLOOM = {
  strength: { calm: 0.2, dread: 0.38 },
  radius: 0.5,
  /**
   * In linear light, before tone mapping — where "white" is nowhere near the
   * top. The lamp is strong and the exposure is what makes the room dark, so a
   * playing card lying under it is already five or six here. The threshold has
   * to clear that, or the whole table glows; the things that are meant to bloom
   * are simply made brighter than it. See the emissive numbers in
   * `materials.ts`, which were chosen against this one.
   */
  threshold: 9,
} as const;

export interface Lens {
  /** Draws one frame through the lens. */
  render(scene: Scene, camera: Camera, delta: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  /** The room's dread, 0..1, and the local player's own fear, 0..1. */
  setMood(dread: number, fear: number): void;
  dispose(): void;
}

export function createLens(renderer: WebGLRenderer): Lens {
  const size = renderer.getDrawingBufferSize(new Vector2());

  // Half-float, so a bulb can be brighter than white on its way to the bloom;
  // multisampled, because a render target does not get the canvas's own
  // antialiasing and a poker table is made of thin bright edges.
  const target = new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);

  const scenePass = new RenderPass(null as unknown as Scene, null as unknown as Camera);
  const bloom = new UnrealBloomPass(new Vector2(size.x, size.y), BLOOM.strength.calm, BLOOM.radius, BLOOM.threshold);
  const grade = new ShaderPass(GRADE);
  composer.addPass(scenePass);
  composer.addPass(new ShaderPass(CEILING));
  composer.addPass(bloom);
  composer.addPass(grade);
  composer.addPass(new OutputPass());

  let time = 0;

  return {
    render(scene: Scene, camera: Camera, delta: number): void {
      time += delta;
      scenePass.scene = scene;
      scenePass.camera = camera;
      grade.uniforms['time']!.value = time;
      composer.render(delta);
    },

    setSize(width: number, height: number, pixelRatio: number): void {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      grade.uniforms['aspect']!.value = height > 0 ? width / height : 1;
    },

    setMood(dread: number, fear: number): void {
      grade.uniforms['dread']!.value = dread;
      grade.uniforms['fear']!.value = fear;
      bloom.strength = BLOOM.strength.calm + (BLOOM.strength.dread - BLOOM.strength.calm) * dread;
    },

    dispose(): void {
      composer.dispose();
      target.dispose();
    },
  };
}
