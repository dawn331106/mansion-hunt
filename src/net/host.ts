import Peer, { type DataConnection } from 'peerjs';
import type { Intent } from '../game/intent.js';
import { emptyIntent } from '../game/intent.js';
import type { Role } from '../game/types.js';
import {
  INPUT_HZ, PROTOCOL_VERSION, SNAPSHOT_HZ,
  makeRoomCode, peerIdForRoom,
  type ClientMessage, type HostMessage, type LobbyPlayer, type LobbyState,
  type NetEvents,
} from './protocol.js';

/**
 * The host: the machine that owns the truth.
 *
 * One player runs the simulation and everybody else watches it. That is the
 * simplest model that cannot be cheated in the ways that matter here — a
 * client never sends a position, only what it is trying to do, so nobody
 * walks through a wall or catches someone from across the house by lying.
 *
 * It also happens to be almost free to build, because the simulation was
 * written to take intents and nothing else. The host's own player is just
 * another entry in the intent map, indistinguishable from a remote one.
 *
 * The host is a player too, not a dedicated server. That is the whole reason
 * this needs no hosting: the game is static files, and the only shared
 * infrastructure is PeerJS's free signalling broker, which introduces peers to
 * each other and then gets out of the way.
 */

export interface HostedPeer {
  id: string;
  conn: DataConnection | null;   // null for the host's own local player
  name: string;
  wants: Role;
  ping: number;
  /** The most recent intent received. Held between packets. */
  intent: Intent;
  /** Sim time the last packet arrived, for dropping dead connections. */
  lastSeen: number;
}

export interface HostCallbacks {
  onLobby(lobby: LobbyState): void;
  onError(message: string): void;
  /** Fires once the host presses start and assignments are settled. */
  onStart(assignments: Record<string, string>, roles: Record<string, Role>): void;
}

/** Drop a peer that has not been heard from in this long. */
const TIMEOUT_SECONDS = 12;

export class GameHost {
  readonly code: string;
  private peer: Peer | null = null;
  readonly peers = new Map<string, HostedPeer>();
  private started = false;
  private bots = 2;
  private snapAccum = 0;

  /** The host's own id, which is also its actor id. */
  readonly localId = 'host';

  constructor(
    private readonly cb: HostCallbacks,
    localName: string,
    localWants: Role,
    code = makeRoomCode(),
  ) {
    this.code = code;
    this.peers.set(this.localId, {
      id: this.localId,
      conn: null,
      name: localName || 'Host',
      wants: localWants,
      ping: 0,
      intent: emptyIntent(),
      lastSeen: 0,
    });
  }

  /** Open the room. Resolves once the broker has assigned our id. */
  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const peer = new Peer(peerIdForRoom(this.code), { debug: 1 });
      this.peer = peer;

      peer.on('open', () => resolve());

      peer.on('error', (err) => {
        /*
         * A taken id means someone is already hosting under this code. That
         * is recoverable — pick another — but it has to surface, because the
         * alternative is a lobby that silently never receives anyone.
         */
        const msg = String(err);
        if (msg.includes('unavailable-id')) {
          this.cb.onError('That room code is already in use. Try again.');
        } else {
          this.cb.onError(`Connection problem: ${msg}`);
        }
        reject(err);
      });

