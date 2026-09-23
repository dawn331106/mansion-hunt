import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * The ghost: a rigged, animated 3D figure wearing the supplied face art.
 *
 * The model is built in Blender by `tools/build-ghost.py` and shipped as one
 * GLB: a sculpted head with the artwork projected onto its front, a hood,
 * mantle, tattered shroud and clawed hands, on a 22-bone skeleton with three
 * animations —
 *
 *   Idle   a 4s loop: floating, swaying, the head twitching.
 *   Chase  a 1.6s loop: leaning in, arms reaching, the shroud streaming back.
 *   Lunge  0.8s, played by scrubbing rather than by the clock: the jumpscare
 *          hands in 0..1 and the arms fling wide, then close on the camera.
 *
 * Idle and Chase are blended by how fast the ghost is actually moving, so it
 * drifts while searching and surges when it has you. Lighting is baked into
 * the textures; on top of that the materials glow faintly and pick out a cold
 * rim, because the house is nearly black and the ghost has to read in it.
 */

/**
 * Resolve a file in `public/` against wherever the game is served from.
 *
 * A leading slash would point at the domain root, which is wrong on GitHub
 * Pages: the site lives under `/<repo>/`, so `/assets/ghost.glb` 404s and the
 * house is empty. Vite substitutes `BASE_URL` at build time with the `base`
 * from the config, so this is correct from the root, from a subdirectory, and
 * from a local dev server alike.
 */
function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return base.endsWith('/') ? base + path : `${base}/${path}`;
}

/** The model, served from `public/`. Rebuild it with `tools/build-ghost.py`. */
export const GHOST_MODEL_URL = assetUrl('assets/ghost.glb');

export interface GhostModel {
  object: THREE.Object3D;
  /** Advance the animation. */
  update(dt: number, time: number, camera: THREE.Camera): void;
  /** 0 = barely there, 1 = fully manifest. */
  setPresence(v: number): void;
  /**
   * Drive the lunge, 0..1, for the catch.
   *
   * The jumpscare calls this, and it scrubs the Lunge animation directly: the
   * arms sweep out and forward in world space, so the scare happens in the
   * scene rather than as a flat image pasted over it.
   */
  setLunge(v: number): void;
  /** Current world-space Y of the face, so the scare can aim at it. */
  headWorldY(): number;
  dispose(): void;
}

/** Where the face sits before the model has loaded. Matches the model's rest pose. */
const REST_FACE_Y = 2.05;

/** Uniforms shared by every material on the ghost, so they glow and fade together. */
interface GhostUniforms {
  /** 1 once the model has loaded. Read by the browser tests. */
  uReady: { value: number };
  uPresence: { value: number };
  /** Self-illumination: how much of its own colour the ghost gives off. */
  uSelfLit: { value: number };
  uRim: { value: THREE.Color };
}

/**
 * Patch a standard material with the ghost's spectral behaviour.
 *
 * Three things on top of the baked textures. A little self-illumination, so
 * the figure is never fully swallowed by an unlit corridor. A cold Fresnel rim
 * that traces the silhouette, which is most of what you see of something in
 * the dark. And a dithered dissolve — the hem fades into the floor, and the
 * whole figure can fade by presence — done by discarding a screen-space
 * pattern rather than with alpha blending, so the skinned layers of cloth
 * never have to be depth-sorted against each other.
 */
