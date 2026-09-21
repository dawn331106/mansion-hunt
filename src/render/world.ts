import * as THREE from 'three';
import type { Mansion, Solid } from '../game/map.js';

/**
 * Building the house in three dimensions.
 *
 * With no minimap, the look of a room is the only thing telling a player where
 * they are, so every room gets its own wall tint, floor treatment and light
 * colour. That is not decoration — it is the navigation system, and it has to
 * be legible at a glance in near-darkness.
 *
 * Everything is lit with baked-feel static lights rather than realtime shadow
 * casters everywhere: a handful of shadow-casting lights and a lot of cheap
 * ones reads far better than uniform flat lighting and still holds 60fps.
 */

/** Per-room palette. Wall, floor, and the colour of that room's lamp. */
const ROOM_STYLE: Record<string, { wall: number; floor: number; light: number; intensity: number }> = {
  courtyard:       { wall: 0x6e6154, floor: 0x585044, light: 0x8fa4c8, intensity: 16 },
  'corridor-s':    { wall: 0x6a5f52, floor: 0x554c42, light: 0xd8a870, intensity: 14 },
  'corridor-n':    { wall: 0x655a60, floor: 0x50474e, light: 0xb49ad0, intensity: 14 },
  'corridor-w':    { wall: 0x5e626c, floor: 0x4a4e58, light: 0x92a8cc, intensity: 14 },
  'corridor-e':    { wall: 0x6e6050, floor: 0x574c40, light: 0xe0a060, intensity: 14 },
  verandah:        { wall: 0x7a6552, floor: 0x655546, light: 0xffb066, intensity: 26 },
  kitchen:         { wall: 0x6e5843, floor: 0x58493a, light: 0xff9a4a, intensity: 32 },
  pantry:          { wall: 0x5c5346, floor: 0x4a423a, light: 0xa8946c, intensity: 14 },
  dining:          { wall: 0x6b5a4e, floor: 0x554940, light: 0xffa860, intensity: 24 },
  puja:            { wall: 0x82564c, floor: 0x63463c, light: 0xff7a48, intensity: 30 },
  library:         { wall: 0x5a5648, floor: 0x49463c, light: 0xc0a878, intensity: 18 },
  'bedroom-south': { wall: 0x5a5e68, floor: 0x4a4d56, light: 0x8fa4c4, intensity: 22 },
  'bedroom-north': { wall: 0x635a6a, floor: 0x4e4856, light: 0xae8ec4, intensity: 22 },
};

const DEFAULT_STYLE = { wall: 0x615b52, floor: 0x4c4741, light: 0xb0a090, intensity: 18 };

function styleFor(room: string | undefined) {
  return (room && ROOM_STYLE[room]) || DEFAULT_STYLE;
}

export interface WorldView {
  scene: THREE.Scene;
  /** The key mesh, hidden once taken. */
  keyMesh: THREE.Object3D;
  /** The gate, which visibly opens once unlocked. */
  gateMesh: THREE.Object3D;
  /** Almirah doors, keyed by spot id, so they can swing open. */
  hidingDoors: Map<string, THREE.Object3D>;
  /** Room doors, keyed by door id, so they can swing as people pass. */
  roomDoors: Map<string, THREE.Object3D>;
  dispose(): void;
}

