import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Mansion, Solid } from '../game/map.js';
import { assetUrl } from './assets.js';
import { instanceAt, placement } from './instancing.js';
import type { Stage } from './staging.js';

/**
 * The house's shell — walls, floors, ceilings — in the `mansion_shell` design.
 *
 * The kit in `public/assets/mansion_shell/` is modular: 2m wall panels 2.8m
 * tall, a doorway panel with a 1m opening, 2m carpet tiles, 2.4m ceiling
 * tiles and a 60cm pillar. The house is laid out in walls of any length, 3.2m
 * tall, with doorways 1.8m wide so a chase fits through at a run, so the
 * panels themselves would leave gaps and seams everywhere. Instead the shell
 * is built to the house's own walls and dressed the way the kit is: its
 * textures at the kit's own scale, mapped in world space so they run
 * unbroken from one wall to the next, and its trim — a skirting board, a
 * crown moulding at the ceiling, a frame around every doorway and wall over
 * the top of it — at the kit's dimensions. Only the pillar is used as is; the
 * verandah's columns are exactly its size.
 *
 * The kit's walls are painted cream. Here the paint is dark ash: the texture
 * keeps its stains and brushwork but loses its colour. The ceiling is the
 * kit's tiles without its light panels — every light in the house is a torch.
 */

const TEX = (name: string) => assetUrl(`assets/mansion_shell/textures/${name}.jpg`);
const PILLAR_URL = assetUrl('assets/mansion_shell/kit/Pillar_60.glb');

/** Metres per repeat of each texture, as the kit maps them. */
const PAINT_REPEAT = 1.5;
const TRIM_REPEAT = 1.0;
const CARPET_REPEAT = 1.0;
const CEILING_REPEAT = 1.2;

/** Dark ash: what the paint texture's brightness is multiplied by. */
const ASH = 0x58585a;

const CEILING_Y = 3.0;
/** Skirting board: 13.2cm tall, 1.6cm proud of the wall, as in the kit. */
const SKIRT_H = 0.132;
const TRIM_PROUD = 0.016;
/** Crown moulding, 16cm deep, under the ceiling. */
const CROWN_H = 0.16;
/** Doorways: the opening's height, and the frame's width and depth. */
export const DOORWAY_H = 2.5;
const CASING_W = 0.08;
const CASING_PROUD = 0.02;

type Track = <T extends { dispose(): void }>(o: T) => T;

/**
 * Give a geometry texture coordinates taken from where it is in the world.
 *
 * Every face is mapped by the two world axes it lies along, so a texture
 * runs on unbroken from one wall onto the next, and two ceilings that
 * overlap carry the same pattern in the same place — which is what keeps
 * their overlap from flickering.
 */
function worldUV(g: THREE.BufferGeometry, repeat: number): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
    let u: number, v: number;
    // Signed so that no face reads mirrored from the side it is seen from.
    if (Math.abs(nx) > 0.5) { u = nx > 0 ? -z : z; v = y; }
    else if (Math.abs(nz) > 0.5) { u = nz > 0 ? x : -x; v = y; }
    else { u = x; v = ny > 0 ? -z : z; }
    uv.setXY(i, u / repeat, v / repeat);
  }
  return g;
}

/** An axis-aligned box in world space: centre on the floor plane, bottom and size. */
function box(
  x: number, z: number, y0: number, sx: number, sy: number, sz: number, repeat: number,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(x, y0 + sy / 2, z);
  return worldUV(g, repeat);
}

/** A horizontal sheet at height y, facing up or down. */
function sheet(
  x: number, z: number, y: number, sx: number, sz: number, up: boolean, repeat: number,
): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(sx, sz);
  g.rotateX(up ? -Math.PI / 2 : Math.PI / 2);
  g.translate(x, y, z);
  return worldUV(g, repeat);
}

/** Load the kit's albedo, normal and roughness maps for one surface. */
function textureSet(loader: THREE.TextureLoader, name: string, track: Track) {
  const load = (kind: string, color: boolean) => {
    const t = track(loader.load(TEX(`${name}_${kind}`)));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return { map: load('albedo', true), normalMap: load('normal', false), roughnessMap: load('rough', false) };
}

/**
 * Take the colour out of a material's texture, keeping its light and dark.
 *
 * The material's own colour then paints it whatever shade it should be. This
 * is how the cream wall paint becomes ash without losing its stains.
 */
function desaturate(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        float ashLum = dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
        diffuseColor *= vec4( vec3( ashLum ), sampledDiffuseColor.a );
      #endif`,
    );
  };
}

