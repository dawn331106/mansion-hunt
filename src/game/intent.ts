/**
 * What an actor wants to do this tick.
 *
 * Humans and bots both produce intents and nothing else; the simulation is the
 * only thing that moves anyone. That boundary is what lets a bot and a networked
 * player be the same thing to the sim, and it is what a host-authoritative
 * netcode needs — a remote player sends intents, never positions.
 */

export interface Intent {
  /** Desired movement in the actor's local frame: +forward, +right. */
  forward: number;
  right: number;
  /** Absolute look angles, radians. Set directly by mouse or bot. */
  yaw: number;
  pitch: number;
  /** Held sprint. Ignored when out of stamina or crouched. */
  sprint: boolean;
  /** Held crouch. Survivors only. */
  crouch: boolean;
  /** Edge-triggered: interact with a hiding spot, the key, or the gate. */
  interact: boolean;
  /** Edge-triggered: the ghost's catch attempt. */
  catch: boolean;
}

export function emptyIntent(yaw = 0, pitch = 0): Intent {
  return { forward: 0, right: 0, yaw, pitch, sprint: false, crouch: false, interact: false, catch: false };
}