      peer.on('connection', (conn) => this.accept(conn));
    });
  }

  private accept(conn: DataConnection): void {
    conn.on('open', () => {
      // Late joiners are refused rather than dropped into a running match:
      // there is no sensible actor to give them and no way to catch them up.
      if (this.started) {
        this.send(conn, { t: 'kicked', reason: 'That match has already begun.' });
        setTimeout(() => conn.close(), 250);
        return;
      }
      if (this.peers.size >= 8) {
        this.send(conn, { t: 'kicked', reason: 'That house is full.' });
        setTimeout(() => conn.close(), 250);
        return;
      }
    });

    conn.on('data', (raw) => this.receive(conn, raw as ClientMessage));

    conn.on('close', () => {
      this.peers.delete(conn.peer);
      this.broadcastLobby();
    });

    conn.on('error', () => {
      this.peers.delete(conn.peer);
      this.broadcastLobby();
    });
  }

  private receive(conn: DataConnection, msg: ClientMessage): void {
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'join': {
        if (msg.version !== PROTOCOL_VERSION) {
          this.send(conn, {
            t: 'kicked',
            reason: 'That copy of the game is a different version.',
          });
          setTimeout(() => conn.close(), 250);
          return;
        }
        const player: HostedPeer = {
          id: conn.peer,
          conn,
          name: (msg.name || 'Survivor').slice(0, 16),
          wants: 'survivor',
          ping: 0,
          intent: emptyIntent(),
          lastSeen: 0,
        };
        this.peers.set(conn.peer, player);
        this.send(conn, {
          t: 'welcome',
          version: PROTOCOL_VERSION,
          you: conn.peer,
          lobby: this.lobby(),
        });
        this.broadcastLobby();
        break;
      }

      case 'want': {
        const p = this.peers.get(conn.peer);
        if (!p || this.started) return;
        p.wants = msg.wants;
        this.broadcastLobby();
        break;
      }

      case 'input': {
        const p = this.peers.get(conn.peer);
        if (!p) return;
        p.intent = msg.intent;
        p.lastSeen = performance.now() / 1000;
        break;
      }

      case 'ping':
        this.send(conn, { t: 'pong', sent: msg.sent });
        break;
    }
  }

  // --- Lobby ---------------------------------------------------------------

  lobby(): LobbyState {
    const players: LobbyPlayer[] = [...this.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      wants: p.wants,
      isHost: p.id === this.localId,
      ping: Math.round(p.ping),
    }));
    return { code: this.code, players, started: this.started, bots: this.bots };
  }

  setLocalWants(role: Role): void {
    const me = this.peers.get(this.localId);
    if (me && !this.started) {
      me.wants = role;
      this.broadcastLobby();
    }
  }

  setBots(n: number): void {
    this.bots = Math.max(0, Math.min(4, n));
    this.broadcastLobby();
  }

  private broadcastLobby(): void {
    const lobby = this.lobby();
    this.cb.onLobby(lobby);
    this.broadcast({ t: 'lobby', lobby });
  }

  /**
   * Begin the match.
   *
   * Exactly one player is the ghost. If several asked, the first to have
   * asked wins and the rest become survivors — arbitrary, but it resolves
   * instantly and visibly, which matters more than fairness for something the
   * group can just re-pick in the lobby. If nobody asked, the host takes it,
   * because a match with no ghost is not a match.
   */
  start(): { assignments: Record<string, string>; roles: Record<string, Role>; survivorCount: number; seed: number } {
    const ids = [...this.peers.keys()];
    const wantsGhost = ids.filter((id) => this.peers.get(id)!.wants === 'ghost');
    const ghostId = wantsGhost[0] ?? this.localId;

    const assignments: Record<string, string> = {};
    const roles: Record<string, Role> = {};

    let n = 0;
    for (const id of ids) {
      if (id === ghostId) {
        assignments[id] = 'ghost';
        roles[id] = 'ghost';
      } else {
        assignments[id] = `s${n++}`;
        roles[id] = 'survivor';
      }
    }

    // Bots fill out the survivor side so a two-player game still has a hunt.
    const survivorCount = Math.max(1, n + this.bots);
    const seed = (Math.random() * 1e9) | 0;

    this.started = true;
    this.broadcast({ t: 'start', assignments, roles, survivorCount, seed });
    this.cb.onStart(assignments, roles);
    return { assignments, roles, survivorCount, seed };
  }

  // --- In-match ------------------------------------------------------------

  /** Every peer's latest intent, keyed by the actor it drives. */
  intents(assignments: Record<string, string>): Map<string, Intent> {
    const out = new Map<string, Intent>();
    for (const [peerId, actorId] of Object.entries(assignments)) {
      const p = this.peers.get(peerId);
      if (p) out.set(actorId, p.intent);
    }
    return out;
  }

  /** Set the host's own intent, exactly as a remote client would send one. */
  setLocalIntent(intent: Intent): void {
    const me = this.peers.get(this.localId);
    if (me) me.intent = intent;
  }

  /**
   * Broadcast the world, at a fixed rate rather than every frame.
   *
   * Sixty snapshots a second would be wasted: the network cannot usefully
   * carry them and clients interpolate between the ones they get. Twenty is
   * enough for a chase to read smoothly, and the accumulator keeps the rate
   * steady regardless of the host's frame rate.
   */
  maybeSnapshot(dt: number, state: unknown, events: NetEvents): void {
    this.snapAccum += dt;
    const period = 1 / SNAPSHOT_HZ;
    if (this.snapAccum < period) return;
    this.snapAccum = 0;

    const now = performance.now() / 1000;
    for (const p of this.peers.values()) {
      if (!p.conn) continue;
      // Drop peers that have gone quiet, so a crashed client does not leave a
      // motionless body standing in the house for the rest of the match.
      if (p.lastSeen > 0 && now - p.lastSeen > TIMEOUT_SECONDS) {
        p.conn.close();
        this.peers.delete(p.id);
        continue;
      }
      this.send(p.conn, {
        t: 'snap',
        time: now,
        state: state as never,
        events,
      });
    }
  }

  private send(conn: DataConnection, msg: HostMessage): void {
    try { conn.send(msg); } catch { /* the close handler will clean up */ }
  }

  private broadcast(msg: HostMessage): void {
    for (const p of this.peers.values()) {
      if (p.conn) this.send(p.conn, msg);
    }
  }

  close(): void {
    for (const p of this.peers.values()) p.conn?.close();
    this.peers.clear();
    this.peer?.destroy();
    this.peer = null;
  }
}

/** How often a client should send its intent, in seconds. */
export const INPUT_PERIOD = 1 / INPUT_HZ;
