import * as THREE from 'three';

/**
 * The ghost: a real body, animated, with the artwork mapped onto it.
 *
 * The important decision here is that the supplied image is *not* a billboard.
 * A camera-facing sprite is cheap but it gives the ghost no presence — it has
 * no back, it cannot turn away from you, and it cannot lunge. So the image is
 * used as a texture on built geometry: the face plate takes the artwork, and
 * the head, torso, arms and trailing shroud are actual meshes that move.
 *
 * That buys the three things the design needs. It can be seen from behind and
 * still read as the ghost. It can animate — the shroud billows, the arms
 * drift, the whole form breathes. And at the catch it can lunge *at* the
 * camera in three dimensions, which is the difference between a scare and a
 * picture of one.
 *
 * Drop the artwork at `public/assets/ghost.png` and set GHOST_TEXTURE_URL.
 * Until then the face plate uses a procedural spectral shader and every other
 * part of the body is identical, so the animation and the jumpscare can be
 * tuned now and the art swapped in later without touching anything else.
 */

/**
 * Path to the ghost artwork, served from `public/`.
 *
 * A transparent PNG of the face or upper body works best. The shader tints and
 * dissolves it, so a flat, evenly-lit source image is fine — no need to
 * pre-darken it.
 */
export const GHOST_TEXTURE_URL: string | null = '/assets/ghost.png';


export interface GhostModel {
  object: THREE.Object3D;
  /** Advance the drift, billow and breathing. */
  update(dt: number, time: number, camera: THREE.Camera): void;
  /** 0 = barely there, 1 = fully manifest. Drives opacity and glow. */
  setPresence(v: number): void;
  /**
   * Drive the lunge, 0..1, for the catch.
   *
   * The jumpscare calls this: the body surges forward and the arms sweep up,
   * in world space, so the scare happens in the scene rather than as a flat
   * image pasted over it.
   */
  setLunge(v: number): void;
  dispose(): void;
}

/** Shared spectral uniforms, so every part of the body flickers in sync. */
interface Spectral {
  uTime: { value: number };
  uPresence: { value: number };
  uColor: { value: THREE.Color };
  uDeep: { value: THREE.Color };
  uMap: { value: THREE.Texture | null };
  uHasMap: { value: number };
}

/**
 * The body shader.
 *
 * One material serves every part, with `uHasMap` selecting whether it samples
 * the artwork. Fresnel brightens the silhouette edge and hollows the middle,
 * which is what makes the form read as a shell rather than a solid — and the
 * vertical dissolve means the ghost never quite meets the floor.
 */
function spectralMaterial(u: Spectral, opts: { dissolveFrom: number; useMap: boolean }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: u as unknown as Record<string, THREE.IUniform>,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    defines: { USE_MAP_TEX: opts.useMap ? 1 : 0 },
    vertexShader: `
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec2 vUv;
      varying float vLocalY;

      void main() {
        vUv = uv;
        vLocalY = position.y;

        // A slow, organic sway. Amplitude grows toward the hem, so the top of
        // the body stays readable while the bottom moves like cloth.
        vec3 p = position;
        float amp = max(0.0, -position.y) * 0.10 + 0.012;
        p.x += sin(uTime * 1.25 + position.y * 2.6) * amp;
        p.z += cos(uTime * 0.95 + position.y * 2.1) * amp;

        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uPresence;
      uniform vec3 uColor;
      uniform vec3 uDeep;
      uniform sampler2D uMap;
      uniform float uHasMap;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec2 vUv;
      varying float vLocalY;

      void main() {
        float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);

        vec3 col = mix(uDeep, uColor, fres);
        float alpha = 0.16 + fres * 0.74;

        #if USE_MAP_TEX
          if (uHasMap > 0.5) {
            vec4 tex = texture2D(uMap, vUv);
            // The artwork supplies the colour and the cut-out; the shader
            // supplies the glow at the edges, so it still looks spectral.
            col = mix(tex.rgb, tex.rgb * uColor * 1.7, fres * 0.55);
            alpha = tex.a * (0.72 + fres * 0.34);
          }
        #endif

        // Dissolve below the cut-off, so the lower body trails into nothing.
        float dissolve = smoothstep(${opts.dissolveFrom.toFixed(2)}, ${(opts.dissolveFrom + 0.55).toFixed(2)}, vLocalY);
        // A travelling ripple, so no surface is ever perfectly still.
        float ripple = 0.86 + 0.14 * sin(vLocalY * 14.0 - uTime * 2.6);

        gl_FragColor = vec4(col, alpha * dissolve * ripple * uPresence);
      }
    `,
  });
}

