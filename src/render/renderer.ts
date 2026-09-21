import * as THREE from 'three';
import { GHOST, PULSE, SURVIVOR } from '../game/config.js';
import type { Mansion } from '../game/map.js';
import type { GameState, Role } from '../game/types.js';
import { createPulseMark, createSurvivor, type SurvivorModel } from './actors.js';
import { createGhost, type GhostModel } from './ghostModel.js';
import { createJumpscare, type Jumpscare } from './jumpscare.js';
import { buildWorld, type WorldView } from './world.js';

/**
 * Drawing the house and everyone in it.
 *
 * The renderer owns the camera and is the only thing that knows which actor
 * the player is looking through, so switching from survivor to ghost — or to
 * spectator after being caught — is a change of viewpoint here and nowhere
 * else. The simulation is entirely unaware that anyone is watching.
 */

const BASE_FOV = 78;

/** How close a body must be for a door to swing open, in metres. */
const DOOR_OPEN_RANGE = 2.4;
/** How far a door swings, radians. */
const DOOR_OPEN_ANGLE = 1.5;

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  private readonly world: WorldView;
  private readonly ghostModel: GhostModel;
  private readonly survivorModels = new Map<string, SurvivorModel>();
  private readonly pulseMarks: ReturnType<typeof createPulseMark>[] = [];
  readonly jumpscare: Jumpscare;

  /** Smoothed head bob phase, so walking has weight. */
  private bobPhase = 0;
  /** Current eye height, eased so crouching is not an instant snap. */
  private eyeHeight = SURVIVOR.eyeHeight;
  /** Spectator orbit angle, used after the player is caught. */
  private spectatorAngle = 0;
  /**
   * Where the jumpscare wants the ghost this frame.
   *
   * The scare is computed while placing the camera but has to be applied when
   * positioning actors, and the two happen in different passes.
   */
  private scareGhost: { x: number; z: number; yaw: number } | null = null;

  constructor(canvas: HTMLCanvasElement, private readonly mansion: Mansion) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // A filmic curve keeps the highlights from blowing out in a scene this
    // dark, where a single point light is the brightest thing on screen.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.05, 90);

    this.world = buildWorld(mansion);
    this.ghostModel = createGhost();
    this.world.scene.add(this.ghostModel.object);

    this.jumpscare = createJumpscare();
    this.world.scene.add(this.jumpscare.mesh);

    // One reusable reveal column per possible survivor.
    for (let i = 0; i < 8; i++) {
      const m = createPulseMark();
      m.object.visible = false;
      this.world.scene.add(m.object);
      this.pulseMarks.push(m);
    }
  }

  /**
   * Project a fixed world point to normalised device coordinates.
   *
   * Used only by the control test. The point is the centre of the house, far
   * enough away that turning the camera sweeps it clearly across the frame.
   */
  projectProbe(): { x: number; y: number } {
    const v = new THREE.Vector3(0, 1.5, 0).project(this.camera);
    return { x: v.x, y: v.y };
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Draw one frame.
   *
   * `viewerId` is whose eyes we are behind. When that actor is dead the camera
   * falls back to a slow orbit of the house, which is both a spectator mode
   * and a way to keep watching your friends fail.
   */
  render(state: GameState, role: Role, viewerId: string, dt: number, time: number): void {
    // The camera pass first: it drives the jumpscare, which decides where the
    // ghost is standing, and the actor pass needs that answer.
    this.placeCamera(state, role, viewerId, dt, time);
    this.syncActors(state, role, time);
    this.syncDoors(state, dt);
    this.syncProps(state, time);
    this.syncPulse(state, role, time);
    this.renderer.render(this.world.scene, this.camera);
  }

  private syncActors(state: GameState, role: Role, time: number): void {
    for (let i = 0; i < state.survivors.length; i++) {
      const s = state.survivors[i];
      let m = this.survivorModels.get(s.id);
      if (!m) {
        m = createSurvivor(i);
        this.survivorModels.set(s.id, m);
        this.world.scene.add(m.object);
      }
      m.update(s, time);
    }

    const g = state.ghost;
    if (this.scareGhost) {
      // Mid-scare the ghost is wherever the scare says, which is in the
      // player's face regardless of where it actually caught them.
      this.ghostModel.object.position.set(this.scareGhost.x, 0, this.scareGhost.z);
      this.ghostModel.object.rotation.y = -this.scareGhost.yaw - Math.PI / 2;
    } else {
      this.ghostModel.object.position.set(g.pos.x, 0, g.pos.z);
      this.ghostModel.object.rotation.y = -g.yaw - Math.PI / 2;
    }
    this.ghostModel.update(0, time, this.camera);
    // Playing as the ghost, your own body would fill the screen; hide it —
    // except during the scare, where it is the whole point.
    this.ghostModel.object.visible = role !== 'ghost' || this.scareGhost !== null;
  }

  /**
   * Doors open for whoever is at them, and close behind.
   *
   * A door standing open is information — it says somebody came this way —
   * so leaving them all ajar from the start throws that away, and a house of
   * permanently open doorways is just a house with holes in it. Shut by
   * default, a door swinging as you round a corner means something is there
   * *now*, and one drifting closed across a corridor means something was.
   *
   * The leaf never collides, so this is purely what you see and hear; a door
   * that could shut you in would make the ghost unbeatable.
   */
  private syncDoors(state: GameState, dt: number): void {
    const bodies: { x: number; z: number }[] = [
      { x: state.ghost.pos.x, z: state.ghost.pos.z },
    ];
    for (const s of state.survivors) {
      if (s.alive && !s.escaped && !s.hidden) bodies.push({ x: s.pos.x, z: s.pos.z });
    }

    for (const d of this.mansion.doors) {
      const pivot = this.world.roomDoors.get(d.id);
      if (!pivot) continue;

      // Open when anything is within reach of the opening.
      let near = false;
      for (const b of bodies) {
        if (Math.hypot(b.x - d.x, b.z - d.z) < DOOR_OPEN_RANGE) { near = true; break; }
      }

      const base = d.axis === 'x' ? 0 : Math.PI / 2;
      const want = base + (near ? d.swing * DOOR_OPEN_ANGLE : 0);
      // Opening is quick and closing is slow, which is how a heavy door
      // behaves and gives the swing-back time to be noticed.
      const speed = near ? 7.0 : 2.2;
      pivot.rotation.y += (want - pivot.rotation.y) * Math.min(1, dt * speed);
    }
  }

  private syncProps(state: GameState, time: number): void {
    this.world.keyMesh.visible = !state.key.taken;
    if (!state.key.taken) {
      this.world.keyMesh.position.set(state.key.x, 0.45 + Math.sin(time * 1.8) * 0.06, state.key.z);
      this.world.keyMesh.rotation.y = time * 0.9;
    }

    // The gate swings wide once the lock is off, so escape is visibly open.
    const open = state.exitUnlocked;
    this.world.gateMesh.rotation.y = THREE.MathUtils.lerp(
      this.world.gateMesh.rotation.y, open ? -1.3 : 0, 0.06,
    );

    // Almirah doors stand open when nobody is inside, shut when occupied —
    // which is exactly the tell a hunting ghost learns to read.
    for (const [id, pivot] of this.world.hidingDoors) {
      const occupied = state.survivors.some((s) => s.hidden?.spotId === id);
      const want = occupied ? 0 : -0.9;
      pivot.children[0].rotation.y = THREE.MathUtils.lerp(
        pivot.children[0].rotation.y, want, 0.12,
      );
    }
  }

  /**
   * The reveal columns.
   *
   * Only the ghost ever sees these. Rendering them for survivors would hand
   * the hunted the same information as the hunter and collapse the asymmetry
   * the whole design rests on.
   */
  private syncPulse(state: GameState, role: Role, time: number): void {
    const showing = role === 'ghost' && state.time < state.pulse.visibleUntil;
    const age = showing
      ? 1 - (state.pulse.visibleUntil - state.time) / PULSE.duration
      : 0;

    for (let i = 0; i < this.pulseMarks.length; i++) {
      const mark = state.pulse.marks[i];
      const m = this.pulseMarks[i];
      if (showing && mark) {
        m.object.visible = true;
        m.object.position.set(mark.x, 0, mark.z);
        m.update(time, age);
      } else {
        m.object.visible = false;
      }
    }
  }

  private placeCamera(
    state: GameState, role: Role, viewerId: string, dt: number, time: number,
  ): void {
    /*
     * Tell the scare where the face actually is before it aims the camera.
     *
     * Aiming at a hard-coded height was wrong by about 15cm, which is nothing
     * at normal FOV and everything at the punched-in FOV of the hold — the
     * face sat just above the top of the screen and the scare showed a torso.
     * Measuring the model each frame means the shot cannot drift out of frame
     * when the body proportions change.
     */
    this.jumpscare.setFaceHeight(this.ghostModel.headWorldY());
    const scare = this.jumpscare.update(dt, this.camera, BASE_FOV);
    this.ghostModel.setLunge(scare.lunge);
    this.scareGhost = scare.ghostAt
      ? { x: scare.ghostAt.x, z: scare.ghostAt.z, yaw: scare.ghostYaw }
      : null;

    if (role === 'ghost') {
      const g = state.ghost;
      this.camera.position.set(g.pos.x, GHOST.eyeHeight, g.pos.z);
      this.applyLook(g.yaw, g.pitch, scare.shake);
      return;
    }

    const self = state.survivors.find((s) => s.id === viewerId);

    /**
     * Death does not mean the camera leaves immediately.
     *
     * Cutting to the spectator orbit the instant a survivor dies threw the
     * player twenty-six metres into the air on the same frame the scare
     * began, so the jumpscare played out correctly and invisibly, from a
     * bird's-eye view. The body stays where it fell and the camera stays in
     * its head until the scare has finished; only then does it pull out.
     */
    if (!self || (!self.alive && !this.jumpscare.active)) {
      this.spectate(state, dt, time);
      return;
    }

    if (self && !self.alive) {
      // Dead, mid-scare: hold the last eye position and let the scare drive
      // the look. Nothing else about the body updates any more.
      this.camera.position.set(self.pos.x, SURVIVOR.eyeHeight * 0.8, self.pos.z);
      if (scare.lookAt) {
        // Use the target's own height. Two call sites here hard-coded 1.45
        // and 1.5, discarding the y the scare had carefully computed — so the
        // camera stared at chest height while the face was a metre above it.
        this.camera.lookAt(scare.lookAt);
        this.camera.position.x += scare.shake.x;
        this.camera.position.y += scare.shake.y;
        this.camera.position.z += scare.shake.z;
      } else {
        this.applyLook(self.yaw, self.pitch, scare.shake);
      }
      return;
    }

    // --- Eye height, eased. Crouching should feel like lowering yourself,
    //     not like teleporting down half a metre. ---
    let targetEye: number = self.stance === 'crouch'
      ? SURVIVOR.crouchEyeHeight
      : SURVIVOR.eyeHeight;
    if (self.hidden) {
      const spot = this.mansion.hidingSpots.find((h) => h.id === self.hidden!.spotId);
      if (spot) targetEye = spot.eyeHeight;
    }
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(1, dt * 9);

    // --- Head bob, scaled by how fast they are actually moving. ---
    const moving = !self.hidden && (this.lastX !== self.pos.x || this.lastZ !== self.pos.z);
    const speed = Math.hypot(self.pos.x - this.lastX, self.pos.z - this.lastZ) / Math.max(dt, 1e-4);
    this.lastX = self.pos.x;
    this.lastZ = self.pos.z;
    if (moving) this.bobPhase += dt * (4.5 + speed * 1.6);
    const bobAmt = self.stance === 'crouch' ? 0.012 : 0.028;
    const bob = moving ? Math.sin(this.bobPhase * 2) * bobAmt : 0;
    const sway = moving ? Math.sin(this.bobPhase) * bobAmt * 0.6 : 0;

    this.camera.position.set(
      self.pos.x + Math.cos(self.yaw + Math.PI / 2) * sway,
      this.eyeHeight + bob,
      self.pos.z + Math.sin(self.yaw + Math.PI / 2) * sway,
    );

    if (scare.lookAt) {
      // The scare takes the camera; the player's own aim stops mattering.
      this.camera.lookAt(scare.lookAt);
      this.camera.position.x += scare.shake.x;
      this.camera.position.y += scare.shake.y;
      this.camera.position.z += scare.shake.z;
    } else {
      this.applyLook(self.yaw, self.pitch, scare.shake);
    }
  }

  private lastX = 0;
  private lastZ = 0;

  /**
   * Point the camera, converting the sim's yaw convention to Three's.
   *
   * The sim treats yaw as a compass bearing in the XZ plane: forward is
   * `(cos yaw, sin yaw)`. A Three.js camera with `rotation.y = t` looks down
   * `(-sin t, -cos t)`, so the conversion is `t = -yaw - PI/2`, which gives a
   * look direction of exactly `(cos yaw, sin yaw)`.
   *
   * It was `-yaw + PI/2`, which points the camera at `(-cos yaw, -sin yaw)` —
   * the exact opposite of the way the body walks. W drove you backwards and
   * the mouse looked the wrong way; the movement code was right all along.
   */
  private applyLook(yaw: number, pitch: number, shake: THREE.Vector3): void {
    this.camera.position.x += shake.x;
    this.camera.position.y += shake.y;
    this.camera.position.z += shake.z;
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = -yaw - Math.PI / 2;
    this.camera.rotation.x = pitch;
  }

  /**
   * Spectator view after being caught: a slow, high orbit.
   *
   * Deliberately distant and powerless. Being dead should feel like being shut
   * out of the house, not like getting a free camera.
   */
  private spectate(state: GameState, dt: number, time: number): void {
    this.spectatorAngle += dt * 0.12;
    const r = 26;
    this.camera.position.set(
      Math.cos(this.spectatorAngle) * r,
      16 + Math.sin(time * 0.3) * 1.2,
      Math.sin(this.spectatorAngle) * r,
    );
    this.camera.rotation.order = 'YXZ';
    this.camera.lookAt(0, 0, 0);
    void state;
  }

  dispose(): void {
    for (const m of this.survivorModels.values()) m.dispose();
    for (const m of this.pulseMarks) m.dispose();
    this.ghostModel.dispose();
    this.jumpscare.dispose();
    this.world.dispose();
    this.renderer.dispose();
  }
}
