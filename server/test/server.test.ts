import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { api, Client, rejects, startTestApp } from './helpers.ts';

let app: Awaited<ReturnType<typeof startTestApp>>;
before(async () => { app = await startTestApp({ MAX_ROOM_PARTICIPANTS: '3' }); });
after(() => app.close());

describe('authentication', () => {
  test('register, login, reject bad credentials and duplicates', async () => {
    const reg = await api(app.url, '/api/auth/register', { username: 'alice', password: 'password123', displayName: 'Alice' });
    assert.equal(reg.status, 200);
    assert.equal(reg.body.user.username, 'alice');
    assert.equal((await api(app.url, '/api/auth/register', { username: 'ALICE', password: 'password123' })).body.error?.code, 'USERNAME_TAKEN');
    assert.equal((await api(app.url, '/api/auth/register', { username: 'bo', password: 'password123' })).status, 400);
    assert.equal((await api(app.url, '/api/auth/register', { username: 'shortpw', password: 'short' })).status, 400);
    assert.equal((await api(app.url, '/api/auth/login', { username: 'alice', password: 'password123' })).status, 200);
    assert.equal((await api(app.url, '/api/auth/login', { username: 'alice', password: 'wrong-password' })).body.error?.code, 'BAD_CREDENTIALS');
    assert.equal((await api(app.url, '/api/auth/login', { username: 'nobody', password: 'password123' })).body.error?.code, 'BAD_CREDENTIALS');
  });

  test('socket requires a valid token before anything else', async () => {
    const ws = new WebSocket(app.url.replace('http', 'ws') + '/ws');
    await new Promise((r) => ws.once('open', r));
    const reply = (payload: unknown) => new Promise<{ ok: boolean; error?: { code: string } }>((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
      ws.send(JSON.stringify(payload));
    });
    assert.equal((await reply({ id: 1, method: 'friends.list', data: {} })).error?.code, 'UNAUTHENTICATED');
    assert.equal((await reply({ id: 2, method: 'auth', data: { token: 'a.b.c', protocol: 1 } })).error?.code, 'UNAUTHENTICATED');
    assert.equal((await reply({ id: 3, method: 'constructor', data: {} })).error?.code, 'UNKNOWN_METHOD');
    ws.close();
  });

  test('tampered token is rejected', async () => {
    const { body } = await api(app.url, '/api/auth/register', { username: 'mallory', password: 'password123' });
    const [h, p, s] = body.token.split('.');
    const forged = JSON.parse(Buffer.from(p!, 'base64url').toString());
    forged.sub = 'someone-else';
    const token = `${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`;
    await assert.rejects(Client.connect(app.url, { ...body, token }));
  });

  test('change password requires the current one', async () => {
    const c = await Client.register(app.url, 'pwuser');
    await rejects(c.call('profile.changePassword', { current: 'nope', next: 'newpassword1' }), 'FORBIDDEN');
    await c.call('profile.changePassword', { current: 'password123', next: 'newpassword1' });
    assert.equal((await api(app.url, '/api/auth/login', { username: 'pwuser', password: 'newpassword1' })).status, 200);
    c.close();
  });
});