export function createGhost(): GhostModel {
  const group = new THREE.Object3D();
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

  /**
   * Load the artwork, tolerating its absence.
   *
   * The texture arrives asynchronously and the file may simply not be there
   * yet. Loading it straight into the material would show a white plane in the
   * meantime — the usual failure mode for runtime-loaded art, and a
   * particularly bad one on a face. So `uHasMap` stays at 0 until the image
   * actually decodes, the procedural face carries the ghost until then, and a
   * missing file just means the placeholder is permanent.
   */
  let texture: THREE.Texture | null = null;
  const faceReady = { value: 0 };
  if (GHOST_TEXTURE_URL) {
    texture = new THREE.TextureLoader().load(
      GHOST_TEXTURE_URL,
      () => { faceReady.value = 1; },
      undefined,
      () => { faceReady.value = 0; },
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    disposables.push(texture);
  }

  const u: Spectral = {
    uTime: { value: 0 },
    uPresence: { value: 1 },
    uColor: { value: new THREE.Color(0xc9c4c0) },
    uDeep: { value: new THREE.Color(0x2a2226) },
    uMap: { value: texture },
    uHasMap: faceReady,
  };

  // Body parts hang off a torso pivot, so the lunge moves everything at once.
  const body = new THREE.Object3D();
  group.add(body);

  // --- The shroud: the trailing lower body, widest at the hem. ---
  const shroudProfile: THREE.Vector2[] = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    // y runs from -1.25 (the dissolving tail) up to 0.35 (the shoulders).
    const y = -1.25 + t * 1.6;
    const r = 0.20 + Math.sin(t * Math.PI * 0.8) * 0.46 + (1 - t) * 0.10;
    shroudProfile.push(new THREE.Vector2(r, y));
  }
  const shroudGeo = track(new THREE.LatheGeometry(shroudProfile, 28));
  const shroudMat = track(spectralMaterial(u, { dissolveFrom: -1.25, useMap: false }));
  const shroud = new THREE.Mesh(shroudGeo, shroudMat);
  body.add(shroud);

  // --- Torso: a tapered shell over the top of the shroud. ---
  const torsoGeo = track(new THREE.CylinderGeometry(0.30, 0.42, 0.62, 20, 1, true));
  const torsoMat = track(spectralMaterial(u, { dissolveFrom: -0.5, useMap: false }));
  const torso = new THREE.Mesh(torsoGeo, torsoMat);
  torso.position.y = 0.42;
  body.add(torso);

  // --- Head. ---
  const headGroup = new THREE.Object3D();
  headGroup.position.y = 0.92;
  body.add(headGroup);

  const headGeo = track(new THREE.SphereGeometry(0.24, 20, 18));
  const headMat = track(spectralMaterial(u, { dissolveFrom: -0.4, useMap: false }));
  const head = new THREE.Mesh(headGeo, headMat);
  headGroup.add(head);

  /**
   * The face plate: where the artwork lands.
   *
   * A slightly curved plane sitting just proud of the head sphere, so the
   * image sits on a face rather than floating. It is a child of the head, so
   * it turns with the body and is genuinely absent when the ghost faces away
   * — which is what makes turning around and finding it there work at all.
   */
  const faceGeo = track(new THREE.SphereGeometry(
    0.245, 20, 18,
    // A patch of sphere: front-facing only.
    Math.PI * 0.72, Math.PI * 0.56,
    Math.PI * 0.22, Math.PI * 0.56,
  ));
  const faceMat = track(spectralMaterial(u, { dissolveFrom: -1.0, useMap: true }));
  const face = new THREE.Mesh(faceGeo, faceMat);
  headGroup.add(face);

  // --- The eyes. Drawn while the face is still procedural; hidden once the
  //     artwork loads, since it brings its own and two sets would fight. ---
  const eyes = new THREE.Object3D();
  {
    const eyeGeo = track(new THREE.SphereGeometry(0.045, 12, 12));
    // Red, to match the artwork's eyes, and self-lit so they hold in the dark.
    const eyeMat = track(new THREE.MeshBasicMaterial({ color: 0x8b1a1a }));
    for (const dx of [-0.082, 0.082]) {
      const e = new THREE.Mesh(eyeGeo, eyeMat);
      e.position.set(dx, 0.03, 0.225);
      eyes.add(e);
    }
    headGroup.add(eyes);
  }

  // --- Arms: long, tapering, and loose. They drift while it hunts and sweep
  //     forward on the lunge. ---
  const armGeo = track(new THREE.CylinderGeometry(0.055, 0.11, 0.78, 10, 1, true));
  const armMat = track(spectralMaterial(u, { dissolveFrom: -0.9, useMap: false }));
  const arms: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Object3D();
    pivot.position.set(side * 0.34, 0.62, 0);
    const arm = new THREE.Mesh(armGeo, armMat);
    // Pivot at the shoulder, not the middle of the limb.
    arm.position.y = -0.39;
    pivot.add(arm);
    pivot.rotation.z = side * 0.18;
    body.add(pivot);
    arms.push(pivot);
  }

  // --- Light. The ghost carries its own faint glow, so it separates from a
  //     dark wall and so survivors get a half-second of warning. ---
  const glow = new THREE.PointLight(0xa04444, 6.0, 6.0, 1.7);
  glow.position.y = 0.8;
  group.add(glow);

  let presence = 1;
  let lunge = 0;

  return {
    object: group,

    update(_dt, time, camera) {
      u.uTime.value = time;
      u.uPresence.value = presence;

      // --- Idle motion: a slow vertical drift and a breathing scale. It
      //     never stands still, which is most of what sells it as alive. ---
      const drift = Math.sin(time * 1.05) * 0.075;
      const breathe = 1 + Math.sin(time * 1.6) * 0.022;
      body.position.y = 1.15 + drift + lunge * 0.18;
      body.scale.set(breathe, 1 / breathe, breathe);

      // --- The head tracks the camera slightly, independently of the body.
      //     A ghost whose head is already turned toward you when you round a
      //     corner is far worse than one that has to turn. ---
      const toCam = Math.atan2(
        camera.position.x - group.position.x,
        camera.position.z - group.position.z,
      );
      const rel = wrapAngle(toCam - group.rotation.y);
      headGroup.rotation.y = clamp(rel, -0.7, 0.7) * (0.35 + lunge * 0.65);
      // Once the artwork is in, it supplies the eyes; drop the stand-ins.
      eyes.visible = faceReady.value < 0.5;
      headGroup.rotation.x = Math.sin(time * 0.8) * 0.05 - lunge * 0.22;

      // --- Arms. They sway while hunting and sweep up and forward on the
      //     lunge, which is the motion the catch is built around. ---
      for (let i = 0; i < arms.length; i++) {
        const side = i === 0 ? -1 : 1;
        const sway = Math.sin(time * 1.3 + i * 1.9) * 0.14;
        arms[i].rotation.z = side * (0.18 + sway * 0.5) - side * lunge * 0.75;
        arms[i].rotation.x = sway * 0.6 - lunge * 1.45;
      }

      // The whole form leans in as it lunges.
      body.rotation.x = -lunge * 0.28;

      glow.intensity = presence * (5.0 + Math.sin(time * 4.1) * 1.2 + lunge * 16);
    },

    setPresence(v) { presence = clamp(v, 0, 1); },
    setLunge(v) { lunge = clamp(v, 0, 1); },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function wrapAngle(a: number): number {
  let d = a % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
