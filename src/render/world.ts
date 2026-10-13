import * as THREE from 'three';
import type { Mansion, Solid } from '../game/map.js';
import { loadTables } from './tableModel.js';
import { Stage } from './staging.js';
import { buildShell, DOORWAY_H } from './shell.js';
import { loadProps } from './propModels.js';
import { buildTorches } from './torchModel.js';
import { loadDoors, type DoorwaySlot } from './doorModel.js';
import { loadWardrobes, WARDROBE_PEEK_Z, type WardrobeSlot } from './wardrobeModel.js';

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
  courtyard:       { wall: 0x4f453c, floor: 0x3f3930, light: 0x8fa4c8, intensity: 13 },
  'corridor-s':    { wall: 0x4c443b, floor: 0x3d362f, light: 0xd8a870, intensity: 12 },
  'corridor-n':    { wall: 0x484045, floor: 0x393338, light: 0xb49ad0, intensity: 12 },
  'corridor-w':    { wall: 0x43464d, floor: 0x35383f, light: 0x92a8cc, intensity: 12 },
  'corridor-e':    { wall: 0x4f4539, floor: 0x3e362e, light: 0xe0a060, intensity: 12 },
  'outer-s':       { wall: 0x45403a, floor: 0x37332e, light: 0xc09a70, intensity: 9 },
  'outer-n':       { wall: 0x413c42, floor: 0x343036, light: 0xa08cc0, intensity: 9 },
  'outer-w':       { wall: 0x3e4148, floor: 0x32343a, light: 0x88a0c8, intensity: 9 },
  'outer-e':       { wall: 0x4a4136, floor: 0x3a332b, light: 0xd09858, intensity: 9 },
  'spur-sw':       { wall: 0x474039, floor: 0x39332d, light: 0xc8a070, intensity: 10 },
  'spur-se':       { wall: 0x4a4135, floor: 0x3a332a, light: 0xd8a060, intensity: 10 },
  'spur-nw':       { wall: 0x433e46, floor: 0x35313a, light: 0xa890c8, intensity: 10 },
  'spur-ne':       { wall: 0x46413c, floor: 0x383330, light: 0xc0a078, intensity: 10 },
  'spur-w':        { wall: 0x404349, floor: 0x33353b, light: 0x8fa4c4, intensity: 10 },
  'spur-e':        { wall: 0x4c4338, floor: 0x3c342c, light: 0xdca058, intensity: 10 },
  verandah:        { wall: 0x57483b, floor: 0x483d32, light: 0xffb066, intensity: 20 },
  kitchen:         { wall: 0x4f3f30, floor: 0x3f3429, light: 0xff9a4a, intensity: 26 },
  pantry:          { wall: 0x423b32, floor: 0x352f29, light: 0xa8946c, intensity: 12 },
  store:           { wall: 0x453c33, floor: 0x37302a, light: 0xb08c5c, intensity: 11 },
  washroom:        { wall: 0x3d4448, floor: 0x31363a, light: 0x7ea8b8, intensity: 13 },
  dining:          { wall: 0x4d4038, floor: 0x3d342e, light: 0xffa860, intensity: 19 },
  'music-room':    { wall: 0x4a3c46, floor: 0x3b3038, light: 0xd08cb0, intensity: 16 },
  puja:            { wall: 0x5d3d36, floor: 0x47322b, light: 0xff7a48, intensity: 23 },
  'guest-room':    { wall: 0x454049, floor: 0x37333b, light: 0xa494c4, intensity: 15 },
  library:         { wall: 0x403d33, floor: 0x34322b, light: 0xc0a878, intensity: 14 },
  gallery:         { wall: 0x484440, floor: 0x3a3733, light: 0xd8c098, intensity: 15 },
  'attic-stair':   { wall: 0x3c3934, floor: 0x302e2a, light: 0x98865c, intensity: 10 },
  study:           { wall: 0x424038, floor: 0x35332d, light: 0xb8a070, intensity: 14 },
  'bedroom-south': { wall: 0x40434a, floor: 0x35373d, light: 0x8fa4c4, intensity: 17 },
  'bedroom-north': { wall: 0x47404c, floor: 0x38333d, light: 0xae8ec4, intensity: 17 },
  'bedroom-east':  { wall: 0x453f44, floor: 0x373237, light: 0x9c94c0, intensity: 17 },

};

const DEFAULT_STYLE = { wall: 0x45413b, floor: 0x36332e, light: 0xb0a090, intensity: 14 };

function styleFor(room: string | undefined) {
  return (room && ROOM_STYLE[room]) || DEFAULT_STYLE;
}

