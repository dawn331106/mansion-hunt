import * as THREE from 'three';
import { MATCH } from '../game/config.js';

/**
 * The catch.
 *
 * A jumpscare works or it does not, and what separates the two is almost
 * entirely timing. This runs on a fixed 2.6-second curve with four overlapping
 * stages, none of which the player can interrupt:
 *
 *   0.00-0.08  SEIZE     The camera is torn off its moorings and snapped to
 *                        face the ghost. Control is gone before you register
 *                        that anything happened.
 *   0.05-0.42  LUNGE     The ghost is dragged bodily into the lens — not its
 *                        own walk, but a hard interpolation from wherever it
 *                        stood to arm's length from the camera — while the
 *                        view shakes and the FOV punches in.
 *   0.36-2.29  HOLD      The face fills the frame and simply stays there.
 *                        This is the longest stage on purpose: at 1.5s total
 *                        the ghost was only ever on screen while moving fast,
 *                        which is exactly when a face cannot be read.
 *   2.24-2.60  COLLAPSE  Hard cut to black, then the spectator view fades up.
 *
 * The overlay is a full-screen shader rather than DOM, so it can distort what
 * is actually on screen instead of merely covering it.
 */

export interface Jumpscare {
  /** Add this to the scene; it renders after everything else. */
  mesh: THREE.Mesh;
  /** Start the scare. `ghostPos` is where the killer is, in world space. */
  trigger(ghostPos: THREE.Vector3): void;
  /** Where the ghost's face sits, so the camera can frame it exactly. */
  setFaceHeight(y: number): void;
  /** True while the scare owns the screen and input. */
  get active(): boolean;
  /** 0..1 through the sequence. */
  get progress(): number;
  /**
   * Advance. Returns the camera treatment for this frame, which the renderer
   * applies: where to look, how much to shake, and the FOV punch.
   */
  update(dt: number, camera: THREE.PerspectiveCamera, baseFov: number): {
    shake: THREE.Vector3;
    lookAt: THREE.Vector3 | null;
    /** 0..1, fed to the ghost model's own lunge animation. */
    lunge: number;
    /**
     * Where the ghost should be drawn this frame, or null when the scare is
     * not running.
     *
     * The scare moves the ghost itself rather than only the camera. Letting it
     * lunge from wherever it happened to be standing meant it was often behind
     * furniture, or side-on, or simply too far away to see — the scare fired
     * and the player saw a red screen and nothing else. Hauling it to a fixed
     * distance in front of the lens is what guarantees there is a face there.
     */
    ghostAt: THREE.Vector3 | null;
    /** Which way the ghost should face: straight at the camera. */
    ghostYaw: number;
  };
  dispose(): void;
}

