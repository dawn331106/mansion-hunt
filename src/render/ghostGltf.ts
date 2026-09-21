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
  /** Brighten it during a jumpscare, 0..1. */
  setLunge(v: number): void;
  dispose(): void;
}

/** Clip names we recognise, in priority order, per action. */
const CLIP_HINTS: Record<GhostAction, string[]> = {
  idle: ['idle', 'breathing', 'stand', 'tpose', 'rest'],
  walk: ['walk', 'shamble', 'limp', 'creep', 'stalk'],
  chase: ['run', 'sprint', 'chase', 'charge'],
  attack: ['attack', 'scream', 'roar', 'yell', 'lunge', 'strike', 'kill', 'punch'],
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
  /*
   * Fill the gaps, avoiding the bind pose.
   *
   * A model with one animation is common and one with none is possible, so
   * every missing action falls back to whatever the file has. The exception
   * is a T-pose or A-pose clip: those exist for rigging, not for playing, and
   * falling back to one leaves the ghost standing with its arms straight out
   * — which is exactly what the jumpscare did before this, since the model
   * has no attack clip.
   */
  const isBindPose = (c: THREE.AnimationClip) =>
    /t[-_ ]?pose|a[-_ ]?pose|bind/i.test(c.name);
  const usable = clips.filter((c) => !isBindPose(c));
  const anyClip = usable.length > 0 ? mixer.clipAction(usable[0]) : null;
  for (const name of ['idle', 'walk', 'chase', 'attack'] as GhostAction[]) {
    if (!actions[name]) {
      // An attack is better served by the fastest clip available than by an
      // idle: a ghost that stands still as it takes you is not a scare.
      const fallback = name === 'attack'
        ? actions.chase ?? actions.walk ?? actions.idle
        : actions.idle ?? actions.walk;
      actions[name] = fallback ?? anyClip ?? undefined;
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
    /*
     * Everything loops, including the attack.
     *
     * The attack used to play once and clamp, which is right for a dedicated
     * lunge animation and wrong here: this model has no attack clip, so the
     * action falls back to a looping run, and `LoopOnce` stopped it dead on
     * its final frame. With the mixer holding a finished clip the skinned
     * mesh fell back toward its bind pose and the jumpscare showed a figure
     * standing in a T-pose — the single least frightening thing available.
     *
     * A scare lasting four seconds wants continuous motion anyway.
     */
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = false;
    // Run the attack fast; it is a lunge, not a jog.
    next.setEffectiveTimeScale(name === 'attack' ? 1.8 : 1);

    if (current) next.crossFadeFrom(current, 0.25, false);
    next.play();
    current = next;
  };

  setAction('idle');

  /*
   * Make it spectral.
   *
   * The model is a rigged humanoid, not a ghost — free rigged *ghosts* with
   * usable animations are rare, and the rig is what actually matters, because
   * how a figure moves is most of what sells it. What it is wearing is a
   * material problem, and material is cheap to replace.
   *
   * So the original textures are discarded and every mesh gets the same
   * shader: near-black in the body, bright only at the silhouette, with the
   * lower body dissolving toward the floor. In a house lit at the edge of
   * visibility that reads as a shape in the dark rather than as a person in
   * uniform — the detail that would give it away is never lit.
   */
  const spectral = new THREE.ShaderMaterial({
    uniforms: {
      uPresence: { value: 1 },
      uTime: { value: 0 },
      uLunge: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vWorldY;
      #include <skinning_pars_vertex>
      void main() {
        #include <skinbase_vertex>
        #include <beginnormal_vertex>
        #include <skinnormal_vertex>
        #include <defaultnormal_vertex>
        #include <begin_vertex>
        #include <skinning_vertex>
        vNormal = normalize(normalMatrix * objectNormal);
        vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
        vView = normalize(-mv.xyz);
        vWorldY = (modelMatrix * vec4(transformed, 1.0)).y;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform float uPresence;
      uniform float uLunge;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vWorldY;
      void main() {
        vec3 n = normalize(vNormal);
        // A steep key, so the figure has form rather than being a flat cutout.
        float key = clamp(dot(n, normalize(vec3(-0.3, 0.9, 0.42))), 0.0, 1.0);
        // Fresnel is what does the work: bright at the silhouette, hollow in
        // the middle, which reads as a shell of something rather than a body.
        float fres = pow(1.0 - abs(dot(n, normalize(vView))), 2.0);

        vec3 col = mix(vec3(0.02, 0.024, 0.03), vec3(0.42, 0.44, 0.45), key * 0.5);
        col += fres * vec3(0.55, 0.60, 0.62);
        col *= 1.0 + uLunge * 2.2;

        // The legs fade out near the floor, so it drifts rather than walks.
        float hem = smoothstep(0.0, 0.55, vWorldY);
        float alpha = (0.14 + fres * 0.72) * hem;
        gl_FragColor = vec4(col, alpha * uPresence);
      }
    `,
  });
  // `skinning_vertex` needs this flag, or the mesh renders in its bind pose
  // and the animation appears to do nothing at all.
  (spectral as THREE.ShaderMaterial & { skinning?: boolean }).skinning = true;

  const materials: THREE.Material[] = [spectral];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const old = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of old) mat.dispose();
    m.material = spectral;
  });

  /*
   * A shroud over the figure.
   *
   * The spectral shader alone left the model readable as what it is — the
   * webbing, pouches and helmet of a soldier all survive as silhouette, and a
   * translucent soldier is not a ghost. A robe hanging from the shoulders
   * covers the gear entirely and replaces that outline with the one the
   * setting wants, while the rig underneath still does all the moving.
   *
   * It is parented to the chest bone rather than the root, so it swings with
   * the torso and the legs move inside it. Attaching it to the root instead
   * would leave the body walking out from under a stationary cone.
   */
  let chest: THREE.Object3D | null = null;
  root.traverse((o) => {
    const n = o.name.toLowerCase();
    if (!chest && (n.includes('spine') || n.includes('chest'))) chest = o;
  });

  const shroudProfile: THREE.Vector2[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;                 // 0 at the hem, 1 at the shoulders
    // Points must ascend in y, or LatheGeometry builds the surface inside out.
    const y = -1.30 + t * 1.62;
    const k = 1 - t;
    /*
     * Wide enough to actually cover.
     *
     * A first attempt at 0.17 to 0.47 read as a cape hanging behind the
     * figure, with all the webbing and pouches still in plain view — the
     * point of the shroud is that the silhouette underneath stops being
     * legible, and a narrow one does not achieve that.
     */
    const r = 0.30 + Math.pow(k, 1.3) * 0.34;
    shroudProfile.push(new THREE.Vector2(r, y));
  }
  const shroudGeo = new THREE.LatheGeometry(shroudProfile, 28);
  const shroudMat = new THREE.ShaderMaterial({
    uniforms: spectral.uniforms,
    transparent: true,
    // Writes depth, unlike the body: an opaque shroud has to occlude the
    // figure inside it, which is the entire reason it is here.
    depthWrite: true,
    side: THREE.DoubleSide,
    vertexShader: `
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vLocalY;
      void main() {
        vLocalY = position.y;
        vNormal = normalize(normalMatrix * normal);
        vec3 p = position;
        // Cloth moves, and moves most at the hem.
        float amp = max(0.0, -position.y) * 0.075;
        p.x += sin(uTime * 1.6 + position.y * 3.0) * amp;
        p.z += cos(uTime * 1.3 + position.y * 2.5) * amp;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform float uPresence;
      uniform float uLunge;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vLocalY;
      void main() {
        vec3 n = normalize(vNormal);
        float key = clamp(dot(n, normalize(vec3(-0.3, 0.9, 0.42))), 0.0, 1.0);
        float fres = pow(1.0 - abs(dot(n, normalize(vView))), 1.9);
        vec3 col = mix(vec3(0.03, 0.033, 0.036), vec3(0.34, 0.35, 0.34), key * 0.6);
        col += fres * vec3(0.48, 0.52, 0.54);
        col *= 1.0 + uLunge * 1.8;
        // Dissolve into the floor, so it trails rather than ending on a line.
        float hem = smoothstep(-1.30, -0.55, vLocalY);
        /*
         * Opaque enough to hide what is underneath.
         *
         * At 0.16 base alpha the body showed straight through and the shroud
         * was decoration. Cloth this close to the viewer should be nearly
         * solid in the middle and only translucent at its edges.
         */
        gl_FragColor = vec4(col, (0.78 + fres * 0.22) * hem * uPresence);
      }
    `,
  });
  const shroud = new THREE.Mesh(shroudGeo, shroudMat);
  shroud.renderOrder = 3;
  shroud.frustumCulled = false;
  if (chest) {
    /*
     * Undo the bone's own scale.
     *
     * Mixamo rigs carry a scale down the bone chain — often around 0.01 — so
     * a mesh parented to a bone inherits it and vanishes to a speck. Dividing
     * it out keeps the shroud at world scale wherever it is attached.
     */
    const ws = (chest as THREE.Object3D).getWorldScale(new THREE.Vector3());
    shroud.scale.set(1 / (ws.x || 1), 1 / (ws.y || 1), 1 / (ws.z || 1));
    (chest as THREE.Object3D).add(shroud);
  } else {
    shroud.position.y = 1.35;
    root.add(shroud);
  }
  materials.push(shroudMat);

  return {
    object: root,

    update(dt) {
      mixer.update(dt);
      spectral.uniforms.uTime.value += dt;
    },

    setAction,

    headWorldY() {
      if (head) return head.getWorldPosition(new THREE.Vector3()).y;
      const b = new THREE.Box3().setFromObject(root);
      // Just below the crown, which is roughly where a face sits.
      return b.max.y - (b.max.y - b.min.y) * 0.08;
    },

    setPresence(v) {
      spectral.uniforms.uPresence.value = Math.max(0, Math.min(1, v));
    },

    setLunge(v) {
      spectral.uniforms.uLunge.value = Math.max(0, Math.min(1, v));
    },

    dispose() {
      mixer.stopAllAction();
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      for (const m of materials) m.dispose();
      shroudGeo.dispose();
    },
  };
}
