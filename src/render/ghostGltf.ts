import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Loading a real ghost model.
 *
 * Four attempts at building a convincing face out of procedural geometry got
 * closer each time and none of them good. The shape of a head is a lot of
 * specific, irregular detail, and displacement functions are a poor way to
 * author it — every fix to the brow moved the cheekbones, and none of it was
 * converging. A modelled `.glb` from someone who sculpts for a living is a
 * better result in a fraction of the time, and Three.js loads them natively.
 *
 * So this wraps a glTF: it finds the model's animations, works out which is
 * an idle, a walk and a scream, scales the thing to human height wherever the
 * artist left it, and exposes the same small interface the rest of the game
 * already uses. Drop a file in and it takes over; leave the slot empty and
 * the procedural ghost carries on as before.
 *
 * The matching is deliberately forgiving about names. Model libraries disagree
 * about whether the clip is called "Walk", "walking", "Armature|Walk" or
 * "mixamo.com", so it looks for substrings and falls back on clip order and
 * duration rather than refusing to work with a file whose naming it dislikes.
 */

/** Where the model lives, served from `public/`. */
export const GHOST_MODEL_URL = '/assets/ghost.glb';

/** What the ghost is doing, which decides the clip that plays. */
export type GhostAction = 'idle' | 'walk' | 'chase' | 'attack';

export interface LoadedGhost {
  /** Add this to the scene. */
  object: THREE.Object3D;
  /** Advance animation and blending. */
  update(dt: number): void;
  /** Pick the clip. Crossfades rather than cutting. */
  setAction(action: GhostAction): void;
  /** World-space height of the head, so the jumpscare can frame the face. */
  headWorldY(): number;
  /** Fade the whole figure, 0..1. */
  setPresence(v: number): void;
  dispose(): void;
}

/** Clip names we recognise, in priority order, per action. */
const CLIP_HINTS: Record<GhostAction, string[]> = {
  idle: ['idle', 'breathing', 'stand', 'tpose', 'rest'],
  walk: ['walk', 'shamble', 'limp', 'creep', 'stalk'],
  chase: ['run', 'sprint', 'chase', 'charge'],
  attack: ['attack', 'scream', 'roar', 'yell', 'lunge', 'strike', 'kill'],
};

/**
 * Try to load the model.
 *
 * Resolves to null rather than throwing when the file is absent, because a
 * missing model is the normal state until one is dropped in — the caller
 * falls back to the procedural ghost and the game keeps working.
 */
export async function loadGhostModel(
  url = GHOST_MODEL_URL,
): Promise<LoadedGhost | null> {
  const loader = new GLTFLoader();

  let gltf;
  try {
    gltf = await loader.loadAsync(url);
  } catch {
    // No model yet, or a file that will not parse. Either way, carry on.
    return null;
  }

  const root = gltf.scene;

  /*
   * Normalise the scale and footing.
   *
   * Exporters disagree wildly about units — a model may arrive a centimetre
   * tall or a hundred metres — and about where the origin sits. Measuring the
   * bounding box and scaling to a known height means any model works without
   * hand-tuning, and dropping it so its feet touch y = 0 means it stands on
   * the floor rather than hovering or sinking.
   */
  const TARGET_HEIGHT = 1.78;
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  if (size.y > 1e-4) {
    const s = TARGET_HEIGHT / size.y;
    root.scale.setScalar(s);
  }
  root.updateMatrixWorld(true);
  const grounded = new THREE.Box3().setFromObject(root);
  root.position.y -= grounded.min.y;

  /*
   * Find the head.
   *
   * The jumpscare has to aim the camera at the face, and hard-coding a height
   * breaks the moment the model changes. A rigged humanoid almost always has
   * a bone with "head" in its name; failing that, the topmost bone is a good
   * guess, and failing that the bounding box is a serviceable fallback.
   */
  // Declared as a mutable pair so the traverse callback's assignments do not
  // get narrowed away — inside a closure TypeScript cannot see that these are
  // written, and infers `never` at the use site.
  const found: { head: THREE.Object3D | null; top: THREE.Object3D | null } =
    { head: null, top: null };
  let topY = -Infinity;
  root.traverse((o) => {
    const n = o.name.toLowerCase();
    if (!found.head && (n.includes('head') || n.endsWith('_h'))) found.head = o;
    if ((o as THREE.Bone).isBone) {
      const p = o.getWorldPosition(new THREE.Vector3());
      if (p.y > topY) { topY = p.y; found.top = o; }
    }
    // Shadows off: the ghost is translucent and self-shadowing looks wrong.
    if ((o as THREE.Mesh).isMesh) {
      const m = o as THREE.Mesh;
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
    }
  });
  const head: THREE.Object3D | null = found.head ?? found.top;

  // --- Animation. ---
  const mixer = new THREE.AnimationMixer(root);
  const clips = gltf.animations ?? [];

  const pick = (action: GhostAction): THREE.AnimationClip | null => {
    for (const hint of CLIP_HINTS[action]) {
      const found = clips.find((c) => c.name.toLowerCase().includes(hint));
      if (found) return found;
    }
    return null;
  };

  const actions: Partial<Record<GhostAction, THREE.AnimationAction>> = {};
  for (const name of ['idle', 'walk', 'chase', 'attack'] as GhostAction[]) {
    const clip = pick(name);
    if (clip) actions[name] = mixer.clipAction(clip);
  }

  /*
   * Fill the gaps.
   *
   * A model with one animation is common, and a model with none is possible.
   * Rather than standing frozen, every missing action falls back to whatever
   * the file does have — a ghost that walks with its idle clip still reads
   * far better than one that slides.
   */
  const anyClip = clips.length > 0 ? mixer.clipAction(clips[0]) : null;
  for (const name of ['idle', 'walk', 'chase', 'attack'] as GhostAction[]) {
    if (!actions[name]) {
      actions[name] = actions.idle ?? actions.walk ?? anyClip ?? undefined;
    }
  }

  let current: THREE.AnimationAction | null = null;
  let currentName: GhostAction | null = null;

  const setAction = (name: GhostAction) => {
    if (name === currentName) return;
    const next = actions[name];
    currentName = name;
    if (!next || next === current) return;

    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    // An attack plays once and holds; everything else loops.
    if (name === 'attack') {
      next.setLoop(THREE.LoopOnce, 1);
      next.clampWhenFinished = true;
    } else {
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = false;
    }

    if (current) next.crossFadeFrom(current, 0.25, false);
    next.play();
    current = next;
  };

  setAction('idle');

  // --- Presence: fade every material together. ---
  const materials: THREE.Material[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const list = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of list) {
      mat.transparent = true;
      materials.push(mat);
    }
  });

  return {
    object: root,

    update(dt) { mixer.update(dt); },

    setAction,

    headWorldY() {
      if (head) return head.getWorldPosition(new THREE.Vector3()).y;
      const b = new THREE.Box3().setFromObject(root);
      // Just below the crown, which is roughly where a face sits.
      return b.max.y - (b.max.y - b.min.y) * 0.08;
    },

    setPresence(v) {
      const a = Math.max(0, Math.min(1, v));
      for (const m of materials) m.opacity = a;
    },

    dispose() {
      mixer.stopAllAction();
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry.dispose();
        const list = Array.isArray(m.material) ? m.material : [m.material];
        for (const mat of list) mat.dispose();
      });
    },
  };
}
