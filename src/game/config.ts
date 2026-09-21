/**
 * Every tuning number for the hunt, in one place.
 *
 * Units are metres and seconds throughout. A survivor is 1.7m tall and walks
 * at roughly a brisk human pace; everything else is scaled against that so the
 * mansion reads at human size in first person.
 */

export const SURVIVOR = {
  /** Eye height when standing, in metres. */
  eyeHeight: 1.65,
  /** Eye height when crouched — low enough to slide under tables. */
  crouchEyeHeight: 0.85,
  /** Collision radius. Narrow enough to fit doorways without scraping. */
  radius: 0.32,

  walkSpeed: 2.6,
  sprintSpeed: 4.6,
  crouchSpeed: 1.3,

  /** Seconds of sprint from full. */
  staminaMax: 4.0,
  /** Stamina drained per second of sprinting. */
  staminaDrain: 1.0,
  /** Stamina recovered per second while not sprinting. */
  staminaRegen: 0.55,
  /**
   * Seconds after sprinting stops before regen begins.
   *
   * Without this delay, tapping sprint repeatedly is strictly better than
   * holding it, which rewards keyboard mashing over deciding when to run.
   */
  staminaRegenDelay: 1.2,
  /**
   * Stamina must reach this before sprinting can restart after exhaustion.
   *
   * Hitting zero should cost you something. Without a floor to climb back to,
   * an exhausted player gets a useless one-frame sprint every time a scrap of
   * stamina appears.
   */
  staminaRecoveryFloor: 1.0,

  /** How close you must be to a hiding spot to use it. */
  interactRange: 1.6,
} as const;

export const GHOST = {
  eyeHeight: 1.8,
  radius: 0.36,

  /**
   * The ghost is faster than a walking survivor but slower than a sprinting
   * one, so a survivor with stamina can break away — briefly. The chase is a
   * question of how long your stamina lasts, not whether you are fast enough.
   */
  walkSpeed: 3.3,
  /** Ghosts do not tire; this is the ceiling, always available. */
  sprintSpeed: 4.3,

  /** How close the ghost must be to a survivor for a catch to land. */
  catchRange: 2.0,
  /** Half-angle of the catch cone, radians. The ghost must be facing them. */
  catchHalfAngle: Math.PI / 3,
  /** Seconds before the ghost can attempt another catch. */
  catchCooldown: 3.0,
} as const;

export const PULSE = {
  /** Seconds between reveals. */
  interval: 30,
  /** Seconds each reveal stays visible to the ghost. */
  duration: 3,
  /**
   * The reveal shows where each survivor was at the instant the pulse fired,
   * not where they are now. Those three seconds of running are the counterplay
   * — a snapshot rewards moving, a live tracker just ends the round.
   */
  snapshot: true,
} as const;

export const AUDIO = {
  /** Beyond this distance a voice is inaudible. */
  voiceMaxDistance: 18,
  /** Distance at which voice attenuation starts. Full volume inside it. */
  voiceRefDistance: 2.5,
  /** Beyond this, footsteps cannot be heard. */
  footstepMaxDistance: 14,
  footstepRefDistance: 1.5,
  /** Seconds between footstep sounds, per movement mode. */
  stepIntervalWalk: 0.52,
  stepIntervalSprint: 0.34,
  stepIntervalCrouch: 0.85,
  /** Crouching is quiet — this is the volume multiplier for crouched steps. */
  crouchStepVolume: 0.25,
  walkStepVolume: 0.7,
  sprintStepVolume: 1.0,
} as const;

export const MATCH = {
  /**
   * Seconds before the ghost may move at the start of a match.
   *
   * Without it the first survivor died 5.9 seconds in — before anyone had
   * crossed a room, let alone searched one. A hunt needs the hunted to have
   * somewhere to have got to; this is the difference between a game and an
   * ambush. The ghost spends it standing in the dark, which is its own kind
   * of dread for anyone who can hear it.
   */
  ghostHeadStart: 20,

  /**
   * Seconds before the house claims everyone. 0 disables the clock.
   *
   * Roughly one in seven bot matches otherwise reached a standoff: survivors
   * circling with the key unfound, the ghost patrolling rooms they had left.
   * A clock is the honest resolution — the night ends, and whoever is still
   * inside belongs to the house.
   */
  timeLimit: 260,
  /**
   * How long the jumpscare owns the screen, in seconds.
   *
   * 1.5s was too short to register: by the time you had turned to look, the
   * ghost had already lunged and the screen was cutting to black, so the face
   * you were meant to be frightened by was never actually legible. The extra
   * second is almost entirely hold time — the part where it fills the frame
   * and simply stays there, which is what makes a scare uncomfortable rather
   * than merely loud.
   */
  jumpscareDuration: 2.6,
} as const;
