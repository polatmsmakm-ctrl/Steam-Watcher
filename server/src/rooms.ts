import crypto from 'node:crypto';
import type { types as ms } from 'mediasoup';
import type {
  EventName, Events, IceServer, MediaKind, MediaSource, PeerInfo, Publication, PublicUser, RoomInfo, RoomMode,
} from '../../shared/protocol.ts';
import { randomCode, safeEqual } from './auth.ts';
import type { Config } from './config.ts';
import { bad, forbidden, notFound, RpcError } from './errors.ts';
import type { Sfu } from './sfu.ts';

/** What a room needs from a signaling connection. */
export interface PeerLink {
  notify<E extends EventName>(event: E, data: Events[E]): void;
}

export class Peer {
  readonly id = crypto.randomUUID();
  readonly joinedAt = Date.now();
  readonly transports = new Map<string, ms.WebRtcTransport>();
  readonly producers = new Map<string, ms.Producer>();
  readonly consumers = new Map<string, ms.Consumer>();
  readonly publications = new Map<string, Publication>();

  constructor(readonly user: PublicUser, readonly link: PeerLink, readonly room: Room) {}

  get isOwner(): boolean {
    return this.user.id === this.room.ownerId;
  }

  info(): PeerInfo {
    return {
      peerId: this.id,
      user: this.user,
      isOwner: this.isOwner,
      joinedAt: this.joinedAt,
      publications: [...this.publications.values()],
    };
  }

  closeMedia(): void {
    for (const t of this.transports.values()) t.close(); // closes its producers/consumers too
    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();
    this.publications.clear();
  }
}

export class Room {
  readonly createdAt = Date.now();
  readonly peers = new Map<string, Peer>();
  readonly banned = new Set<string>();
  locked = false;
  secret = randomCode(20);
  router?: ms.Router;
  webRtcServer?: ms.WebRtcServer;
  emptyTimer?: NodeJS.Timeout;

  constructor(
    readonly id: string,
    readonly name: string,
    readonly mode: RoomMode,
    readonly ownerId: string,
    readonly maxParticipants: number,
  ) {}

  /** One string carries both the room id and the access secret. */
  get inviteCode(): string {
    return `${this.id}-${this.secret}`;
  }

  info(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      mode: this.mode,
      ownerId: this.ownerId,
      locked: this.locked,
      maxParticipants: this.maxParticipants,
      createdAt: this.createdAt,
      peers: [...this.peers.values()].map((p) => p.info()),
    };
  }

  broadcast<E extends EventName>(event: E, data: Events[E], except?: Peer): void {
    for (const p of this.peers.values()) if (p !== except) p.link.notify(event, data);
  }

  findPublication(id: string): Publication | undefined {
    for (const p of this.peers.values()) {
      const pub = p.publications.get(id);
      if (pub) return pub;
    }
    return undefined;
  }
}

