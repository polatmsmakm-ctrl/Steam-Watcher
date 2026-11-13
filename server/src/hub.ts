import crypto from 'node:crypto';
import type { types as ms } from 'mediasoup';
import type { WebSocket } from 'ws';
import {
  AVATAR_COLORS, LIMITS, PROTOCOL_VERSION,
  type EventName, type Events, type FriendInfo, type JoinResult, type MethodName, type Methods, type PublicUser,
} from '../../shared/protocol.ts';
import { hashPassword, randomCode, RateLimiter, verifyPassword, type Tokens } from './auth.ts';
import type { Db } from './db.ts';
import { bad, forbidden, notFound, RpcError, str } from './errors.ts';
import type { Peer, PeerLink, RoomManager } from './rooms.ts';
import type { Sfu } from './sfu.ts';

type Handler<M extends MethodName> = (conn: Connection, data: Methods[M][0]) => Promise<Methods[M][1]> | Methods[M][1];

export class Connection implements PeerLink {
  readonly id = crypto.randomUUID();
  user?: PublicUser;
  peer?: Peer;
  alive = true;

  constructor(readonly ws: WebSocket, readonly origin: string) {}

  send(payload: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(payload));
  }

  notify<E extends EventName>(event: E, data: Events[E]): void {
    this.send({ event, data });
  }
}

/** Signaling: authenticates sockets and dispatches RPC calls to rooms / SFU / friends. */
export class Hub {
  private connections = new Set<Connection>();
  private byUser = new Map<string, Set<Connection>>();
  private joinAttempts = new RateLimiter(12, 60_000);
  private heartbeat: NodeJS.Timeout;
  private handlers: { [M in MethodName]: Handler<M> };

  constructor(
    private db: Db,
    private tokens: Tokens,
    private rooms: RoomManager,
    private sfu: Sfu,
    private log: (msg: string) => void,
  ) {
    this.handlers = this.buildHandlers();
    this.heartbeat = setInterval(() => {
      for (const c of this.connections) {
        if (!c.alive) c.ws.terminate();
        else {
          c.alive = false;
          c.ws.ping();
        }
      }
    }, 15_000);
    this.heartbeat.unref();
  }

