import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AVATAR_COLORS, type PublicUser } from '../../shared/protocol.ts';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_color: string;
  pass_hash: string;
}

export interface Friendship {
  other: string;
  status: 'accepted' | 'incoming' | 'outgoing';
}

const toUser = (r: UserRow): PublicUser => ({
  id: r.id,
  username: r.username,
  displayName: r.display_name,
  avatarColor: r.avatar_color,
  guest: false,
});

/** Accounts and friendships. Rooms and media state are in-memory only. */
export class Db {
  private db: DatabaseSync;

  constructor(dataDir: string | ':memory:') {
    if (dataDir === ':memory:') this.db = new DatabaseSync(':memory:');
    else {
      fs.mkdirSync(dataDir, { recursive: true });
      this.db = new DatabaseSync(path.join(dataDir, 'visionstream.db'));
      this.db.exec('PRAGMA journal_mode = WAL');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        avatar_color TEXT NOT NULL,
        pass_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS friendships (
        requester TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        addressee TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        accepted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (requester, addressee)
      );
      CREATE INDEX IF NOT EXISTS friendships_addressee ON friendships(addressee);
    `);
  }

  close(): void {
    this.db.close();
  }

  createUser(username: string, displayName: string, passHash: string): PublicUser | null {
    const id = crypto.randomUUID();
    const color = AVATAR_COLORS[crypto.randomInt(AVATAR_COLORS.length)]!;
    try {
      this.db
        .prepare('INSERT INTO users (id, username, display_name, avatar_color, pass_hash, created_at) VALUES (?,?,?,?,?,?)')
        .run(id, username, displayName, color, passHash, Date.now());
    } catch (e) {
      if (String(e).includes('UNIQUE')) return null;
      throw e;
    }
    return { id, username, displayName, avatarColor: color, guest: false };
  }

  private row(where: 'id' | 'username', value: string): UserRow | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE ${where} = ?`).get(value) as UserRow | undefined;
  }

  userById(id: string): PublicUser | null {
    const r = this.row('id', id);
    return r ? toUser(r) : null;
  }

  userByUsername(username: string): PublicUser | null {
    const r = this.row('username', username);
    return r ? toUser(r) : null;
  }

  credentials(username: string): { user: PublicUser; passHash: string } | null {
    const r = this.row('username', username);
    return r ? { user: toUser(r), passHash: r.pass_hash } : null;
  }

  passHash(id: string): string | null {
    return this.row('id', id)?.pass_hash ?? null;
  }

  updateProfile(id: string, displayName?: string, avatarColor?: string): void {
    if (displayName !== undefined) this.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, id);
    if (avatarColor !== undefined) this.db.prepare('UPDATE users SET avatar_color = ? WHERE id = ?').run(avatarColor, id);
  }

  setPassHash(id: string, passHash: string): void {
    this.db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(passHash, id);
  }

  friendships(userId: string): Friendship[] {
    const rows = this.db
      .prepare('SELECT requester, addressee, accepted FROM friendships WHERE requester = ? OR addressee = ?')
      .all(userId, userId) as { requester: string; addressee: string; accepted: number }[];
    return rows.map((r) => ({
      other: r.requester === userId ? r.addressee : r.requester,
      status: r.accepted ? 'accepted' : r.requester === userId ? 'outgoing' : 'incoming',
    }));
  }

  areFriends(a: string, b: string): boolean {
    return this.friendships(a).some((f) => f.other === b && f.status === 'accepted');
  }

  /** Returns the resulting state. A request towards someone who already asked us is an accept. */
  requestFriend(from: string, to: string): 'requested' | 'accepted' | 'exists' {
    const existing = this.friendships(from).find((f) => f.other === to);
    if (existing?.status === 'incoming') {
      this.acceptFriend(from, to);
      return 'accepted';
    }
    if (existing) return 'exists';
    this.db.prepare('INSERT INTO friendships (requester, addressee, accepted, created_at) VALUES (?,?,0,?)').run(from, to, Date.now());
    return 'requested';
  }

  /** `me` accepts a request that `requester` sent. */
  acceptFriend(me: string, requester: string): boolean {
    const r = this.db.prepare('UPDATE friendships SET accepted = 1 WHERE requester = ? AND addressee = ? AND accepted = 0').run(requester, me);
    return r.changes > 0;
  }

  removeFriend(a: string, b: string): boolean {
    const r = this.db
      .prepare('DELETE FROM friendships WHERE (requester = ? AND addressee = ?) OR (requester = ? AND addressee = ?)')
      .run(a, b, b, a);
    return r.changes > 0;
  }
}
