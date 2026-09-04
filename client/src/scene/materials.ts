import { Color, MeshStandardMaterial, type Material } from 'three';

/**
 * Shared materials.
 *
 * Every mesh in the scene draws from this palette rather than making its own,
 * so the renderer switches material state a handful of times per frame instead
 * of once per object. Six seated players is a lot of small meshes; sharing is
 * the cheapest thing that keeps that affordable.
 *
 * Colours are grim, dirty and low-saturation on purpose — this is the early
 * game, where the room is only slightly wrong.
 */

const materials: Material[] = [];

function standard(options: {
  color: string;
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
}): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: new Color(options.color),
    roughness: options.roughness ?? 0.9,
    metalness: options.metalness ?? 0,
  });
  if (options.emissive) {
    material.emissive = new Color(options.emissive);
    material.emissiveIntensity = options.emissiveIntensity ?? 1;
  }
  materials.push(material);
  return material;
}

export const MATERIALS = {
  felt: standard({ color: '#16241c', roughness: 1 }),
  rail: standard({ color: '#1c1310', roughness: 0.75 }),
  wood: standard({ color: '#1a1210', roughness: 0.85 }),
  floor: standard({ color: '#0c0a09', roughness: 1 }),
  chair: standard({ color: '#1e1713', roughness: 0.9 }),

  skin: standard({ color: '#7d6250', roughness: 0.88 }),
  cloth: standard({ color: '#2e2924', roughness: 1 }),
  clothAlt: standard({ color: '#38302a', roughness: 1 }),
  clothThird: standard({ color: '#26282a', roughness: 1 }),

  robe: standard({ color: '#131011', roughness: 1 }),
  hoodVoid: standard({ color: '#000000', roughness: 1 }),
  eye: standard({ color: '#2a0705', emissive: '#d82814', emissiveIntensity: 6 }),

  brass: standard({ color: '#6b5327', roughness: 0.45, metalness: 0.75 }),
  lampGlow: standard({ color: '#120e0a', emissive: '#ffc98a', emissiveIntensity: 1.5 }),
} as const;

/** Chip colours by denomination band, darkest (cheapest) first. */
export const CHIP_COLOURS = ['#8d8478', '#7a2a22', '#2c4a63', '#3f2f5c', '#6b5327'] as const;

export function disposeMaterials(): void {
  for (const material of materials) material.dispose();
  materials.length = 0;
}