export const normalizeCode = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export class RoomManager {
  readonly rooms = new Map<string, Room>();

  constructor(private config: Config, private sfu: Sfu, private log: (msg: string) => void) {}

  async create(owner: PublicUser, name: string, mode: RoomMode, maxParticipants?: number): Promise<Room> {
    if (owner.guest) throw forbidden('Guests cannot create rooms. Sign in first.');
    if (mode !== 'sfu' && mode !== 'p2p') throw bad('Unknown room mode');
    const cap = this.config.maxRoomParticipants;
    const max = mode === 'p2p' ? 2 : Math.min(Math.max(Math.trunc(maxParticipants ?? cap), 2), cap);
    let id: string;
    do id = randomCode(9);
    while (this.rooms.has(id));
    const room = new Room(id, name, mode, owner.id, max);
    if (mode === 'sfu') Object.assign(room, await this.sfu.createRouter());
    this.rooms.set(id, room);
    this.log(`room ${id} created (${mode}) by ${owner.username}`);
    return room;
  }

  /**
   * Access check + admission. The owner may always re-enter their own room;
   * everyone else needs the current invite secret.
   */
  join(user: PublicUser, link: PeerLink, opts: { inviteCode?: string; roomId?: string }): Peer {
    const code = normalizeCode(opts.inviteCode ?? '');
    const roomId = code ? code.slice(0, 9) : normalizeCode(opts.roomId ?? '');
    const room = this.rooms.get(roomId);
    // Same error for "no such room" and "wrong secret" so room ids cannot be probed.
    const denied = new RpcError('INVALID_INVITE', 'This invite is invalid or has expired.');
    if (!room) throw denied;
    if (user.id !== room.ownerId) {
      if (!code || !safeEqual(code.slice(9), room.secret)) throw denied;
      if (room.banned.has(user.id)) throw forbidden('You were removed from this room by the owner.');
      if (room.locked) throw new RpcError('ROOM_LOCKED', 'The owner has locked this room.');
    }
    if (room.peers.size >= room.maxParticipants) throw new RpcError('ROOM_FULL', 'This room is full.');
    for (const existing of room.peers.values()) {
      // A reconnecting client may race its own stale connection; the newest one wins.
      if (existing.user.id === user.id) this.removePeer(existing, 'disconnected');
    }
    clearTimeout(room.emptyTimer);
    const peer = new Peer(user, link, room);
    room.peers.set(peer.id, peer);
    room.broadcast('room.peerJoined', { peer: peer.info() }, peer);
    return peer;
  }

  removePeer(peer: Peer, reason: 'left' | 'kicked' | 'disconnected'): void {
    const room = peer.room;
    if (!room.peers.delete(peer.id)) return;
    peer.closeMedia();
    room.broadcast('room.peerLeft', { peerId: peer.id, reason });
    if (room.peers.size === 0) {
      room.emptyTimer = setTimeout(() => this.close(room, 'closed'), this.config.emptyRoomTtlMs);
      room.emptyTimer.unref();
    }
  }

  kick(owner: Peer, targetPeerId: string): void {
    if (!owner.isOwner) throw forbidden('Only the room owner can remove participants.');
    const target = owner.room.peers.get(targetPeerId);
    if (!target) throw notFound('Participant not found');
    if (target === owner) throw bad('You cannot remove yourself');
    owner.room.banned.add(target.user.id);
    target.link.notify('room.closed', { reason: 'kicked' });
    this.removePeer(target, 'kicked');
  }

  close(room: Room, reason: 'closed'): void {
    if (!this.rooms.delete(room.id)) return;
    clearTimeout(room.emptyTimer);
    for (const peer of [...room.peers.values()]) {
      peer.link.notify('room.closed', { reason });
      room.peers.delete(peer.id);
      peer.closeMedia();
    }
    room.router?.close();
    this.log(`room ${room.id} closed`);
  }

  inviteLink(room: Room, origin: string): string {
    // The secret lives in the URL fragment so it never reaches HTTP logs.
    return `${this.config.publicUrl || origin}/#/join/${room.inviteCode}`;
  }

  iceServers(userId: string): IceServer[] {
    const { stunUrls, turnUrls, turnSecret, turnTtlSec } = this.config.ice;
    const servers: IceServer[] = [];
    if (stunUrls.length) servers.push({ urls: stunUrls });
    if (turnUrls.length && turnSecret) {
      // coturn REST credentials: username = "<expiry>:<id>", credential = HMAC-SHA1(secret, username)
      const username = `${Math.floor(Date.now() / 1000) + turnTtlSec}:${userId}`;
      const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
      servers.push({ urls: turnUrls, username, credential });
    }
    return servers;
  }

  /** Registers a publication and tells the other peers. Enforces one screen share per room. */
  publish(peer: Peer, id: string, kind: MediaKind, source: MediaSource): Publication {
    if (!['screen', 'screen-audio', 'mic'].includes(source)) throw bad('Unknown source');
    if ((source === 'screen') !== (kind === 'video')) throw bad('Source and kind do not match');
    if (source !== 'mic') {
      for (const other of peer.room.peers.values()) {
        if (other === peer) continue;
        for (const pub of other.publications.values()) {
          if (pub.source !== 'mic') throw new RpcError('SCREEN_BUSY', `${other.user.displayName} is already sharing in this room.`);
        }
      }
    }
    for (const pub of peer.publications.values()) {
      if (pub.source === source) throw bad(`You are already publishing ${source}`);
    }
    const publication: Publication = { id, peerId: peer.id, kind, source, paused: false };
    peer.publications.set(id, publication);
    peer.room.broadcast('media.published', { publication }, peer);
    this.log(`room ${peer.room.id}: ${peer.user.username} published ${source} (${id})`);
    return publication;
  }

  unpublish(peer: Peer, id: string): void {
    if (!peer.publications.delete(id)) return;
    peer.producers.get(id)?.close();
    peer.producers.delete(id);
    peer.room.broadcast('media.unpublished', { id, peerId: peer.id }, peer);
    this.log(`room ${peer.room.id}: ${peer.user.username} unpublished ${id}`);
  }

  closeAll(): void {
    for (const room of [...this.rooms.values()]) this.close(room, 'closed');
  }
}
