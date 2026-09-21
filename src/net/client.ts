import Peer, { type DataConnection } from 'peerjs';
import type { Intent } from '../game/intent.js';
import type { GameState, Role } from '../game/types.js';
import {
  PROTOCOL_VERSION, peerIdForRoom,
  type HostMessage, type LobbyState, type NetEvents,
} from './protocol.js';

/**
 * The client: everyone who is not the host.
 *
 * It sends what the player is trying to do and draws what it is told. It runs
 * no simulation of its own, which is a deliberate simplification — client-side
 * prediction would hide the latency on your own movement, but it also brings
 * reconciliation, rollback and a whole class of bugs where your screen and the
 * host's disagree about where you are.
 *
 * For a hunt in one house between people on ordinary connections, snapshot
 * interpolation is enough: the world arrives twenty times a second and is
 * played back slightly behind live, so movement is smooth even when packets
 * are not evenly spaced. What that costs is a little input lag on your own
 * character. What it buys is that what you see is always something the host
 * actually believes happened.
 */

export interface ClientCallbacks {
  onLobby(lobby: LobbyState): void;
  /** The match is beginning; `you` is the actor this player drives. */
  onStart(you: string, role: Role, survivorCount: number, seed: number): void;
  onSnapshot(state: GameState, events: NetEvents): void;
  onError(message: string): void;
  onClosed(reason: string): void;
}

/**
 * How far behind live to play the world back.
 *
 * Snapshots arrive every 50ms and never perfectly evenly. Rendering the most
 * recent one the moment it lands means stuttering whenever one is late;
 * holding the world slightly in the past means there is almost always a newer
 * snapshot to interpolate toward. Two snapshot periods is the usual
 * compromise — enough slack to absorb jitter, little enough that nobody feels
 * they are watching a delayed broadcast.
 */
const INTERP_DELAY = 0.1;

interface Timed {
  time: number;
  state: GameState;
}

export class GameClient {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private buffer: Timed[] = [];
  /** Offset between the host's clock and ours, as best we can tell. */
  private clockOffset = 0;
  private pingSentAt = 0;
  ping = 0;
  you = '';
  role: Role = 'survivor';

  constructor(private readonly cb: ClientCallbacks) {}

