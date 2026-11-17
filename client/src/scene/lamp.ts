import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  Points,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector2,
} from 'three';
import { MATERIALS } from './materials.js';
import { TABLE } from './layout.js';
import { seeded } from './noise.js';
import { fuse, type Part } from './shapes.js';

/**
 * The lamp over the table, and the air under it.
 *
 * The light itself is a `SpotLight` owned by `table.ts`. This is everything
 * about it that can be *seen*: the shade it hangs in, the bulb, the shaft of
 * lit air between the shade and the felt, and the dust turning over in it.
 *
 * The last two are what make the rest of the room dark. A lamp in clean air
 * lights a table; a lamp in a room that has been smoked in for forty years
 * lights a column, and everything outside the column is somewhere else.
 */

/** Where the bulb is, and so where the shaft starts. */
export const LAMP_HEIGHT = 1.9;

/** The shade's rim, and how wide the shaft is by the time it reaches the felt. */
const SHAFT = {
  topRadius: 0.2,
  bottomRadius: 0.92,
  bottom: TABLE.surfaceHeight + 0.02,
} as const;

/** The shade's profile, rim first: an enamelled cone of the billiard-hall kind. */
function shadeProfile(scale = 1): Vector2[] {
  return [
    new Vector2(0.262, 0.0),
    new Vector2(0.255, 0.012),
    new Vector2(0.21, 0.05),
    new Vector2(0.14, 0.104),
    new Vector2(0.075, 0.142),
    new Vector2(0.045, 0.156),
    new Vector2(0.04, 0.19),
  ].map((point) => new Vector2(point.x * scale, point.y));
}

function buildFixture(ceiling: number): Group {
  const fixture = new Group();
  const rim = LAMP_HEIGHT + 0.005;

  const shade = new Mesh(new LatheGeometry(shadeProfile(), 48), MATERIALS.enamel);
  shade.position.y = rim;
  fixture.add(shade);

  // The inside of the shade: white once, and the brightest surface in the room.
  const lining = MATERIALS.lampGlow.clone();
  lining.side = BackSide;
  const inner = new Mesh(new LatheGeometry(shadeProfile(0.985), 48), lining);
  inner.position.y = rim + 0.002;
  fixture.add(inner);

  const bulb = new Mesh(new SphereGeometry(0.03, 16, 12), MATERIALS.filament);
  bulb.scale.set(1, 1.25, 1);
  bulb.position.y = rim + 0.045;
  fixture.add(bulb);

  // A cap, a chain, and a rose where the chain meets the ceiling.
  const links: Part[] = [];
  const chainTop = ceiling - 0.03;
  const chainBottom = rim + 0.2;
  const linkCount = Math.floor((chainTop - chainBottom) / 0.034);
  for (let link = 0; link < linkCount; link++) {
    links.push({
      geometry: new TorusGeometry(0.011, 0.0028, 5, 10),
      at: [0, chainBottom + link * 0.034, 0],
      // Alternate links turned a quarter, which is all a chain is.
      turn: [0, link % 2 === 0 ? 0 : Math.PI / 2, 0],
      scale: [1, 1.7, 1],
    });
  }
  const brass = new Mesh(
    fuse([
      { geometry: new CylinderGeometry(0.03, 0.046, 0.05, 16), at: [0, rim + 0.2, 0] },
      { geometry: new CylinderGeometry(0.11, 0.13, 0.02, 24), at: [0, ceiling - 0.01, 0] },
      { geometry: new SphereGeometry(0.05, 14, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), at: [0, ceiling - 0.02, 0] },
      ...links,
    ]),
    MATERIALS.brass,
  );
  fixture.add(brass);

  return fixture;
}

/**
 * The shaft: lit air.
 *
 * A cone with no ends, drawn additively and faded by how squarely it faces the
 * eye — bright through the middle, where a ray passes through the most air, and
 * gone at the silhouette, so there is never an edge to see. It writes no depth
 * and casts nothing; it is not a thing, it is what the room does to light.
 */