export function buildWorld(mansion: Mansion): WorldView {
  const scene = new THREE.Scene();

  // A deep, cold fog. It hides the far walls, which both sells the dark and
  // keeps the draw distance honest.
  scene.fog = new THREE.FogExp2(0x0a0c14, 0.030);
  scene.background = new THREE.Color(0x090b12);

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

  // --- Floor. One plane per room region so the tint changes underfoot. ---
  const floorGeo = track(new THREE.PlaneGeometry(1, 1));
  for (const r of mansion.rooms) {
    const st = styleFor(r.name);
    const mat = track(new THREE.MeshStandardMaterial({
      color: st.floor, roughness: 0.95, metalness: 0.0,
    }));
    const m = new THREE.Mesh(floorGeo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(r.x, 0, r.z);
    m.scale.set(20, 20, 1);
    m.receiveShadow = true;
    scene.add(m);
  }

  // A single dark plane under everything, to catch gaps between room tiles.
  const baseMat = track(new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 1 }));
  const base = new THREE.Mesh(floorGeo, baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.y = -0.02;
  base.scale.set(140, 140, 1);
  base.receiveShadow = true;
  scene.add(base);

  // --- Ceiling, everywhere except the courtyard, which is open to the sky.
  //     Sized per room rather than one blanket square: an oversized ceiling
  //     overhangs the courtyard and reads as a dark wedge hanging in mid-air,
  //     which is both ugly and confusing when the courtyard is supposed to be
  //     the one place you can see the sky. ---
  const ceilMat = track(new THREE.MeshStandardMaterial({ color: 0x2c2822, roughness: 1 }));
  const CEIL_SIZE: Record<string, [number, number]> = {
    'corridor-s': [56, 7],
    'corridor-n': [56, 7],
    'corridor-w': [7, 44],
    'corridor-e': [7, 44],
    verandah: [56, 10],
    puja: [30, 10],
    library: [30, 10],
    kitchen: [24, 12],
    pantry: [24, 10],
    dining: [24, 12],
    'bedroom-south': [24, 22],
    'bedroom-north': [24, 22],
  };
  for (const r of mansion.rooms) {
    const size = CEIL_SIZE[r.name];
    if (!size) continue;
    const m = new THREE.Mesh(floorGeo, ceilMat);
    m.rotation.x = Math.PI / 2;
    m.position.set(r.x, 3.0, r.z);
    m.scale.set(size[0], size[1], 1);
    scene.add(m);
  }

  // --- Solids. Walls and furniture, tinted by the room they belong to. ---
  const boxGeo = track(new THREE.BoxGeometry(1, 1, 1));
  const matCache = new Map<string, THREE.Material>();

  for (const s of mansion.solids) {
    const st = styleFor(s.room);
    const isFurniture = s.kind === 'furniture';
    // Furniture reads darker than the wall behind it, so silhouettes separate.
    const color = isFurniture ? darken(st.wall, 0.62) : st.wall;
    const key = `${color}:${isFurniture}`;
    let mat = matCache.get(key);
    if (!mat) {
      mat = track(new THREE.MeshStandardMaterial({
        color,
        roughness: isFurniture ? 0.7 : 0.96,
        metalness: 0.02,
      }));
      matCache.set(key, mat);
    }
    scene.add(makeSolid(boxGeo, mat, s));
  }

  // --- Lighting. ---
  // Low ambient: enough to read a doorway and not walk into walls, never
  // enough to feel safe. Below roughly this level the house stops being
  // frightening and simply becomes an unplayable black screen.
  scene.add(new THREE.AmbientLight(0x2a3548, 1.5));

  // A cold hemisphere fill, so floors and ceilings separate instead of
  // merging into one void. This is what makes the dark legible.
  scene.add(new THREE.HemisphereLight(0x5a6a88, 0x201c18, 0.9));

  // Moonlight into the open courtyard. The one genuinely bright place, which
  // makes crossing it a decision rather than a default.
  const moon = new THREE.DirectionalLight(0xa8c0e8, 2.6);
  moon.position.set(6, 18, -4);
  moon.target.position.set(0, 0, 0);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.left = -16;
  moon.shadow.camera.right = 16;
  moon.shadow.camera.top = 14;
  moon.shadow.camera.bottom = -14;
  moon.shadow.camera.far = 60;
  scene.add(moon);
  scene.add(moon.target);

  /*
   * Lamps.
   *
   * One light per room was enough when rooms were eight metres across; in a
   * house this size a single point light leaves most of a room unlit and the
   * corridors pitch black, and with no map a corridor you cannot see is a
   * corridor you cannot navigate. Long rooms get a lamp at each end.
   */
  const LAMP_SPREAD: Record<string, [number, number][]> = {
    'corridor-s': [[-18, 0], [0, 0], [18, 0]],
    'corridor-n': [[-18, 0], [0, 0], [18, 0]],
    'corridor-w': [[0, -14], [0, 0], [0, 14]],
    'corridor-e': [[0, -14], [0, 0], [0, 14]],
    verandah: [[-16, 0], [0, 0], [16, 0]],
    puja: [[-8, 0], [6, 0]],
    library: [[-6, 0], [8, 0]],
    kitchen: [[0, -5], [0, 5]],
    dining: [[0, -5], [0, 5]],
    'bedroom-south': [[0, -6], [0, 5]],
    'bedroom-north': [[0, -5], [0, 6]],
  };
  for (const r of mansion.rooms) {
    const st = styleFor(r.name);
    const offsets = LAMP_SPREAD[r.name] ?? [[0, 0]];
    // The courtyard is lit by the moon; it gets only a faint warm spill.
    const scale = r.name === 'courtyard' ? 0.35 : 1;
    for (const [ox, oz] of offsets) {
      const l = new THREE.PointLight(st.light, st.intensity * scale, 17, 1.35);
      l.position.set(r.x + ox, 2.6, r.z + oz);
      scene.add(l);
    }
  }

  // --- The key: a small glowing object, the one thing worth crossing the house for. ---
  const keyMesh = makeKey(track);
  // Placed for real by the frame loop, from the match state.
  keyMesh.position.set(0, 0.5, 0);
  scene.add(keyMesh);

  // --- The gate. ---
  const gateMat = track(new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.8 }));
  const gateMesh = new THREE.Mesh(track(new THREE.BoxGeometry(2.4, 2.6, 0.18)), gateMat);
  gateMesh.position.set(mansion.exit.x, 1.3, mansion.exit.z);
  scene.add(gateMesh);

  /**
   * Room doors: a leaf hinged in each opening.
   *
   * The leaf is never collidable — a door that could shut you in would make
   * the ghost unbeatable — so this is purely what you see and hear. It still
   * earns its place: a door standing open where you left one closed is
   * information, and a swinging leaf tells you which way something went.
   */
  const roomDoors = new Map<string, THREE.Object3D>();
  const doorGeo = track(new THREE.BoxGeometry(1, 2.25, 0.07));
  for (const d of mansion.doors) {
    const st = styleFor(d.room);
    const mat = track(new THREE.MeshStandardMaterial({
      color: darken(st.wall, 0.42), roughness: 0.75,
    }));
    // A pivot at the hinge, with the leaf offset so it swings about its edge.
    const pivot = new THREE.Object3D();
    pivot.position.set(d.x, 1.15, d.z);
    // An 'x' wall runs east-west, so its door faces north-south.
    pivot.rotation.y = d.axis === 'x' ? 0 : Math.PI / 2;

    const leaf = new THREE.Mesh(doorGeo, mat);
    const w = d.half * 2 * 0.96;
    leaf.scale.x = w;
    leaf.position.x = w / 2;
    leaf.castShadow = true;
    pivot.add(leaf);
    // Hinge on one side of the opening.
    pivot.position.x += d.axis === 'x' ? -d.half : 0;
    pivot.position.z += d.axis === 'z' ? -d.half : 0;
    // Start ajar, which reads as a lived-in house rather than a sealed one.
    pivot.rotation.y += d.swing * (0.35 + Math.random() * 0.5);
    scene.add(pivot);
    roomDoors.set(d.id, pivot);
  }

  // --- Hiding spots: almirah bodies and doors, plus a marker for under-spots. ---
  const hidingDoors = new Map<string, THREE.Object3D>();
  for (const h of mansion.hidingSpots) {
    if (h.kind === 'almirah') {
      const st = styleFor(h.room);
      const bodyMat = track(new THREE.MeshStandardMaterial({ color: darken(st.wall, 0.5), roughness: 0.65 }));
      const body = new THREE.Mesh(track(new THREE.BoxGeometry(1.1, 2.1, 0.7)), bodyMat);
      body.position.set(h.x, 1.05, h.z);
      body.rotation.y = -h.facing;
      body.castShadow = true;
      scene.add(body);

      // The door is a child pivoted at its hinge so it can swing.
      const pivot = new THREE.Object3D();
      pivot.position.set(h.x, 1.05, h.z);
      pivot.rotation.y = -h.facing;
      const doorMat = track(new THREE.MeshStandardMaterial({ color: darken(st.wall, 0.4), roughness: 0.6 }));
      const door = new THREE.Mesh(track(new THREE.BoxGeometry(1.0, 1.95, 0.06)), doorMat);
      door.position.set(0.5, 0, 0.38);
      door.geometry.translate(-0.5, 0, 0);
      pivot.add(door);
      scene.add(pivot);
      hidingDoors.set(h.id, pivot);
    }
  }

  return {
    scene,
    keyMesh,
    gateMesh,
    hidingDoors,
    roomDoors,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

function makeSolid(geo: THREE.BoxGeometry, mat: THREE.Material, s: Solid): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  const height = s.y1 - s.y0;
  m.scale.set(s.hx * 2, height, s.hz * 2);
  m.position.set(s.x, s.y0 + height / 2, s.z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * The key: a small brass shape with its own light.
 *
 * It glows because in a house this dark an unlit prop on a shelf is simply
 * never found, and a survivor wandering past the win condition is not tension,
 * it is a broken objective.
 */
function makeKey(track: <T extends { dispose(): void }>(o: T) => T): THREE.Object3D {
  const g = new THREE.Group();
  const mat = track(new THREE.MeshStandardMaterial({
    color: 0xd9a441, emissive: 0x7a4a10, emissiveIntensity: 1.4, roughness: 0.35, metalness: 0.8,
  }));
  const shaft = new THREE.Mesh(track(new THREE.CylinderGeometry(0.025, 0.025, 0.34, 8)), mat);
  shaft.rotation.z = Math.PI / 2;
  g.add(shaft);
  const bow = new THREE.Mesh(track(new THREE.TorusGeometry(0.08, 0.022, 8, 16)), mat);
  bow.position.x = -0.2;
  bow.rotation.y = Math.PI / 2;
  g.add(bow);
  const bit = new THREE.Mesh(track(new THREE.BoxGeometry(0.06, 0.09, 0.02)), mat);
  bit.position.set(0.14, -0.05, 0);
  g.add(bit);

  const glow = new THREE.PointLight(0xffb347, 12, 6, 1.6);
  g.add(glow);
  return g;
}

function darken(hex: number, k: number): number {
  const r = Math.floor(((hex >> 16) & 255) * k);
  const g = Math.floor(((hex >> 8) & 255) * k);
  const b = Math.floor((hex & 255) * k);
  return (r << 16) | (g << 8) | b;
}