export function buildShell(scene: THREE.Scene, mansion: Mansion, stage: Stage, track: Track): void {
  const loader = new THREE.TextureLoader();

  const paint = track(new THREE.MeshStandardMaterial({
    ...textureSet(loader, 'wall_paint', track), color: ASH, metalness: 0,
  }));
  desaturate(paint);
  const trim = track(new THREE.MeshStandardMaterial({
    ...textureSet(loader, 'wood_trim', track), metalness: 0,
  }));
  const carpet = track(new THREE.MeshStandardMaterial({
    ...textureSet(loader, 'carpet_brown', track), metalness: 0,
  }));
  const ceiling = track(new THREE.MeshStandardMaterial({
    // Dulled: the tiles are pale, and overhead they caught every torch.
    ...textureSet(loader, 'ceiling_tiles', track), color: 0x7a7a7a, metalness: 0,
  }));

  const paintParts: THREE.BufferGeometry[] = [];
  const trimParts: THREE.BufferGeometry[] = [];

  // --- Walls, each with a skirting board and a crown along both faces. ---
  for (const s of mansion.solids) {
    if (s.kind !== 'wall') continue;
    paintParts.push(box(s.x, s.z, s.y0, s.hx * 2, s.y1 - s.y0, s.hz * 2, PAINT_REPEAT));
    const alongX = s.hx >= s.hz;
    const len = (alongX ? s.hx : s.hz) * 2;
    const half = alongX ? s.hz : s.hx;
    for (const side of [-1, 1]) {
      const off = side * (half + TRIM_PROUD / 2);
      for (const [y0, h] of [[0, SKIRT_H], [CEILING_Y - CROWN_H, CROWN_H]]) {
        trimParts.push(alongX
          ? box(s.x, s.z + off, y0, len, h, TRIM_PROUD, TRIM_REPEAT)
          : box(s.x + off, s.z, y0, TRIM_PROUD, h, len, TRIM_REPEAT));
      }
    }
  }

  /*
   * Doorways: wall over the top, as the kit's doorway panel has, and a
   * frame. The opening stops at 2.5m — clear of the tallest thing that goes
   * through it, the ghost, at 2.2m — and the frame wraps the opening on both
   * faces and lines its sides and head.
   */
  const depth = 0.32; // the house's wall thickness
  for (const d of mansion.doors) {
    const alongX = d.axis === 'x';
    // Place a box given its extent along the wall and across it.
    const put = (
      parts: THREE.BufferGeometry[], along: number, across: number, y0: number,
      lenAlong: number, h: number, lenAcross: number, repeat: number,
    ) => parts.push(alongX
      ? box(d.x + along, d.z + across, y0, lenAlong, h, lenAcross, repeat)
      : box(d.x + across, d.z + along, y0, lenAcross, h, lenAlong, repeat));

    put(paintParts, 0, 0, DOORWAY_H, d.half * 2, 3.2 - DOORWAY_H, depth, PAINT_REPEAT);
    // Linings: the two jambs and the head, inside the opening.
    for (const side of [-1, 1]) {
      put(trimParts, side * (d.half - 0.006), 0, 0, 0.012, DOORWAY_H, depth + 0.004, TRIM_REPEAT);
    }
    put(trimParts, 0, 0, DOORWAY_H - 0.012, d.half * 2, 0.012, depth + 0.004, TRIM_REPEAT);
    // Casings on each face: two uprights and a head across the top.
    for (const face of [-1, 1]) {
      const across = face * (depth / 2 + CASING_PROUD / 2);
      for (const side of [-1, 1]) {
        put(trimParts, side * (d.half + CASING_W / 2), across, 0,
          CASING_W, DOORWAY_H + CASING_W, CASING_PROUD, TRIM_REPEAT);
      }
      put(trimParts, 0, across, DOORWAY_H, d.half * 2, CASING_W, CASING_PROUD, TRIM_REPEAT);
      // The crown runs on across the wall over the door.
      put(trimParts, 0, face * (depth / 2 + TRIM_PROUD / 2), CEILING_Y - CROWN_H,
        d.half * 2, CROWN_H, TRIM_PROUD, TRIM_REPEAT);
    }
  }

  // --- Floors: carpet through the house, bare flags outdoors. ---
  const { minX, maxX, maxZ } = mansion.bounds;
  // The verandah and the courtyard are open to the weather: no carpet there.
  const indoorMinZ = -29;
  const carpetGeo = sheet((minX + maxX) / 2, (indoorMinZ + maxZ) / 2, 0,
    maxX - minX, maxZ - indoorMinZ, true, CARPET_REPEAT);
  const carpetMesh = new THREE.Mesh(track(carpetGeo), carpet);
  carpetMesh.receiveShadow = true;
  scene.add(carpetMesh);

  const flags = track(new THREE.MeshStandardMaterial({ color: 0x2d2b28, roughness: 0.95 }));
  const c = mansion.courtyard;
  const outdoor = mergeGeometries([
    // Everything outside the carpet, a little below it.
    sheet(0, 0, -0.01, 160, 160, true, 1),
    // The courtyard, a little above it.
    sheet((c.minX + c.maxX) / 2, (c.minZ + c.maxZ) / 2, 0.004,
      c.maxX - c.minX, c.maxZ - c.minZ, true, 1),
  ]);
  const outdoorMesh = new THREE.Mesh(track(outdoor), flags);
  outdoorMesh.receiveShadow = true;
  scene.add(outdoorMesh);

  // --- Ceilings. They cast shadows: the roof, to the moon. ---
  const ceilParts: THREE.BufferGeometry[] = [];
  // One per room and corridor, from the plan, so none overhangs the courtyard.
  for (const r of mansion.ceilings) {
    ceilParts.push(sheet((r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2, CEILING_Y,
      r.maxX - r.minX, r.maxZ - r.minZ, false, CEILING_REPEAT));
  }

  for (const [parts, mat, casts] of [
    [paintParts, paint, true], [trimParts, trim, false], [ceilParts, ceiling, true],
  ] as const) {
    const geo = track(mergeGeometries(parts as THREE.BufferGeometry[]));
    for (const p of parts) p.dispose();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = casts;
    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  buildPillars(scene, mansion.solids.filter((s) => s.model === 'pillar'), paint, trim, stage, track);
}

/**
 * The verandah's columns, which are the kit's 60cm pillar exactly.
 *
 * Painted with the same ash and trim as the walls rather than the model's
 * own cream, and drawn instanced. A plain box stands in for each until the
 * model is ready.
 */
function buildPillars(
  scene: THREE.Scene, pillars: Solid[],
  paint: THREE.Material, trim: THREE.Material, stage: Stage, track: Track,
): void {
  if (pillars.length === 0) return;
  const stand = track(new THREE.BoxGeometry(1, 1, 1));
  const standIns = pillars.map((s) => {
    const box = new THREE.Mesh(stand, paint);
    box.scale.set(s.hx * 2, s.y1, s.hz * 2);
    box.position.set(s.x, s.y1 / 2, s.z);
    scene.add(box);
    return box;
  });

  stage.wait(new GLTFLoader().loadAsync(PILLAR_URL).then((gltf) => {
    const source = gltf.scene;
    source.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const own = mesh.material as THREE.MeshStandardMaterial;
      mesh.material = own.name === 'M_trim' ? trim : paint;
      // The model's own cream textures are never shown.
      for (const t of [own.map, own.normalMap, own.roughnessMap]) t?.dispose();
      own.dispose();
      track(mesh.geometry);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
    // The model stands on its corner, 0.6m square and 2.8m tall.
    const set = instanceAt(source, pillars.map((s) =>
      placement(s.x - s.hx, 0, s.z - s.hz, 0, s.hx * 2 / 0.6, s.y1 / 2.8, s.hz * 2 / 0.6)), track);
    stage.hold(set);
    scene.add(set);
    for (const b of standIns) stage.standIn(b);
  }).catch((err) => console.warn('pillar model failed to load; keeping box columns', err)));
}