export function createJumpscare(): Jumpscare {
  const uniforms = {
    uTime: { value: 0 },
    /** 0 = inactive, otherwise 0..1 through the sequence. */
    uProgress: { value: 0 },
    uActive: { value: 0 },
    uAberration: { value: 0 },
    uVignette: { value: 0 },
    uBlack: { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uProgress;
      uniform float uActive;
      uniform float uAberration;
      uniform float uVignette;
      uniform float uBlack;
      varying vec2 vUv;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }

      void main() {
        if (uActive < 0.5) { discard; }

        vec2 uv = vUv;
        vec2 c = uv - 0.5;
        float r = length(c);

        // --- Vignette: a hard, red-black closing iris. ---
        float vig = smoothstep(0.24, 0.78, r) * uVignette;

        // --- Torn scanlines: rows displaced at random, so the image looks
        //     like it is failing rather than merely darkening. ---
        float row = floor(uv.y * 140.0);
        float tear = step(0.88, hash(vec2(row, floor(uTime * 24.0)))) * uAberration;

        // --- Grain, heaviest at the peak. ---
        float grain = (hash(uv * 900.0 + uTime * 60.0) - 0.5) * 0.30 * uAberration;

        // The overlay itself is a bloody wash whose weight follows the curve.
        vec3 wash = vec3(0.52, 0.03, 0.04);
        float washAmt = uVignette * 0.55 + tear * 0.35;

        vec3 col = wash * washAmt + vec3(grain);
        float alpha = clamp(vig * 0.94 + tear * 0.5 + abs(grain) * 0.8, 0.0, 1.0);

        // --- The collapse to black swallows everything. ---
        col = mix(col, vec3(0.0), uBlack);
        alpha = max(alpha, uBlack);

        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  // A full-screen triangle in clip space; no camera involved.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-1, -1, 0, 3, -1, 0, -1, 3, 0], 3,
  ));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  // Drawn last, over everything.
  mesh.renderOrder = 9999;
  mesh.visible = false;

  let elapsed = -1;
  const target = new THREE.Vector3();
  const shake = new THREE.Vector3();
  /** Where the ghost stood when the scare began. */
  const from = new THREE.Vector3();
  const ghostAt = new THREE.Vector3();
  /** Where the camera was when the scare began, so the lunge aims at it. */
  const eye = new THREE.Vector3();
  let eyeYaw = 0;

  const DUR = MATCH.jumpscareDuration;

  let faceY = 2.1;

  return {
    mesh,

    setFaceHeight(y) { if (Number.isFinite(y) && y > 0.5) faceY = y; },

    trigger(ghostPos) {
      elapsed = 0;
      target.copy(ghostPos);
      from.copy(ghostPos);
      mesh.visible = true;
      uniforms.uActive.value = 1;
    },

    get active() { return elapsed >= 0 && elapsed < DUR; },
    get progress() { return elapsed < 0 ? 0 : Math.min(1, elapsed / DUR); },

    update(dt, camera, baseFov) {
      if (elapsed < 0) {
        return { shake: shake.set(0, 0, 0), lookAt: null, lunge: 0, ghostAt: null, ghostYaw: 0 };
      }

      // Capture the camera on the first frame: everything is measured from
      // where the player was standing when they were caught.
      if (elapsed === 0) {
        eye.copy(camera.position);
        eyeYaw = Math.atan2(from.z - eye.z, from.x - eye.x);
      }

      elapsed += dt;
      const t = Math.min(1, elapsed / DUR);
      uniforms.uTime.value = elapsed;
      uniforms.uProgress.value = t;

      // --- Stage curves. Each is a window on the same normalised clock. ---
      /*
       * Stage windows, over a 2.6s clock.
       *
       * The earlier 1.5s version spent almost all of itself lunging and then
       * cut to black, so the face was only ever on screen while it was moving
       * fast — which is exactly when it cannot be read. The hold is now the
       * longest stage by a wide margin: the ghost arrives, fills the frame,
       * and stays there long enough to be uncomfortable.
       */
      const seize = smoothstep(0.0, 0.03, t);
      const lunge = smoothstep(0.02, 0.16, t);
      const hold = smoothstep(0.14, 0.22, t) * (1 - smoothstep(0.80, 0.88, t));
      const collapse = smoothstep(0.86, 0.97, t);

      // --- Shake. Violent at the lunge, tapering through the hold. Driven by
      //     two out-of-phase sines rather than random, so it reads as an
      //     impact rather than as noise. ---
      // Violent on impact, then a fine tremor through the hold — a scare that
      // shakes at full amplitude for two seconds is unreadable, not scary.
      const impact = lunge * (1 - smoothstep(0.16, 0.34, t));
      const shakeAmt = impact * 0.17 + hold * 0.022;
      shake.set(
        Math.sin(elapsed * 71) * shakeAmt,
        Math.sin(elapsed * 53 + 1.3) * shakeAmt,
        Math.sin(elapsed * 37 + 2.1) * shakeAmt * 0.5,
      );

      // --- FOV punch: in hard on the lunge, so the ghost appears to close
      //     faster than it physically moves. ---
      // Punch in hard and stay in: pulling the FOV back during the hold would
      // shrink the face at the exact moment it is meant to be overwhelming.
      camera.fov = baseFov - lunge * 20 * (1 - collapse);
      camera.updateProjectionMatrix();

      uniforms.uAberration.value = lunge * (1 - collapse);
      uniforms.uVignette.value = Math.max(lunge * 0.85, hold);
      uniforms.uBlack.value = collapse;

      if (t >= 1) {
        elapsed = -1;
        mesh.visible = false;
        uniforms.uActive.value = 0;
        camera.fov = baseFov;
        camera.updateProjectionMatrix();
      }

      /*
       * Drag the ghost to the lens.
       *
       * It ends up 0.95m from where the camera was — close enough that the
       * face fills the frame at the punched-in FOV, far enough that the near
       * clip plane does not slice through it.
       */
      /*
       * 0.95m put the ghost so close that its *body* filled the frame and the
       * head was above the top of the screen — the scare fired and the player
       * saw a dark rectangle. Backing off to 1.7m frames the head and
       * shoulders at the punched-in FOV, which is the shot the whole sequence
       * exists to deliver.
       */
      const ease = lunge * lunge * (3 - 2 * lunge);
      /*
       * Distance is set by the height difference, not picked by eye.
       *
       * The ghost's face is about a metre above a survivor's eyeline, so at
       * 1.05m away the camera has to crane up 45 degrees to see it and the
       * shot becomes a view up a chin. Standing it back far enough that the
       * face is roughly 30 degrees up puts the head and shoulders in frame
       * with the body beneath, which is the composition a jumpscare wants.
       */
      const rise = Math.max(0.2, faceY - eye.y);
      const range = Math.max(1.6, rise / Math.tan(0.52));
      const endX = eye.x + Math.cos(eyeYaw) * range;
      const endZ = eye.z + Math.sin(eyeYaw) * range;
      ghostAt.set(
        from.x + (endX - from.x) * ease,
        0,
        from.z + (endZ - from.z) * ease,
      );
      // Look at where the face measurably is, not where it is assumed to be.
      target.set(ghostAt.x, faceY, ghostAt.z);

      return {
        shake,
        ghostAt,
        // Face the camera dead on.
        ghostYaw: eyeYaw + Math.PI,
        // The camera is dragged onto the ghost and held there.
        lookAt: seize > 0 ? target : null,
        lunge,
      };
    },

    dispose() { geo.dispose(); mat.dispose(); },
  };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