export interface WorldView {
  scene: THREE.Scene;
  /** The key mesh, hidden once taken. */
  keyMesh: THREE.Object3D;
  /** The gate, which visibly opens once unlocked. */
  gateMesh: THREE.Object3D;
  /**
   * Almirah doors, keyed by spot id, so they can swing open. Each child is a
   * leaf with its open angle in `userData.openAngle`.
   */
  hidingDoors: Map<string, THREE.Object3D>;
  /** Room doors, keyed by door id, so they can swing as people pass. */
  roomDoors: Map<string, THREE.Object3D>;
  /**
   * The key's glow. Turned down to nothing when the key is taken, never
   * hidden: hiding a light changes how many lights every shader is built
   * for, and the whole house recompiles in the frame the key is picked up.
   */
  keyGlow: THREE.PointLight;
  /** Animate what moves on its own: doors, rocking chairs, flames. */
  update(time: number): void;
  /** Settles once every model has loaded, or failed to. */
  ready(): Promise<void>;
  /** Swap the stand-in boxes for the loaded models. */
  reveal(): void;
  dispose(): void;
}

export function buildWorld(mansion: Mansion): WorldView {
  const scene = new THREE.Scene();

  // A deep, cold fog. It hides the far walls, which both sells the dark and
  // keeps the draw distance honest.
  scene.fog = new THREE.FogExp2(0x06070d, 0.040);
  scene.background = new THREE.Color(0x05060b);

  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };
  // Loaded models wait here, hidden, until the renderer has their shaders ready.
  const stage = new Stage();

  // --- Walls, floors and ceilings, in the mansion_shell design. ---
  buildShell(scene, mansion, stage, track);

  // --- Furniture, tinted by the room it belongs to. ---
  const boxGeo = track(new THREE.BoxGeometry(1, 1, 1));
  const matCache = new Map<string, THREE.Material>();
  const tables: { solid: Solid; standIn: THREE.Object3D }[] = [];
  const propBoxes: THREE.Object3D[] = [];

  for (const s of mansion.solids) {
    // The shell draws the walls and the columns.
    if (s.kind === 'wall' || s.model === 'pillar') continue;
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
    const mesh = makeSolid(boxGeo, mat, s);
    // A table's or an accessory's box stands in until its model arrives.
    if (s.model === 'table') tables.push({ solid: s, standIn: mesh });
    if (s.model === 'prop') propBoxes.push(mesh);
    scene.add(mesh);
  }
  loadTables(scene, tables, stage, track);
  const propView = loadProps(scene, mansion.props, propBoxes, stage, track);

  // --- Lighting. ---
  /*
   * Every light has something you can see making it.
   *
   * There used to be an ambient and a hemisphere fill under everything, and a
   * lamp hanging invisible at the middle of each room. Now there are only the
   * torches on the walls, the moon over the courtyard, and the key's own
   * glow. Away from a torch it is properly dark, which is the point: light is
   * somewhere you can be seen, and dark is somewhere you can hide.
   */

  /*
   * Moonlight into the open courtyard — the one genuinely bright place, which
   * makes crossing it a decision rather than a default.
   *
   * A spotlight from the moon itself, not a directional light. A directional
   * light lit every floor in the house: its shadows only covered the
   * courtyard, so beyond them it shone straight through the ceilings and
   * left every room washed in blue from nowhere. A cone from the moon reaches
   * only the courtyard, and the ceilings and walls shadow the rest.
   */
  const MOON_AT = new THREE.Vector3(14, 22, -10);
  const moon = new THREE.SpotLight(0x9db6e0, 2.6, 0, 0.44, 0.35, 0);
  moon.position.copy(MOON_AT);
  moon.target.position.set(0, 0, 0);
  moon.castShadow = true;
  moon.shadow.mapSize.set(2048, 2048);
  moon.shadow.camera.far = 60;
  scene.add(moon);
  scene.add(moon.target);

  // The moon, where the light comes from. Unfogged, or the haze swallows it.
  const moonDisc = new THREE.Mesh(
    track(new THREE.SphereGeometry(1.1, 24, 16)),
    track(new THREE.MeshBasicMaterial({ color: 0xdfe8f8, fog: false })),
  );
  moonDisc.position.copy(MOON_AT);
  scene.add(moonDisc);

  // --- Torches: every other light in the house. ---
  const torchView = buildTorches(scene, mansion.torches, (room) => styleFor(room), stage, track);

  // --- The key: a small glowing object, the one thing worth crossing the house for. ---
  const { key: keyMesh, glow: keyGlow } = makeKey(track);
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
  const doorwaySlots: DoorwaySlot[] = [];
  const doorGeo = track(new THREE.BoxGeometry(1, DOORWAY_H - 0.05, 0.07));
  // Stand-ins share one material each: they are all the same plain wood.
  const doorMat = track(new THREE.MeshStandardMaterial({ color: 0x2a1d14, roughness: 0.75 }));
  for (const d of mansion.doors) {
    const mat = doorMat;
    /*
     * A pair of leaves, hinged at either jamb and meeting in the middle.
     *
     * The doorway's local x runs along the wall and its local +z is the
     * door's +1 swing side: an 'x' wall runs east-west, so that is world +z;
     * a 'z' wall is turned a quarter so that local +z lands on world +x.
     */
    const doorway = new THREE.Object3D();
    doorway.position.set(d.x, 0, d.z);
    doorway.rotation.y = d.axis === 'x' ? 0 : Math.PI / 2;

    const pivots: THREE.Object3D[] = [];
    for (const side of [1, -1]) {
      const pivot = new THREE.Object3D();
      pivot.position.x = -side * d.half;
      pivot.userData.side = side;
      // A plain leaf stands in until the model arrives.
      const leaf = new THREE.Mesh(doorGeo, mat);
      const w = d.half * 0.98;
      leaf.scale.x = w;
      leaf.position.set(side * w / 2, (DOORWAY_H - 0.05) / 2, 0);
      leaf.castShadow = true;
      pivot.add(leaf);
      doorway.add(pivot);
      pivots.push(pivot);
    }
    // Doors start shut. They open as someone reaches them and swing back
    // behind — see `syncDoors` in the renderer.
    scene.add(doorway);
    roomDoors.set(d.id, doorway);
    doorwaySlots.push({ half: d.half, pivots });
  }
  const doorView = loadDoors(scene, doorwaySlots, stage, track);

  // --- Hiding spots: the almirahs. Under-spots are the furniture itself. ---
  const hidingDoors = new Map<string, THREE.Object3D>();
  const wardrobeSlots: WardrobeSlot[] = [];
  const almirahBody = track(new THREE.BoxGeometry(1.2, 2.0, 0.6));
  const almirahLeaf = track(new THREE.BoxGeometry(1.1, 1.85, 0.05).translate(-0.55, 0, 0));
  const almirahMat = track(new THREE.MeshStandardMaterial({ color: 0x24170f, roughness: 0.65 }));
  for (const h of mansion.hidingSpots) {
    if (h.kind === 'almirah') {
      /*
       * Turned so its doors face the way the occupant looks, and set back so
       * the occupant's eye is behind the louvers.
       *
       * The sim's facing is a bearing, forward = (cos f, sin f), and the
       * model's front is +z; turning it by PI/2 - f lines the two up. This
       * used -f, which left every almirah's door at right angles to the view
       * from inside it.
       */
      const holder = new THREE.Group();
      holder.position.set(
        h.x - Math.cos(h.facing) * WARDROBE_PEEK_Z,
        0,
        h.z - Math.sin(h.facing) * WARDROBE_PEEK_Z,
      );
      holder.rotation.y = Math.PI / 2 - h.facing;

      // A plain cupboard stands in until the model arrives.
      const body = new THREE.Mesh(almirahBody, almirahMat);
      body.position.y = 1.0;
      body.castShadow = true;
      holder.add(body);

      // The leaf is a child of `doors`, hinged at its edge so it can swing.
      const doors = new THREE.Object3D();
      const door = new THREE.Mesh(almirahLeaf, almirahMat);
      door.position.set(0.55, 1.0, 0.33);
      door.userData.openAngle = -0.9;
      doors.add(door);
      holder.add(doors);

      scene.add(holder);
      hidingDoors.set(h.id, doors);
      wardrobeSlots.push({ holder, doors, standIns: [body, door] });
    }
  }
  loadWardrobes(scene, wardrobeSlots, stage, track);

  return {
    scene,
    keyMesh,
    gateMesh,
    hidingDoors,
    roomDoors,
    keyGlow,
    update: (time) => {
      doorView.update();
      propView.update(time);
      torchView.update(time);
    },
    ready: () => stage.ready(),
    reveal: () => stage.reveal(),
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
function makeKey(
  track: <T extends { dispose(): void }>(o: T) => T,
): { key: THREE.Object3D; glow: THREE.PointLight } {
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

  const glow = new THREE.PointLight(0xffb347, KEY_GLOW, 6, 1.6);
  g.add(glow);
  return { key: g, glow };
}

/** How bright the key glows while it is there to be taken. */
export const KEY_GLOW = 12;

function darken(hex: number, k: number): number {
  const r = Math.floor(((hex >> 16) & 255) * k);
  const g = Math.floor(((hex >> 8) & 255) * k);
  const b = Math.floor((hex & 255) * k);
  return (r << 16) | (g << 8) | b;
}