function spectral(mat: THREE.MeshStandardMaterial, u: GhostUniforms): void {
  mat.userData.uniforms = u;
  mat.side = THREE.DoubleSide;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPresence = u.uPresence;
    shader.uniforms.uSelfLit = u.uSelfLit;
    shader.uniforms.uRim = u.uRim;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vRestY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRestY = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uPresence;
        uniform float uSelfLit;
        uniform vec3 uRim;
        varying float vRestY;
        float ghostHash(vec2 p) {
          return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        // The hem dissolves into the floor; presence dissolves everything.
        float ghostFade = smoothstep(0.0, 0.22, vRestY) * uPresence;
        if (ghostFade < 0.999 && ghostFade <= ghostHash(floor(gl_FragCoord.xy))) discard;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float ghostFres = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 3.0);
        totalEmissiveRadiance += diffuseColor.rgb * uSelfLit + uRim * ghostFres;`);
  };
  mat.needsUpdate = true;
}

export function createGhost(): GhostModel {
  const group = new THREE.Object3D();
  const disposables: { dispose(): void }[] = [];

  const u: GhostUniforms = {
    uReady: { value: 0 },
    uPresence: { value: 1 },
    uSelfLit: { value: 0.22 },
    uRim: { value: new THREE.Color(0x5a6a88).multiplyScalar(0.55) },
  };

  let mixer: THREE.AnimationMixer | null = null;
  let idle: THREE.AnimationAction | null = null;
  let chase: THREE.AnimationAction | null = null;
  let lungeAction: THREE.AnimationAction | null = null;
  let headBone: THREE.Object3D | null = null;
  let modelRoot: THREE.Object3D | null = null;
  let faceAnchor: THREE.Object3D | null = null;
  let eyeMaterial: THREE.MeshStandardMaterial | null = null;

  new GLTFLoader().load(
    GHOST_MODEL_URL,
    (gltf) => {
      const model = gltf.scene;
      model.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          // Skinned bounds are the rest pose; a lunging arm would get culled.
          mesh.frustumCulled = false;
          const mat = mesh.material as THREE.MeshStandardMaterial;
          spectral(mat, u);
          if (mat.emissiveMap) eyeMaterial = mat;
          disposables.push(mesh.geometry, mat);
          for (const tex of [mat.map, mat.emissiveMap]) if (tex) disposables.push(tex);
        }
      });
      /*
       * Turn the model to face the way the ghost is heading.
       *
       * The renderer points the group's local -Z along the ghost's heading;
       * the model is exported facing +Z. Unturned, it hunted backwards and
       * lunged at the camera with the back of its hood.
       */
      model.rotation.y = Math.PI;
      modelRoot = model;
      headBone = model.getObjectByName('head') ?? null;
      faceAnchor = model.getObjectByName('FaceAnchor') ?? null;

      mixer = new THREE.AnimationMixer(model);
      const clip = (name: string) => {
        const c = THREE.AnimationClip.findByName(gltf.animations, name);
        return c ? mixer!.clipAction(c) : null;
      };
      idle = clip('Idle');
      chase = clip('Chase');
      lungeAction = clip('Lunge');
      for (const a of [idle, chase, lungeAction]) {
        if (!a) continue;
        a.play();
        a.setEffectiveWeight(0);
      }
      // The lunge is positioned by hand from the jumpscare's 0..1, never by the clock.
      if (lungeAction) lungeAction.timeScale = 0;
      idle?.setEffectiveWeight(1);

      group.add(model);
      u.uReady.value = 1;
    },
    undefined,
    (err) => { console.error('ghost model failed to load', GHOST_MODEL_URL, err); },
  );

  // The ghost carries its own faint red glow, so it separates from a dark wall
  // and so survivors get a half-second of warning.
  const glow = new THREE.PointLight(0xa04444, 6.0, 6.0, 1.7);
  glow.position.set(0, 1.3, 0.35);
  group.add(glow);

  let presence = 1;
  let lunge = 0;
  let lastTime: number | null = null;
  const lastPos = new THREE.Vector3();
  let speed = 0;
  let chaseMix = 0;

  return {
    object: group,

    update(_dt, time, camera) {
      // The renderer passes no dt, so derive it from the clock it does pass.
      const dt = lastTime === null ? 0 : Math.min(0.1, Math.max(0, time - lastTime));
      lastTime = time;
      u.uPresence.value = presence;

      // How fast is it really moving? That, not the AI's state, picks the gait,
      // so a remote client sees the same thing the host does.
      if (dt > 0) {
        const moved = Math.hypot(group.position.x - lastPos.x, group.position.z - lastPos.z);
        // Teleports (a respawn, the scare taking over) are not running.
        const v = moved / dt < 12 ? moved / dt : speed;
        speed += (v - speed) * Math.min(1, dt * 4);
      }
      lastPos.copy(group.position);
      const target = THREE.MathUtils.smoothstep(speed, 1.2, 2.8);
      chaseMix += (target - chaseMix) * Math.min(1, dt * 3);

      if (mixer && idle && chase && lungeAction) {
        const l = THREE.MathUtils.smoothstep(lunge, 0.0, 0.12);
        idle.setEffectiveWeight((1 - chaseMix) * (1 - l));
        chase.setEffectiveWeight(chaseMix * (1 - l));
        lungeAction.setEffectiveWeight(l);
        lungeAction.time = lunge * lungeAction.getClip().duration;
        mixer.update(dt);

        /*
         * Turn the head toward the camera, in the body's own frame, on top of
         * the animation. A ghost whose head is already turned toward you when
         * you round a corner is far worse than one that has to turn.
         */
        if (headBone && modelRoot) {
          // Measured in the model's own frame, where the face looks down +Z.
          const local = modelRoot.worldToLocal(camera.position.clone());
          const rel = Math.atan2(local.x, local.z);
          headBone.rotateY(THREE.MathUtils.clamp(rel, -0.45, 0.45) * (0.3 + lunge * 0.5));
        }
      }

      // Brighter at the catch, so the face is actually readable in the frame.
      u.uSelfLit.value = 0.22 + lunge * 0.5;
      if (eyeMaterial) eyeMaterial.emissiveIntensity = 1.0 + lunge * 1.5;
      glow.intensity = presence * (5.0 + Math.sin(time * 4.1) * 1.2 + lunge * 16);
    },

    setPresence(v) { presence = THREE.MathUtils.clamp(v, 0, 1); },
    setLunge(v) { lunge = THREE.MathUtils.clamp(v, 0, 1); },
    headWorldY() {
      if (!faceAnchor) return group.position.y + REST_FACE_Y;
      const v = new THREE.Vector3();
      faceAnchor.getWorldPosition(v);
      return v.y;
    },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}