function buildShaft(): { mesh: Mesh; material: ShaderMaterial } {
  const height = LAMP_HEIGHT - SHAFT.bottom;
  const geometry = new CylinderGeometry(SHAFT.topRadius, SHAFT.bottomRadius, height, 48, 1, true);
  const material = new ShaderMaterial({
    uniforms: {
      colour: { value: new Color(0xffd2a0) },
      strength: { value: 0.06 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vToEye;
      varying float vHeight;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vToEye = normalize(-viewPosition.xyz);
        vHeight = uv.y;
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 colour;
      uniform float strength;
      varying vec3 vNormal;
      varying vec3 vToEye;
      varying float vHeight;
      void main() {
        float facing = abs(dot(normalize(vNormal), normalize(vToEye)));
        // Thick in the middle, nothing at the edge.
        float through = pow(facing, 1.7);
        // Brightest under the shade; thinning toward the felt, and feathered
        // at both ends so the cone has no rim.
        float fall = mix(0.3, 1.0, vHeight * vHeight);
        float ends = smoothstep(0.0, 0.14, vHeight) * smoothstep(1.0, 0.9, vHeight);
        gl_FragColor = vec4(colour * strength * through * fall * ends, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    blending: AdditiveBlending,
    side: DoubleSide,
    depthWrite: false,
    transparent: true,
  });
  const mesh = new Mesh(geometry, material);
  mesh.position.y = SHAFT.bottom + height / 2;
  // Drawn after the room, so it lies over whatever is behind it.
  mesh.renderOrder = 5;
  return { mesh, material };
}

/** How many motes hang in the shaft. Each is a point; all of them are one draw. */
const MOTES = 170;

/**
 * Dust, turning over in the light.
 *
 * Positions are fixed at start-up and drift in the vertex shader on a clock, so
 * two hundred and forty of them cost one draw call and no work on the CPU. They
 * are seeded like everything else painted here, though nobody will ever compare
 * dust.
 */
function buildMotes(): { points: Points; material: ShaderMaterial } {
  const random = seeded(4242);
  const positions = new Float32Array(MOTES * 3);
  const phases = new Float32Array(MOTES * 3);
  const height = LAMP_HEIGHT - SHAFT.bottom;

  for (let i = 0; i < MOTES; i++) {
    const up = random();
    // The shaft is a cone, so there is more room for dust lower down.
    const radius = (SHAFT.bottomRadius + (SHAFT.topRadius - SHAFT.bottomRadius) * up) * 0.92 * Math.sqrt(random());
    const angle = random() * Math.PI * 2;
    positions[i * 3] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = SHAFT.bottom + 0.06 + up * (height - 0.16);
    positions[i * 3 + 2] = Math.sin(angle) * radius;
    phases[i * 3] = random();
    phases[i * 3 + 1] = random();
    phases[i * 3 + 2] = random();
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('phase', new BufferAttribute(phases, 3));

  const material = new ShaderMaterial({
    uniforms: {
      time: { value: 0 },
      colour: { value: new Color(0xffe2bd) },
      strength: { value: 0.16 },
      // Pixels per metre at a metre away; set from the renderer's height.
      scale: { value: 700 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 phase;
      uniform float time;
      uniform float scale;
      varying float vTwinkle;
      void main() {
        vec3 drift = vec3(
          sin(time * 0.11 + phase.x * 6.283) * 0.07 + sin(time * 0.37 + phase.z * 6.283) * 0.012,
          sin(time * 0.07 + phase.y * 6.283) * 0.05,
          cos(time * 0.09 + phase.z * 6.283) * 0.07 + cos(time * 0.31 + phase.x * 6.283) * 0.012
        );
        vec4 viewPosition = modelViewMatrix * vec4(position + drift, 1.0);
        // A mote is a flake, and only shows when it happens to be face on.
        vTwinkle = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(time * (0.6 + phase.y) + phase.x * 40.0), 3.0);
        gl_PointSize = (0.0022 + 0.0022 * phase.z) * scale / max(-viewPosition.z, 0.05);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 colour;
      uniform float strength;
      varying float vTwinkle;
      void main() {
        vec2 fromCentre = gl_PointCoord - 0.5;
        float soft = smoothstep(0.5, 0.08, length(fromCentre));
        gl_FragColor = vec4(colour * strength * soft * vTwinkle, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });

  const points = new Points(geometry, material);
  // They wander outside the box their resting places make.
  points.frustumCulled = false;
  points.renderOrder = 6;
  return { points, material };
}

export interface Lamp {
  group: Group;
  /** `dread` narrows and reddens the shaft with the light it stands for. */
  update(delta: number, dread: number, lampColour: Color, flicker: number): void;
  /** The height of the drawing surface in pixels, so motes stay the same size. */
  setViewport(heightPixels: number, fovDegrees: number): void;
  /** The shaft and the dust are the first things to go on a weak machine. */
  setAir(visible: boolean): void;
}

export function buildLamp(ceiling: number): Lamp {
  const group = new Group();
  const shaft = buildShaft();
  const motes = buildMotes();
  group.add(buildFixture(ceiling), shaft.mesh, motes.points);

  let time = 0;

  return {
    group,

    update(delta: number, dread: number, lampColour: Color, flicker: number): void {
      time += delta;
      motes.material.uniforms['time']!.value = time;
      (motes.material.uniforms['colour']!.value as Color).copy(lampColour);
      (shaft.material.uniforms['colour']!.value as Color).copy(lampColour);

      // The pool on the felt tightens as the room turns; so does the column.
      const narrow = 1 - 0.3 * dread;
      shaft.mesh.scale.set(narrow, 1, narrow);
      motes.points.scale.set(narrow, 1, narrow);
      // Thicker air later on: there is more in it.
      shaft.material.uniforms['strength']!.value = (0.07 + 0.05 * dread) * flicker;
      motes.material.uniforms['strength']!.value = (0.16 + 0.08 * dread) * flicker;
    },

    setViewport(heightPixels: number, fovDegrees: number): void {
      motes.material.uniforms['scale']!.value =
        heightPixels / (2 * Math.tan((fovDegrees * Math.PI) / 360));
    },

    setAir(visible: boolean): void {
      shaft.mesh.visible = visible;
      motes.points.visible = visible;
    },
  };
}