describe('http', () => {
  test('health endpoint, unknown API route, malformed and traversal paths', async () => {
    const health = await (await fetch(`${app.url}/api/health`)).json() as { ok: boolean; name: string; workers: unknown[] };
    assert.equal(health.ok, true);
    assert.equal(health.name, 'vision-stream');
    assert.equal(health.workers.length, 1);
    assert.equal((await fetch(`${app.url}/api/nope`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(`${app.url}/%E0%A4%A`)).status, 400);
    const traversal = await fetch(`${app.url}/..%2F..%2F..%2Fetc%2Fpasswd`);
    assert.ok(!(await traversal.text()).includes('root:'), 'must not serve files outside the web directory');
    assert.equal((await fetch(`${app.url}/api/health`)).status, 200, 'server still alive');
  });
});

describe('friends', () => {
  test('request, accept, presence, remove', async () => {
    const a = await Client.register(app.url, 'fra');
    const b = await Client.register(app.url, 'frb');
    await rejects(a.call('friends.request', { username: 'fra' }), 'BAD_REQUEST');
    await rejects(a.call('friends.request', { username: 'ghost' }), 'NOT_FOUND');
    await a.call('friends.request', { username: 'FRB' });
    await b.next('friends.changed');
    let list = (await b.call('friends.list', {})).friends;
    assert.deepEqual(list.map((f) => [f.user.username, f.status, f.online]), [['fra', 'incoming', false]]);
    await b.call('friends.respond', { userId: a.auth.user.id, accept: true });
    list = (await a.call('friends.list', {})).friends;
    assert.deepEqual(list.map((f) => [f.user.username, f.status, f.online]), [['frb', 'accepted', true]]);
    a.events.length = 0;
    b.close();
    await a.next('friends.changed');
    assert.equal((await a.call('friends.list', {})).friends[0]!.online, false);
    await a.call('friends.remove', { userId: b.auth.user.id });
    assert.equal((await a.call('friends.list', {})).friends.length, 0);
    a.close();
  });
});

describe('rooms', () => {
  test('private access: invite required, lock, kick + ban, capacity, invite reset', async () => {
    const owner = await Client.register(app.url, 'owner');
    const v1 = await Client.register(app.url, 'viewer1');
    const v2 = await Client.register(app.url, 'viewer2');
    const v3 = await Client.register(app.url, 'viewer3');

    const created = await owner.call('room.create', { name: 'Game night', mode: 'sfu' });
    const { room, inviteCode, inviteLink } = created;
    assert.match(room.id, /^[2-9A-Z]{9}$/);
    assert.ok(inviteLink!.endsWith(`/#/join/${inviteCode}`));
    assert.ok(created.routerRtpCapabilities);

    await rejects(v1.call('room.join', { roomId: room.id }), 'INVALID_INVITE');
    await rejects(v1.call('room.join', { inviteCode: `${room.id}-AAAAAAAAAAAAAAAAAAAA` }), 'INVALID_INVITE');
    await rejects(v1.call('room.join', { inviteCode: 'ZZZZZZZZZ-AAAAAAAAAAAAAAAAAAAA' }), 'INVALID_INVITE');

    // Codes are case- and punctuation-insensitive, so they survive being typed or pasted from a link.
    const joined = await v1.call('room.join', { inviteCode: inviteCode!.toLowerCase().replace('-', ' ') });
    assert.equal(joined.room.peers.length, 2);
    assert.equal((await owner.next('room.peerJoined')).peer.user.username, 'viewer1');

    await owner.call('room.setLocked', { locked: true });
    await rejects(v2.call('room.join', { inviteCode }), 'ROOM_LOCKED');
    await rejects(v1.call('room.setLocked', { locked: false }), 'FORBIDDEN');
    await owner.call('room.setLocked', { locked: false });
    await v2.call('room.join', { inviteCode });
    await rejects(v3.call('room.join', { inviteCode }), 'ROOM_FULL');

    await rejects(v1.call('room.kick', { peerId: created.peerId }), 'FORBIDDEN');
    await owner.call('room.kick', { peerId: joined.peerId });
    assert.equal((await v1.next('room.closed')).reason, 'kicked');
    await rejects(v1.call('room.join', { inviteCode }), 'FORBIDDEN');
    await rejects(v1.call('media.createTransport', { direction: 'recv' }), 'NOT_IN_ROOM');

    const fresh = await owner.call('room.regenerateInvite', {});
    assert.notEqual(fresh.inviteCode, inviteCode);
    await rejects(v3.call('room.join', { inviteCode }), 'INVALID_INVITE');
    await v3.call('room.join', { inviteCode: fresh.inviteCode });

    await owner.call('room.close', {});
    assert.equal((await v3.next('room.closed')).reason, 'closed');
    await rejects(v3.call('room.join', { inviteCode: fresh.inviteCode }), 'INVALID_INVITE');
    for (const c of [owner, v1, v2, v3]) c.close();
  });

  test('guests can join with an invite but cannot create rooms', async () => {
    const owner = await Client.register(app.url, 'host2');
    const { inviteCode } = await owner.call('room.create', { name: 'r', mode: 'sfu' });
    const g = await api(app.url, '/api/auth/guest', { displayName: 'Visitor' });
    assert.equal(g.status, 200);
    const guest = await Client.connect(app.url, g.body);
    await rejects(guest.call('room.create', { name: 'x', mode: 'sfu' }), 'FORBIDDEN');
    const joined = await guest.call('room.join', { inviteCode });
    assert.equal(joined.room.peers.find((p) => p.peerId === joined.peerId)!.user.guest, true);
    owner.close(); guest.close();
  });

  test('owner can re-enter without a code; disconnect is announced', async () => {
    const owner = await Client.register(app.url, 'host3');
    const viewer = await Client.register(app.url, 'guest3');
    const { room, inviteCode, peerId } = await owner.call('room.create', { name: 'r', mode: 'sfu' });
    await viewer.call('room.join', { inviteCode });
    owner.ws.terminate();
    const left = await viewer.next('room.peerLeft');
    assert.deepEqual(left, { peerId, reason: 'disconnected' });
    const again = await Client.connect(app.url, owner.auth);
    const rejoined = await again.call('room.join', { roomId: room.id });
    assert.equal(rejoined.room.peers.length, 2);
    again.close(); viewer.close();
  });

  test('friend invites deliver the room code to online friends only', async () => {
    const a = await Client.register(app.url, 'inv_a');
    const b = await Client.register(app.url, 'inv_b');
    const c = await Client.register(app.url, 'inv_c');
    await a.call('friends.request', { username: 'inv_b' });
    await b.call('friends.respond', { userId: a.auth.user.id, accept: true });
    const { inviteCode } = await a.call('room.create', { name: 'Invite test', mode: 'sfu' });
    await rejects(a.call('room.inviteFriend', { userId: c.auth.user.id }), 'FORBIDDEN');
    await a.call('room.inviteFriend', { userId: b.auth.user.id });
    const invite = await b.next('friends.invite');
    assert.equal(invite.inviteCode, inviteCode);
    assert.equal(invite.from.username, 'inv_a');
    for (const x of [a, b, c]) x.close();
  });
});

describe('media signaling', () => {
  test('SFU transports are created per room member; consume validates input', async () => {
    const owner = await Client.register(app.url, 'm_owner');
    await rejects(owner.call('media.createTransport', { direction: 'send' }), 'NOT_IN_ROOM');
    await owner.call('room.create', { name: 'r', mode: 'sfu' });
    const t = await owner.call('media.createTransport', { direction: 'send' });
    assert.ok(t.id && (t.iceCandidates as unknown[]).length >= 1);
    await rejects(owner.call('media.consume', { producerId: 'nope', rtpCapabilities: {} }), 'NOT_FOUND');
    await rejects(owner.call('media.publish', { id: 'abcdefgh', kind: 'video', source: 'screen' }), 'BAD_REQUEST');
    owner.close();
  });

  test('P2P rooms: 2 peers max, publications announced, signaling relayed, one sharer', async () => {
    const a = await Client.register(app.url, 'p_a');
    const b = await Client.register(app.url, 'p_b');
    const c = await Client.register(app.url, 'p_c');
    const created = await a.call('room.create', { name: 'direct', mode: 'p2p' });
    assert.equal(created.room.maxParticipants, 2);
    assert.equal(created.routerRtpCapabilities, undefined);
    const joined = await b.call('room.join', { inviteCode: created.inviteCode });
    await rejects(c.call('room.join', { inviteCode: created.inviteCode }), 'ROOM_FULL');
    await rejects(a.call('media.createTransport', { direction: 'send' }), 'BAD_REQUEST');

    await a.call('media.publish', { id: 'pub-screen-1', kind: 'video', source: 'screen' });
    assert.equal((await b.next('media.published')).publication.source, 'screen');
    await rejects(b.call('media.publish', { id: 'pub-screen-2', kind: 'video', source: 'screen' }), 'SCREEN_BUSY');
    await rejects(a.call('media.publish', { id: 'pub-screen-3', kind: 'audio', source: 'screen' }), 'BAD_REQUEST');
    await b.call('media.publish', { id: 'pub-mic-0001', kind: 'audio', source: 'mic' });

    await a.call('media.setPaused', { id: 'pub-screen-1', paused: true });
    assert.deepEqual(await b.next('media.paused'), { id: 'pub-screen-1', peerId: created.peerId, paused: true });

    await a.call('p2p.signal', { to: joined.peerId, data: { sdp: 'x' } });
    assert.deepEqual(await b.next('p2p.signal'), { from: created.peerId, data: { sdp: 'x' } });

    await a.call('media.unpublish', { id: 'pub-screen-1' });
    assert.equal((await b.next('media.unpublished')).id, 'pub-screen-1');
    await b.call('media.publish', { id: 'pub-screen-2', kind: 'video', source: 'screen' });
    for (const x of [a, b, c]) x.close();
  });

  test('auth endpoints are rate limited per IP', async () => {
    const limited = await startTestApp({ AUTH_RATE_LIMIT: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await api(limited.url, '/api/auth/login', { username: 'x', password: 'y' })).status);
    assert.deepEqual(codes, [400, 400, 400, 429, 429]);
    await limited.close();
  });

  test('TURN credentials are time-limited HMACs', async () => {
    const turnApp = await startTestApp({ TURN_URLS: 'turn:turn.example.com:3478', TURN_SECRET: 's3cret' });
    const u = await Client.register(turnApp.url, 'turnuser');
    const { iceServers } = await u.call('room.create', { name: 'r', mode: 'p2p' });
    const turn = iceServers.find((s) => s.urls[0]!.startsWith('turn:'))!;
    const expiry = Number(turn.username!.split(':')[0]);
    assert.ok(expiry > Date.now() / 1000 && expiry < Date.now() / 1000 + 7 * 3600);
    const { createHmac } = await import('node:crypto');
    assert.equal(turn.credential, createHmac('sha1', 's3cret').update(turn.username!).digest('base64'));
    u.close();
    await turnApp.close();
  });
});
