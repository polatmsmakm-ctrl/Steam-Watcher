/**
 * Wire protocol shared by the room service (server/) and the client (app/).
 * Types only, plus a few constants — no runtime dependencies.
 *
 * Transport: one WebSocket per client at `/ws`, JSON text frames.
 *   request      -> { id, method, data }
 *   response     <- { id, ok: true, data } | { id, ok: false, error: { code, message } }
 *   notification <- { event, data }
 */

export const PROTOCOL_VERSION = 1;

export type MediaKind = 'audio' | 'video';
/** What a published track carries. */
export type MediaSource = 'screen' | 'screen-audio' | 'mic';
/** `sfu`: media fans out through the mediasoup SFU. `p2p`: direct 1:1 WebRTC. */
export type RoomMode = 'sfu' | 'p2p';

export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  guest: boolean;
}

export interface Publication {
  /** SFU mode: mediasoup producer id. P2P mode: client-generated id. */
  id: string;
  peerId: string;
  kind: MediaKind;
  source: MediaSource;
  paused: boolean;
}

export interface PeerInfo {
  peerId: string;
  user: PublicUser;
  isOwner: boolean;
  joinedAt: number;
  publications: Publication[];
}

export interface RoomInfo {
  id: string;
  name: string;
  mode: RoomMode;
  ownerId: string;
  locked: boolean;
  maxParticipants: number;
  createdAt: number;
  peers: PeerInfo[];
}

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface FriendInfo {
  user: PublicUser;
  status: 'accepted' | 'incoming' | 'outgoing';
  online: boolean;
  /** Room the friend is currently in (id only — joining still needs an invite). */
  inRoom: boolean;
}

export interface RoomInvite {
  from: PublicUser;
  roomId: string;
  roomName: string;
  inviteCode: string;
  sentAt: number;
}

export interface AuthResult {
  token: string;
  user: PublicUser;
}

export interface JoinResult {
  room: RoomInfo;
  peerId: string;
  /** Present for the owner only. */
  inviteCode?: string;
  inviteLink?: string;
  iceServers: IceServer[];
  /** SFU mode only: mediasoup router RTP capabilities. */
  routerRtpCapabilities?: unknown;
}

export interface TransportParams {
  id: string;
  iceParameters: unknown;
  iceCandidates: unknown[];
  dtlsParameters: unknown;
}

export interface ConsumeResult {
  id: string;
  producerId: string;
  kind: MediaKind;
  rtpParameters: unknown;
}

/** method -> [request data, response data] */
export interface Methods {
  'auth': [{ token: string; protocol: number }, { user: PublicUser }];
  'profile.update': [{ displayName?: string; avatarColor?: string }, { user: PublicUser }];
  'profile.changePassword': [{ current: string; next: string }, {}];

  'friends.list': [{}, { friends: FriendInfo[] }];
  'friends.request': [{ username: string }, {}];
  'friends.respond': [{ userId: string; accept: boolean }, {}];
  'friends.remove': [{ userId: string }, {}];

  'room.create': [{ name: string; mode: RoomMode; maxParticipants?: number }, JoinResult];
  'room.join': [{ inviteCode?: string; roomId?: string }, JoinResult];
  'room.leave': [{}, {}];
  'room.kick': [{ peerId: string }, {}];
  'room.setLocked': [{ locked: boolean }, {}];
  'room.regenerateInvite': [{}, { inviteCode: string; inviteLink: string }];
  'room.inviteFriend': [{ userId: string }, {}];
  'room.close': [{}, {}];

  'media.createTransport': [{ direction: 'send' | 'recv' }, TransportParams];
  'media.connectTransport': [{ transportId: string; dtlsParameters: unknown }, {}];
  'media.restartIce': [{ transportId: string }, { iceParameters: unknown }];
  'media.produce': [
    { transportId: string; kind: MediaKind; rtpParameters: unknown; source: MediaSource },
    { id: string },
  ];
  'media.consume': [{ producerId: string; rtpCapabilities: unknown }, ConsumeResult];
  'media.resumeConsumer': [{ consumerId: string }, {}];
  'media.setPreferredLayers': [{ consumerId: string; spatialLayer: number; temporalLayer?: number }, {}];
  'media.requestKeyFrame': [{ consumerId: string }, {}];

  /** P2P mode: announce a track (SFU mode announces through media.produce). */
  'media.publish': [{ id: string; kind: MediaKind; source: MediaSource }, {}];
  /** Both modes. */
  'media.unpublish': [{ id: string }, {}];
  'media.setPaused': [{ id: string; paused: boolean }, {}];

  /** P2P mode: relay an opaque signaling blob to the other peer. */
  'p2p.signal': [{ to: string; data: unknown }, {}];
}

export interface Events {
  'room.peerJoined': { peer: PeerInfo };
  'room.peerLeft': { peerId: string; reason: 'left' | 'kicked' | 'disconnected' };
  'room.updated': { locked: boolean };
  'room.closed': { reason: 'kicked' | 'closed' };
  'media.published': { publication: Publication };
  'media.unpublished': { id: string; peerId: string };
  'media.paused': { id: string; peerId: string; paused: boolean };
  'media.consumerClosed': { consumerId: string };
  'media.consumerLayers': { consumerId: string; spatialLayer: number | null; temporalLayer: number | null };
  'p2p.signal': { from: string; data: unknown };
  'friends.changed': {};
  'friends.invite': RoomInvite;
}

export type MethodName = keyof Methods;
export type EventName = keyof Events;

export interface RpcErrorBody {
  code: string;
  message: string;
}

export const AVATAR_COLORS = [
  '#7c5cff', '#4f8cff', '#22c1a6', '#f5a524', '#ef5a6f', '#c96bff', '#3ecf8e', '#ff8a4c',
] as const;

export const LIMITS = {
  username: { min: 3, max: 24 },
  password: { min: 8, max: 128 },
  displayName: { min: 1, max: 32 },
  roomName: { min: 1, max: 48 },
} as const;