  async join(code: string, name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const peer = new Peer({ debug: 1 });
      this.peer = peer;

      peer.on('open', () => {
        const conn = peer.connect(peerIdForRoom(code), {
          reliable: true,
          serialization: 'json',
        });
        this.conn = conn;

        /*
         * A join that never connects looks identical to a slow one, so this
         * gives up after a while rather than leaving the player staring at a
         * spinner. The usual cause is a wrong code, which is worth saying
         * plainly.
         */
        const timeout = setTimeout(() => {
          this.cb.onError('No house with that code. Check the letters and try again.');
          reject(new Error('timeout'));
        }, 12000);

        conn.on('open', () => {
          clearTimeout(timeout);
          conn.send({ t: 'join', version: PROTOCOL_VERSION, name });
          resolve();
        });

        conn.on('data', (raw) => this.receive(raw as HostMessage));
        conn.on('close', () => this.cb.onClosed('The host left.'));
        conn.on('error', (e) => this.cb.onError(`Connection problem: ${e}`));
      });

      peer.on('error', (err) => {
        const msg = String(err);
        if (msg.includes('peer-unavailable')) {
          this.cb.onError('No house with that code. Check the letters and try again.');
        } else {
          this.cb.onError(`Connection problem: ${msg}`);
        }
        reject(err);
      });
    });
  }

  private receive(msg: HostMessage): void {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'welcome':
        this.you = msg.you;
        this.cb.onLobby(msg.lobby);
        break;

      case 'lobby':
        this.cb.onLobby(msg.lobby);
        break;

      case 'start': {
        this.you = msg.assignments[this.you] ?? this.you;
        this.role = msg.roles[Object.keys(msg.roles).find((k) => msg.assignments[k] === this.you) ?? ''] ?? 'survivor';
        this.cb.onStart(this.you, this.role, msg.survivorCount, msg.seed);
        break;
      }

      case 'snap': {
        /*
         * Keep a short history rather than only the latest.
         *
         * Interpolation needs a snapshot either side of the playback time, so
         * the buffer holds about a second. Anything older is of no use to
         * anyone and would only grow without bound.
         */
        this.buffer.push({ time: msg.time, state: msg.state });
        while (this.buffer.length > 40) this.buffer.shift();

        // Track the host's clock so playback can be positioned against it.
        const now = performance.now() / 1000;
        this.clockOffset = msg.time - now;

        this.cb.onSnapshot(msg.state, msg.events);
        break;
      }

      case 'pong':
        this.ping = performance.now() - msg.sent;
        break;

      case 'kicked':
        this.cb.onClosed(msg.reason);
        this.close();
        break;
    }
  }

  /**
   * The world as it should look right now.
   *
   * Finds the two snapshots straddling the playback time and blends the
   * moving parts between them. Positions and angles interpolate; everything
   * else — who is alive, who has the key — is taken from the later snapshot,
   * because a half-dead survivor is not a meaningful thing to draw.
   */
  interpolated(): GameState | null {
    if (this.buffer.length === 0) return null;
    const target = performance.now() / 1000 + this.clockOffset - INTERP_DELAY;

    let a: Timed | null = null;
    let b: Timed | null = null;
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (this.buffer[i].time <= target) {
        a = this.buffer[i];
        b = this.buffer[i + 1] ?? null;
        break;
      }
    }
    // Before the buffer has filled, or after a stall, show the newest we have.
    if (!a) return this.buffer[0].state;
    if (!b) return a.state;

    const span = b.time - a.time;
    const t = span > 1e-6 ? Math.min(1, Math.max(0, (target - a.time) / span)) : 0;
    return blend(a.state, b.state, t);
  }

  sendIntent(intent: Intent): void {
    if (!this.conn?.open) return;
    this.conn.send({ t: 'input', intent, sent: performance.now() });
  }

  sendWants(wants: Role): void {
    if (!this.conn?.open) return;
    this.conn.send({ t: 'want', wants });
  }

  measurePing(): void {
    if (!this.conn?.open) return;
    this.pingSentAt = performance.now();
    this.conn.send({ t: 'ping', sent: this.pingSentAt });
  }

  close(): void {
    this.conn?.close();
    this.peer?.destroy();
    this.conn = null;
    this.peer = null;
  }
}

/**
 * Blend two snapshots.
 *
 * Only the continuous quantities are interpolated. Angles need the short way
 * round — blending a yaw of 3.1 toward -3.1 the direct way spins the body
 * most of a turn in the wrong direction, which is very visible on a figure
 * running past you.
 */
function blend(a: GameState, b: GameState, t: number): GameState {
  const lerp = (x: number, y: number) => x + (y - x) * t;
  const lerpAngle = (x: number, y: number) => {
    let d = (y - x) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return x + d * t;
  };

  // Structure and flags come from the later snapshot; only motion is blended.
  const out: GameState = {
    ...b,
    survivors: b.survivors.map((s) => {
      const prev = a.survivors.find((p) => p.id === s.id);
      if (!prev) return s;
      return {
        ...s,
        pos: {
          x: lerp(prev.pos.x, s.pos.x),
          y: lerp(prev.pos.y, s.pos.y),
          z: lerp(prev.pos.z, s.pos.z),
        },
        yaw: lerpAngle(prev.yaw, s.yaw),
        pitch: lerp(prev.pitch, s.pitch),
        stamina: lerp(prev.stamina, s.stamina),
      };
    }),
    ghost: {
      ...b.ghost,
      pos: {
        x: lerp(a.ghost.pos.x, b.ghost.pos.x),
        y: lerp(a.ghost.pos.y, b.ghost.pos.y),
        z: lerp(a.ghost.pos.z, b.ghost.pos.z),
      },
      yaw: lerpAngle(a.ghost.yaw, b.ghost.yaw),
      pitch: lerp(a.ghost.pitch, b.ghost.pitch),
    },
  };
  return out;
}
