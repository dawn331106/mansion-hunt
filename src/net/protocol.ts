import type { Intent } from '../game/intent.js';
import type { GameState, Role } from '../game/types.js';

/**
 * What travels between the host and its peers.
 *
 * The model is host-authoritative, which the simulation was built for from the
 * start: `sim.step` takes only intents and returns the next state, so a remote
 * player and a bot are the same thing to it. Clients send what they are trying
 * to do; the host decides what actually happened and says so. Nobody can walk
 * through a wall by lying about their position, because no client ever sends
 * one.
 *
 * The alternative — everyone simulating and reconciling — is far more work and
 * buys nothing here. A hunt between six people in one house does not need
 * rollback; it needs everyone to agree on who got caught.
 */

/** Bumped when a change makes old and new clients incompatible. */
export const PROTOCOL_VERSION = 1;

/** How many times a second the host broadcasts the world. */
export const SNAPSHOT_HZ = 20;

/** How many times a second a client sends its intent. */
export const INPUT_HZ = 30;

// --- Lobby ----------------------------------------------------------------

export interface LobbyPlayer {
  /** PeerJS connection id, and the actor id in the simulation. */
  id: string;
  name: string;
  /** What they have asked to be. The host resolves conflicts at start. */
  wants: Role;
  /** True for the one player whose machine runs the simulation. */
  isHost: boolean;
  /** Round-trip time in ms, as last measured. */
  ping: number;
}

export interface LobbyState {
  code: string;
  players: LobbyPlayer[];
  /** Filled in once the host presses start. */
  started: boolean;
  /** How many bots fill out the survivor side. */
  bots: number;
}

// --- Client to host -------------------------------------------------------

export interface JoinMessage {
  t: 'join';
  version: number;
  name: string;
}

export interface WantRoleMessage {
  t: 'want';
  wants: Role;
}

export interface InputMessage {
  t: 'input';
  /**
   * The intent for this tick.
   *
   * Sent at a fixed rate rather than on change. Edge-triggered actions —
   * interact, catch — would otherwise be lost whenever a packet dropped,
   * which is unacceptable for the one button that decides a match.
   */
  intent: Intent;
  /** Client clock, echoed back in the snapshot so it can measure latency. */
  sent: number;
}

export interface PingMessage {
  t: 'ping';
  sent: number;
}

export type ClientMessage = JoinMessage | WantRoleMessage | InputMessage | PingMessage;

// --- Host to client -------------------------------------------------------

export interface WelcomeMessage {
  t: 'welcome';
  version: number;
  /** The actor id this player controls once the match begins. */
  you: string;
  lobby: LobbyState;
}

export interface LobbyMessage {
  t: 'lobby';
  lobby: LobbyState;
}

export interface StartMessage {
  t: 'start';
  /** Which actor each peer drives. */
  assignments: Record<string, string>;
  /** The role each peer ended up with, after the host resolved conflicts. */
  roles: Record<string, Role>;
  /** Number of survivors, so every client builds the same match. */
  survivorCount: number;
  seed: number;
}

/**
 * The world, as the host sees it.
 *
 * Sent whole rather than as a delta. A full snapshot of this game is well
 * under a kilobyte — a handful of actors with a position, an angle and a few
 * flags — and at twenty a second that is trivial next to the complexity of
 * getting delta compression right. If the player count ever grows enough to
 * matter, this is the obvious place to optimise.
 */
export interface SnapshotMessage {
  t: 'snap';
  /** Host simulation time, so clients can order and interpolate. */
  time: number;
  state: GameState;
  /** Events since the last snapshot, for sounds and the jumpscare. */
  events: NetEvents;
  /** The client's own `sent` stamp, echoed for latency measurement. */
  echo?: number;
}

export interface PongMessage {
  t: 'pong';
  sent: number;
}

export interface KickedMessage {
  t: 'kicked';
  reason: string;
}

export type HostMessage =
  | WelcomeMessage | LobbyMessage | StartMessage
  | SnapshotMessage | PongMessage | KickedMessage;

/**
 * Events worth telling clients about.
 *
 * A mirror of the simulation's own `StepEvents`, minus anything a client can
 * work out for itself. These drive one-off sounds and the jumpscare, and they
 * have to be sent explicitly because a snapshot only carries state — a client
 * comparing two snapshots could infer that someone died, but not the moment it
 * happened or where the ghost was standing.
 */
export interface NetEvents {
  caught: { survivorId: string; x: number; z: number }[];
  footsteps: { actorId: string; x: number; z: number; volume: number }[];
  pulsed: boolean;
  keyTaken: string | null;
  escaped: string | null;
  hideChanged: { survivorId: string; spotId: string | null }[];
  spotted: string | null;
  /** What the ghost is saying, if anything, so every client subtitles it. */
  taunt: { text: string; x: number; z: number } | null;
}

export function emptyNetEvents(): NetEvents {
  return {
    caught: [], footsteps: [], pulsed: false, keyTaken: null,
    escaped: null, hideChanged: [], spotted: null, taunt: null,
  };
}

/**
 * Room codes.
 *
 * Six characters from an alphabet with no 0/O or 1/I/L, because these get
 * read aloud over a voice call and any pair that looks alike costs someone a
 * failed join. Prefixed so this game's rooms cannot collide with another
 * PeerJS application sharing the public broker.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_PREFIX = 'mansionhunt-';

export function makeRoomCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

export function peerIdForRoom(code: string): string {
  return ROOM_PREFIX + code.toUpperCase();
}

/** Normalise whatever the player typed into a room code. */
export function cleanRoomCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}
