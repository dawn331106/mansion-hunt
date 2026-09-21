export type Role = 'survivor' | 'ghost';

/** Why a survivor is no longer playing. */
export type DeathCause = 'caught';

export type Stance = 'stand' | 'crouch';

/** Where a survivor is hidden, if anywhere. */
export interface Hidden {
  /** Id of the hiding spot they occupy. */
  spotId: string;
  /** Simulation time they entered, used to block instant re-entry. */
  since: number;
}

export interface Survivor {
  id: string;
  name: string;
  role: 'survivor';
  /** Feet position. The eye sits `eyeHeight` above this. */
  pos: { x: number; y: number; z: number };
  /** Facing, radians, 0 = +X, increasing toward +Z. */
  yaw: number;
  /** Look pitch, radians, clamped to just short of straight up/down. */
  pitch: number;
  stance: Stance;
  stamina: number;
  /** Sim time sprinting last stopped, for the regen delay. */
  lastSprintAt: number;
  /** True once stamina hit zero, until it climbs back to the recovery floor. */
  exhausted: boolean;
  hidden: Hidden | null;
  alive: boolean;
  deathCause: DeathCause | null;
  /** True if this survivor is carrying the key. */
  hasKey: boolean;
  /** True once they are through the front door. */
  escaped: boolean;
  /** Bot-controlled rather than driven by a human. */
  isBot: boolean;
}

export interface Ghost {
  id: string;
  name: string;
  role: 'ghost';
  pos: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  /** Sim time of the last catch attempt, for the cooldown. */
  lastCatchAt: number;
  /**
   * Sim time the ghost last had a survivor in plain sight.
   *
   * Chase speed is unlocked from this rather than from the sprint key, so a
   * human ghost cannot simply hold shift across an empty house.
   */
  lastSawAt: number;
  /** Who it last saw, so the UI and audio can react to the spot. */
  spottedId: string | null;
  isBot: boolean;
}

export type Actor = Survivor | Ghost;

/** A position reported by the periodic reveal. */
export interface RevealMark {
  survivorId: string;
  x: number;
  z: number;
}

export interface PulseState {
  /** Sim time the next pulse fires. */
  nextAt: number;
  /** Sim time the current reveal stops being shown, or 0 if none. */
  visibleUntil: number;
  marks: RevealMark[];
}

export type MatchPhase = 'playing' | 'survivors-won' | 'ghost-won';

export interface MatchResult {
  phase: Exclude<MatchPhase, 'playing'>;
  /** Human-readable reason, shown on the end screen. */
  reason: string;
}

export interface GameState {
  /** Seconds since the match began. */
  time: number;
  phase: MatchPhase;
  result: MatchResult | null;
  survivors: Survivor[];
  ghost: Ghost;
  pulse: PulseState;
  /** Where the key is, until someone picks it up. */
  key: { x: number; y: number; z: number; taken: boolean };
  /** True once the front door has been unlocked with the key. */
  exitUnlocked: boolean;
}