  accept(ws: WebSocket, origin: string): void {
    const conn = new Connection(ws, origin);
    this.connections.add(conn);
    ws.on('pong', () => (conn.alive = true));
    ws.on('message', (raw) => void this.onMessage(conn, raw.toString()));
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => ws.terminate());
  }

  private closed = false;

  close(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const c of this.connections) c.ws.terminate();
  }

  get stats() {
    return { connections: this.connections.size, usersOnline: this.byUser.size, rooms: this.rooms.rooms.size };
  }

  private async onMessage(conn: Connection, raw: string): Promise<void> {
    let msg: { id?: unknown; method?: unknown; data?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return conn.ws.close(1003, 'invalid json');
    }
    const { id, method } = msg;
    if (typeof id !== 'number' || typeof method !== 'string') return;
    conn.alive = true;
    try {
      const handler = (this.handlers as Record<string, Handler<MethodName> | undefined>)[method];
      if (!Object.hasOwn(this.handlers, method) || !handler) throw new RpcError('UNKNOWN_METHOD', `Unknown method ${method}`);
      if (method !== 'auth' && !conn.user) throw new RpcError('UNAUTHENTICATED', 'Authenticate first');
      const data = await handler(conn, (msg.data ?? {}) as never);
      conn.send({ id, ok: true, data });
    } catch (e) {
      if (e instanceof RpcError) conn.send({ id, ok: false, error: { code: e.code, message: e.message } });
      else {
        this.log(`error in ${method}: ${e instanceof Error ? e.stack : String(e)}`);
        // mediasoup validation errors are caused by client input; surface their message.
        const message = e instanceof Error && e.name !== 'Error' ? e.message : 'Internal error';
        conn.send({ id, ok: false, error: { code: 'INTERNAL', message } });
      }
    }
  }

  private onClose(conn: Connection): void {
    if (this.closed) return;
    this.connections.delete(conn);
    if (conn.peer) this.rooms.removePeer(conn.peer, 'disconnected');
    conn.peer = undefined;
    if (conn.user) {
      const set = this.byUser.get(conn.user.id);
      set?.delete(conn);
      if (set && set.size === 0) {
        this.byUser.delete(conn.user.id);
        this.notifyFriends(conn.user.id);
      }
    }
  }

  private notifyUser<E extends EventName>(userId: string, event: E, data: Events[E]): void {
    for (const c of this.byUser.get(userId) ?? []) c.notify(event, data);
  }

  /** Presence or profile changed: friends refetch their list. */
  private notifyFriends(userId: string): void {
    for (const f of this.db.friendships(userId)) this.notifyUser(f.other, 'friends.changed', {});
  }

  private userInRoom(userId: string): boolean {
    for (const c of this.byUser.get(userId) ?? []) if (c.peer) return true;
    return false;
  }

  private joinResult(conn: Connection, peer: Peer): JoinResult {
    const room = peer.room;
    return {
      room: room.info(),
      peerId: peer.id,
      // Any member may see the invite: they already proved they hold it.
      inviteCode: room.inviteCode,
      inviteLink: this.rooms.inviteLink(room, conn.origin),
      iceServers: this.rooms.iceServers(peer.user.id),
      routerRtpCapabilities: room.router?.rtpCapabilities,
    };
  }

  private leave(conn: Connection): void {
    if (!conn.peer) return;
    const userId = conn.peer.user.id;
    this.rooms.removePeer(conn.peer, 'left');
    conn.peer = undefined;
    this.notifyFriends(userId);
  }

  private buildHandlers(): { [M in MethodName]: Handler<M> } {
    const peerOf = (conn: Connection): Peer => {
      // A kicked peer keeps its socket but is no longer in the room.
      if (!conn.peer || !conn.peer.room.peers.has(conn.peer.id)) {
        conn.peer = undefined;
        throw new RpcError('NOT_IN_ROOM', 'You are not in a room');
      }
      return conn.peer;
    };
    const sfuPeer = (conn: Connection): Peer & { room: { router: ms.Router; webRtcServer: ms.WebRtcServer } } => {
      const peer = peerOf(conn);
      if (!peer.room.router) throw bad('This room uses direct P2P media');
      return peer as never;
    };
    const transportOf = (peer: Peer, id: string): ms.WebRtcTransport => {
      const t = peer.transports.get(id);
      if (!t) throw notFound('Transport not found');
      return t;
    };
    const consumerOf = (peer: Peer, id: string): ms.Consumer => {
      const c = peer.consumers.get(id);
      if (!c) throw notFound('Consumer not found');
      return c;
    };

    return {
      auth: (conn, { token, protocol }) => {
        if (protocol !== PROTOCOL_VERSION) throw new RpcError('PROTOCOL_MISMATCH', 'Client and server versions differ. Update the app.');
        const payload = typeof token === 'string' ? this.tokens.verify(token) : null;
        if (!payload) throw new RpcError('UNAUTHENTICATED', 'Session expired. Sign in again.');
        const user = payload.guest ?? this.db.userById(payload.sub);
        if (!user) throw new RpcError('UNAUTHENTICATED', 'Account no longer exists.');
        if (conn.user) throw bad('Already authenticated');
        conn.user = user;
        let set = this.byUser.get(user.id);
        if (!set) this.byUser.set(user.id, (set = new Set()));
        set.add(conn);
        if (set.size === 1) this.notifyFriends(user.id);
        return { user };
      },

      'profile.update': (conn, data) => {
        const user = conn.user!;
        if (user.guest) throw forbidden('Guests cannot edit a profile');
        const displayName = data.displayName === undefined ? undefined
          : str(data.displayName, 'Display name', LIMITS.displayName.min, LIMITS.displayName.max);
        if (data.avatarColor !== undefined && !(AVATAR_COLORS as readonly string[]).includes(data.avatarColor)) throw bad('Unknown avatar colour');
        this.db.updateProfile(user.id, displayName, data.avatarColor);
        const updated = this.db.userById(user.id)!;
        // Keep every live session of this user in step.
        for (const c of this.byUser.get(user.id) ?? []) Object.assign(c.user!, updated);
        this.notifyFriends(user.id);
        return { user: updated };
      },

      'profile.changePassword': async (conn, data) => {
        const user = conn.user!;
        if (user.guest) throw forbidden('Guests have no password');
        const next = str(data.next, 'New password', LIMITS.password.min, LIMITS.password.max);
        const hash = this.db.passHash(user.id);
        if (!hash || typeof data.current !== 'string' || !(await verifyPassword(data.current, hash))) {
          throw forbidden('Current password is incorrect');
        }
        this.db.setPassHash(user.id, await hashPassword(next));
        return {};
      },

      'friends.list': (conn) => {
        const friends: FriendInfo[] = [];
        if (conn.user!.guest) return { friends };
        for (const f of this.db.friendships(conn.user!.id)) {
          const user = this.db.userById(f.other);
          if (!user) continue;
          const accepted = f.status === 'accepted';
          friends.push({
            user,
            status: f.status,
            // Presence is only disclosed to accepted friends.
            online: accepted && this.byUser.has(user.id),
            inRoom: accepted && this.userInRoom(user.id),
          });
        }
        return { friends };
      },

      'friends.request': (conn, data) => {
        const me = conn.user!;
        if (me.guest) throw forbidden('Sign in to add friends');
        const target = this.db.userByUsername(str(data.username, 'Username', 1, LIMITS.username.max));
        if (!target) throw notFound('No user with that username');
        if (target.id === me.id) throw bad('You cannot add yourself');
        const result = this.db.requestFriend(me.id, target.id);
        if (result === 'exists') throw bad('Already friends or request pending');
        this.notifyUser(target.id, 'friends.changed', {});
        this.notifyUser(me.id, 'friends.changed', {});
        return {};
      },

      'friends.respond': (conn, data) => {
        const me = conn.user!;
        const other = str(data.userId, 'userId', 1, 64);
        const ok = data.accept ? this.db.acceptFriend(me.id, other) : this.db.removeFriend(me.id, other);
        if (!ok) throw notFound('No such friend request');
        this.notifyUser(other, 'friends.changed', {});
        this.notifyUser(me.id, 'friends.changed', {});
        return {};
      },

      'friends.remove': (conn, data) => {
        const me = conn.user!;
        const other = str(data.userId, 'userId', 1, 64);
        if (!this.db.removeFriend(me.id, other)) throw notFound('Not in your friends list');
        this.notifyUser(other, 'friends.changed', {});
        this.notifyUser(me.id, 'friends.changed', {});
        return {};
      },

      'room.create': async (conn, data) => {
        this.leave(conn);
        const name = str(data.name, 'Room name', LIMITS.roomName.min, LIMITS.roomName.max);
        const room = await this.rooms.create(conn.user!, name, data.mode, data.maxParticipants);
        conn.peer = this.rooms.join(conn.user!, conn, { roomId: room.id });
        this.notifyFriends(conn.user!.id);
        return this.joinResult(conn, conn.peer);
      },

      'room.join': (conn, data) => {
        if (!this.joinAttempts.allow(conn.user!.id)) throw new RpcError('RATE_LIMITED', 'Too many attempts. Wait a minute.');
        this.leave(conn);
        conn.peer = this.rooms.join(conn.user!, conn, {
          inviteCode: typeof data.inviteCode === 'string' ? data.inviteCode : undefined,
          roomId: typeof data.roomId === 'string' ? data.roomId : undefined,
        });
        this.notifyFriends(conn.user!.id);
        return this.joinResult(conn, conn.peer);
      },

      'room.leave': (conn) => {
        this.leave(conn);
        return {};
      },

      'room.kick': (conn, data) => {
        const peer = peerOf(conn);
        const targetUser = peer.room.peers.get(data.peerId)?.user.id;
        this.rooms.kick(peer, data.peerId);
        if (targetUser) this.notifyFriends(targetUser);
        return {};
      },

      'room.setLocked': (conn, data) => {
        const peer = peerOf(conn);
        if (!peer.isOwner) throw forbidden('Only the room owner can lock the room');
        peer.room.locked = Boolean(data.locked);
        peer.room.broadcast('room.updated', { locked: peer.room.locked });
        return {};
      },

      'room.regenerateInvite': (conn) => {
        const peer = peerOf(conn);
        if (!peer.isOwner) throw forbidden('Only the room owner can reset the invite');
        peer.room.secret = randomCode(20);
        return { inviteCode: peer.room.inviteCode, inviteLink: this.rooms.inviteLink(peer.room, conn.origin) };
      },

      'room.inviteFriend': (conn, data) => {
        const peer = peerOf(conn);
        const friendId = str(data.userId, 'userId', 1, 64);
        if (!this.db.areFriends(peer.user.id, friendId)) throw forbidden('You can only invite friends');
        if (!this.byUser.has(friendId)) throw new RpcError('OFFLINE', 'That friend is offline');
        this.notifyUser(friendId, 'friends.invite', {
          from: peer.user,
          roomId: peer.room.id,
          roomName: peer.room.name,
          inviteCode: peer.room.inviteCode,
          sentAt: Date.now(),
        });
        return {};
      },

      'room.close': (conn) => {
        const peer = peerOf(conn);
        if (!peer.isOwner) throw forbidden('Only the room owner can close the room');
        const users = [...peer.room.peers.values()].map((p) => p.user.id);
        this.rooms.close(peer.room, 'closed');
        for (const c of this.connections) if (c.peer?.room === peer.room) c.peer = undefined;
        for (const u of users) this.notifyFriends(u);
        return {};
      },

      'media.createTransport': async (conn, data) => {
        const peer = sfuPeer(conn);
        if (data.direction !== 'send' && data.direction !== 'recv') throw bad('Bad direction');
        if (peer.transports.size >= 4) throw bad('Too many transports');
        const transport = await this.sfu.createTransport(peer.room.router, peer.room.webRtcServer, data.direction);
        peer.transports.set(transport.id, transport);
        transport.observer.once('close', () => peer.transports.delete(transport.id));
        return {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        };
      },

      'media.connectTransport': async (conn, data) => {
        await transportOf(sfuPeer(conn), data.transportId).connect({ dtlsParameters: data.dtlsParameters as ms.DtlsParameters });
        return {};
      },

      'media.restartIce': async (conn, data) => {
        return { iceParameters: await transportOf(sfuPeer(conn), data.transportId).restartIce() };
      },

      'media.produce': async (conn, data) => {
        const peer = sfuPeer(conn);
        const transport = transportOf(peer, data.transportId);
        if (transport.appData.direction !== 'send') throw bad('Not a send transport');
        const producer = await transport.produce({
          kind: data.kind,
          rtpParameters: data.rtpParameters as ms.RtpParameters,
          appData: { source: data.source },
        });
        try {
          this.rooms.publish(peer, producer.id, producer.kind, data.source);
        } catch (e) {
          producer.close();
          throw e;
        }
        peer.producers.set(producer.id, producer);
        producer.observer.once('close', () => this.rooms.unpublish(peer, producer.id));
        return { id: producer.id };
      },

      'media.consume': async (conn, data) => {
        const peer = sfuPeer(conn);
        const publication = peer.room.findPublication(data.producerId);
        if (!publication || publication.peerId === peer.id) throw notFound('Nothing to consume');
        const rtpCapabilities = data.rtpCapabilities as ms.RtpCapabilities;
        if (!peer.room.router.canConsume({ producerId: publication.id, rtpCapabilities })) {
          throw new RpcError('CANNOT_CONSUME', 'This device cannot decode the codec in use.');
        }
        const transport = [...peer.transports.values()].find((t) => t.appData.direction === 'recv');
        if (!transport) throw bad('Create a recv transport first');
        // Start paused; the client resumes once its receiver exists, so the first keyframe is not lost.
        const consumer = await transport.consume({ producerId: publication.id, rtpCapabilities, paused: true });
        peer.consumers.set(consumer.id, consumer);
        const closed = () => {
          if (peer.consumers.delete(consumer.id)) peer.link.notify('media.consumerClosed', { consumerId: consumer.id });
        };
        consumer.observer.once('close', closed);
        consumer.on('producerclose', closed);
        consumer.on('layerschange', (layers) =>
          peer.link.notify('media.consumerLayers', {
            consumerId: consumer.id,
            spatialLayer: layers?.spatialLayer ?? null,
            temporalLayer: layers?.temporalLayer ?? null,
          }),
        );
        return { id: consumer.id, producerId: publication.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters };
      },

      'media.resumeConsumer': async (conn, data) => {
        await consumerOf(sfuPeer(conn), data.consumerId).resume();
        return {};
      },

      'media.setPreferredLayers': async (conn, data) => {
        await consumerOf(sfuPeer(conn), data.consumerId).setPreferredLayers({
          spatialLayer: Math.trunc(Number(data.spatialLayer)) || 0,
          ...(data.temporalLayer === undefined ? {} : { temporalLayer: Math.trunc(Number(data.temporalLayer)) || 0 }),
        });
        return {};
      },

      'media.requestKeyFrame': async (conn, data) => {
        await consumerOf(sfuPeer(conn), data.consumerId).requestKeyFrame();
        return {};
      },

      'media.publish': (conn, data) => {
        const peer = peerOf(conn);
        if (peer.room.router) throw bad('SFU rooms publish through media.produce');
        if (data.kind !== 'audio' && data.kind !== 'video') throw bad('Bad kind');
        this.rooms.publish(peer, str(data.id, 'id', 8, 64), data.kind, data.source);
        return {};
      },

      'media.unpublish': (conn, data) => {
        this.rooms.unpublish(peerOf(conn), data.id);
        return {};
      },

      'media.setPaused': async (conn, data) => {
        const peer = peerOf(conn);
        const publication = peer.publications.get(data.id);
        if (!publication) throw notFound('Publication not found');
        publication.paused = Boolean(data.paused);
        const producer = peer.producers.get(data.id);
        if (producer) await (publication.paused ? producer.pause() : producer.resume());
        peer.room.broadcast('media.paused', { id: publication.id, peerId: peer.id, paused: publication.paused }, peer);
        return {};
      },

      'p2p.signal': (conn, data) => {
        const peer = peerOf(conn);
        if (peer.room.router) throw bad('Not a P2P room');
        const target = peer.room.peers.get(data.to);
        if (!target) throw notFound('Peer left');
        target.link.notify('p2p.signal', { from: peer.id, data: data.data });
        return {};
      },
    };
  }
}
