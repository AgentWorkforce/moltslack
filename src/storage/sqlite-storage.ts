/**
 * SQLite Storage Adapter for Moltslack
 * Provides persistent storage for messages, agents, channels, and presence
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { Message } from '../schemas/models.js';
import type { StorageInterface, StoredAgent, StoredPresence, StoredChannel } from './storage-interface.js';

// Re-export types for backwards compatibility
export type { StoredAgent, StoredPresence, StoredChannel } from './storage-interface.js';

export interface SqliteStorageOptions {
  dbPath: string;
  /** Message retention period in milliseconds (default: 2 days, env: MESSAGE_RETENTION_DAYS) */
  messageRetentionMs?: number;
  /** Auto-cleanup interval in milliseconds (default: 1 hour, env: MESSAGE_CLEANUP_INTERVAL_HOURS) */
  cleanupIntervalMs?: number;
}

/** Default retention: 2 days */
const DEFAULT_RETENTION_DAYS = 2;
const DEFAULT_RETENTION_MS = DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** Default cleanup interval: 1 hour */
const DEFAULT_CLEANUP_INTERVAL_HOURS = 1;
const DEFAULT_CLEANUP_INTERVAL_MS = DEFAULT_CLEANUP_INTERVAL_HOURS * 60 * 60 * 1000;

/** Parse retention from environment variables */
function getRetentionMs(): number {
  const days = process.env.MESSAGE_RETENTION_DAYS;
  if (days) {
    const parsed = parseFloat(days);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed * 24 * 60 * 60 * 1000;
    }
  }
  return DEFAULT_RETENTION_MS;
}

/** Parse cleanup interval from environment variables */
function getCleanupIntervalMs(): number {
  const hours = process.env.MESSAGE_CLEANUP_INTERVAL_HOURS;
  if (hours) {
    const parsed = parseFloat(hours);
    if (!isNaN(parsed) && parsed >= 0) {
      return parsed * 60 * 60 * 1000;
    }
  }
  return DEFAULT_CLEANUP_INTERVAL_MS;
}

type SqliteDriverName = 'better-sqlite3' | 'node';

interface SqliteStatement {
  run: (...params: any[]) => unknown;
  all: (...params: any[]) => any[];
  get: (...params: any[]) => any;
}

interface SqliteDatabase {
  exec: (sql: string) => void;
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
  pragma?: (value: string) => void;
}

export class SqliteStorage {
  private dbPath: string;
  private db?: SqliteDatabase;
  private driver?: SqliteDriverName;
  private retentionMs: number;
  private cleanupIntervalMs: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  // Prepared statements
  private insertMessageStmt?: SqliteStatement;
  private insertAgentStmt?: SqliteStatement;
  private insertChannelStmt?: SqliteStatement;
  private insertPresenceStmt?: SqliteStatement;

  constructor(options: SqliteStorageOptions) {
    this.dbPath = options.dbPath;
    this.retentionMs = options.messageRetentionMs ?? getRetentionMs();
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? getCleanupIntervalMs();

    const retentionDays = this.retentionMs / (24 * 60 * 60 * 1000);
    const cleanupHours = this.cleanupIntervalMs / (60 * 60 * 1000);
    console.log(`[storage] Message retention: ${retentionDays} days, cleanup interval: ${cleanupHours} hours`);
  }

  private resolvePreferredDriver(): SqliteDriverName | undefined {
    const raw = process.env.MOLTSLACK_SQLITE_DRIVER?.trim().toLowerCase();
    if (!raw) return undefined;
    if (raw === 'node' || raw === 'node:sqlite') return 'node';
    if (raw === 'better-sqlite3' || raw === 'better') return 'better-sqlite3';
    return undefined;
  }

  private async openDatabase(driver: SqliteDriverName): Promise<SqliteDatabase> {
    if (driver === 'node') {
      const require = createRequire(import.meta.url);
      const mod: any = require('node:sqlite');
      const db: any = new mod.DatabaseSync(this.dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      return db as SqliteDatabase;
    }

    // @ts-ignore - better-sqlite3 may not have types installed
    const mod = await import('better-sqlite3');
    const DatabaseCtor: any = (mod as any).default ?? mod;
    const db: any = new DatabaseCtor(this.dbPath);
    if (typeof db.pragma === 'function') {
      db.pragma('journal_mode = WAL');
    } else {
      db.exec('PRAGMA journal_mode = WAL;');
    }
    return db as SqliteDatabase;
  }

  async init(): Promise<void> {
    console.log(`[storage] Initializing SQLite at path: ${this.dbPath}`);
    const dir = path.dirname(this.dbPath);
    console.log(`[storage] Database directory: ${dir}`);
    console.log(`[storage] Directory exists: ${fs.existsSync(dir)}`);

    if (!fs.existsSync(dir)) {
      console.log(`[storage] Creating directory: ${dir}`);
      fs.mkdirSync(dir, { recursive: true });
    }

    // List contents of directory to verify volume mount
    try {
      const files = fs.readdirSync(dir);
      console.log(`[storage] Files in ${dir}: ${files.join(', ') || '(empty)'}`);
    } catch (e) {
      console.log(`[storage] Cannot read directory ${dir}: ${e}`);
    }

    const preferred = this.resolvePreferredDriver();
    const attempts: SqliteDriverName[] = preferred
      ? [preferred, preferred === 'better-sqlite3' ? 'node' : 'better-sqlite3']
      : ['better-sqlite3', 'node'];

    let lastError: unknown = null;
    for (const driver of attempts) {
      try {
        this.db = await this.openDatabase(driver);
        this.driver = driver;
        lastError = null;
        console.log(`[storage] Using SQLite driver: ${driver}`);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[storage] SQLite driver "${driver}" failed: ${msg}`);
        lastError = err;
      }
    }

    if (!this.db) {
      throw new Error(
        `Failed to initialize SQLite storage at ${this.dbPath}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
      );
    }

    // Create tables
    this.createTables();

    // Prepare statements
    this.prepareStatements();

    // Start automatic cleanup if enabled
    if (this.cleanupIntervalMs > 0) {
      this.startCleanupTimer();
    }

    console.log(`[storage] SQLite storage initialized at ${this.dbPath}`);
  }

  private createTables(): void {
    if (!this.db) return;

    // Messages table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        thread_id TEXT,
        correlation_id TEXT,
        signature TEXT NOT NULL,
        delivery_status TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        edited_at TEXT,
        deleted_at TEXT,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_target ON messages (target_id);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id);
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts);
    `);

    // Agents table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        capabilities TEXT,
        permissions TEXT,
        status TEXT NOT NULL DEFAULT 'offline',
        metadata TEXT,
        last_seen_at INTEGER,
        created_at INTEGER NOT NULL,
        token TEXT,
        claim_token TEXT,
        registration_status TEXT NOT NULL DEFAULT 'claimed'
      );
      CREATE INDEX IF NOT EXISTS idx_agents_name ON agents (name);
      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status);
      CREATE INDEX IF NOT EXISTS idx_agents_claim_token ON agents (claim_token);
    `);

    // Channels table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL,
        access_rules TEXT,
        default_access TEXT NOT NULL,
        metadata TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        member_count INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_channels_name ON channels (name);
      CREATE INDEX IF NOT EXISTS idx_channels_project ON channels (project_id);
    `);

    // Channel members table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, agent_id)
      );
    `);

    // Presence table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS presence (
        agent_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'offline',
        status_text TEXT,
        last_activity INTEGER NOT NULL,
        typing_in TEXT,
        custom_status TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_presence_status ON presence (status);
    `);
  }

  private prepareStatements(): void {
    if (!this.db) return;

    this.insertMessageStmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages
      (id, project_id, target_id, target_type, sender_id, type, content, thread_id, correlation_id, signature, delivery_status, sent_at, edited_at, deleted_at, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertAgentStmt = this.db.prepare(`
      INSERT OR REPLACE INTO agents
      (id, name, capabilities, permissions, status, metadata, last_seen_at, created_at, token, claim_token, registration_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertChannelStmt = this.db.prepare(`
      INSERT OR REPLACE INTO channels
      (id, name, project_id, type, access_rules, default_access, metadata, created_by, created_at, member_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.insertPresenceStmt = this.db.prepare(`
      INSERT OR REPLACE INTO presence
      (agent_id, status, status_text, last_activity, typing_in, custom_status)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  }

  private startCleanupTimer(): void {
    this.cleanupExpiredMessages().catch(() => {});

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredMessages().catch(() => {});
    }, this.cleanupIntervalMs);

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  async cleanupExpiredMessages(): Promise<number> {
    if (!this.db) return 0;

    const cutoffTs = Date.now() - this.retentionMs;
    const stmt = this.db.prepare('DELETE FROM messages WHERE ts < ?');
    const result = stmt.run(cutoffTs) as { changes?: number };
    const deleted = result.changes ?? 0;

    if (deleted > 0) {
      console.log(`[storage] Cleaned up ${deleted} expired messages`);
    }

    return deleted;
  }

  async clearAllMessages(): Promise<number> {
    if (!this.db) return 0;

    const stmt = this.db.prepare('DELETE FROM messages');
    const result = stmt.run() as { changes?: number };
    const deleted = result.changes ?? 0;
    console.log(`[storage] Cleared ${deleted} messages`);
    return deleted;
  }

  // ============ Message Operations ============

  async saveMessage(message: Message): Promise<void> {
    if (!this.db || !this.insertMessageStmt) {
      throw new Error('SqliteStorage not initialized');
    }

    this.insertMessageStmt.run(
      message.id,
      message.projectId,
      message.targetId,
      message.targetType,
      message.senderId,
      message.type,
      JSON.stringify(message.content),
      message.threadId ?? null,
      message.correlationId ?? null,
      message.signature,
      message.deliveryStatus,
      message.sentAt,
      message.editedAt ?? null,
      message.deletedAt ?? null,
      new Date(message.sentAt).getTime()
    );
  }

  async getMessages(options: {
    targetId?: string;
    senderId?: string;
    threadId?: string;
    limit?: number;
    before?: string;
  } = {}): Promise<Message[]> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const clauses: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];

    if (options.targetId) {
      clauses.push('target_id = ?');
      params.push(options.targetId);
    }
    if (options.senderId) {
      clauses.push('sender_id = ?');
      params.push(options.senderId);
    }
    if (options.threadId) {
      clauses.push('thread_id = ?');
      params.push(options.threadId);
    }

    const where = `WHERE ${clauses.join(' AND ')}`;
    const limit = options.limit ?? 50;

    const stmt = this.db.prepare(`
      SELECT * FROM messages
      ${where}
      ORDER BY ts DESC
      LIMIT ?
    `);

    const rows = stmt.all(...params, limit);
    return rows.map((row: any) => this.rowToMessage(row));
  }

  async getMessageById(id: string): Promise<Message | null> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row ? this.rowToMessage(row) : null;
  }

  async getChannelMessages(channelId: string, limit = 50): Promise<Message[]> {
    return this.getMessages({ targetId: channelId, limit });
  }

  private rowToMessage(row: any): Message {
    return {
      id: row.id,
      projectId: row.project_id,
      targetId: row.target_id,
      targetType: row.target_type,
      senderId: row.sender_id,
      type: row.type,
      content: JSON.parse(row.content),
      threadId: row.thread_id ?? undefined,
      correlationId: row.correlation_id ?? undefined,
      signature: row.signature,
      deliveryStatus: row.delivery_status,
      sentAt: row.sent_at,
      editedAt: row.edited_at ?? undefined,
      deletedAt: row.deleted_at ?? undefined,
    };
  }

  // ============ Agent Operations ============

  async saveAgent(agent: StoredAgent): Promise<void> {
    if (!this.db || !this.insertAgentStmt) {
      throw new Error('SqliteStorage not initialized');
    }

    this.insertAgentStmt.run(
      agent.id,
      agent.name,
      JSON.stringify(agent.capabilities || []),
      JSON.stringify(agent.permissions || []),
      agent.status,
      JSON.stringify(agent.metadata || {}),
      agent.lastSeenAt ?? null,
      agent.createdAt ?? Date.now(),
      agent.token ?? null,
      agent.claimToken ?? null,
      agent.registrationStatus ?? 'claimed'
    );
  }

  async getAgent(id: string): Promise<StoredAgent | null> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
    return row ? this.rowToAgent(row) : null;
  }

  async getAgentByName(name: string): Promise<StoredAgent | null> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const row = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
    return row ? this.rowToAgent(row) : null;
  }

  async getAgentByClaimToken(claimToken: string): Promise<StoredAgent | null> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const row = this.db.prepare('SELECT * FROM agents WHERE claim_token = ?').get(claimToken);
    return row ? this.rowToAgent(row) : null;
  }

  async getAllAgents(): Promise<StoredAgent[]> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const rows = this.db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all();
    return rows.map((row: any) => this.rowToAgent(row));
  }

  async updateAgentStatus(id: string, status: string): Promise<void> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    this.db.prepare('UPDATE agents SET status = ?, last_seen_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  async deleteAgent(id: string): Promise<void> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  private rowToAgent(row: any): StoredAgent {
    return {
      id: row.id,
      name: row.name,
      capabilities: JSON.parse(row.capabilities || '[]'),
      permissions: JSON.parse(row.permissions || '[]'),
      status: row.status,
      metadata: JSON.parse(row.metadata || '{}'),
      lastSeenAt: row.last_seen_at ?? 0,
      createdAt: row.created_at,
      token: row.token ?? undefined,
      claimToken: row.claim_token ?? undefined,
      registrationStatus: row.registration_status ?? 'claimed',
    };
  }

  // ============ Channel Operations ============

  async saveChannel(channel: StoredChannel): Promise<void> {
    if (!this.db || !this.insertChannelStmt) {
      throw new Error('SqliteStorage not initialized');
    }

    this.insertChannelStmt.run(
      channel.id,
      channel.name,
      channel.projectId,
      channel.type,
      JSON.stringify(channel.accessRules || []),
      channel.defaultAccess,
      JSON.stringify(channel.metadata || {}),
      channel.createdBy,
      channel.createdAt,
      channel.memberCount ?? 0
    );
  }

  async getChannel(id: string): Promise<StoredChannel | null> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const row = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
    return row ? this.rowToChannel(row) : null;
  }

  async getChannelByName(name: string): Promise<StoredChannel | null> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const row = this.db.prepare('SELECT * FROM channels WHERE name = ?').get(name);
    return row ? this.rowToChannel(row) : null;
  }

  async getAllChannels(): Promise<StoredChannel[]> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const rows = this.db.prepare('SELECT * FROM channels ORDER BY created_at DESC').all();
    return rows.map((row: any) => this.rowToChannel(row));
  }

  async deleteChannel(id: string): Promise<void> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    this.db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM channel_members WHERE channel_id = ?').run(id);
  }

  private rowToChannel(row: any): StoredChannel {
    return {
      id: row.id,
      name: row.name,
      projectId: row.project_id,
      type: row.type,
      accessRules: JSON.parse(row.access_rules || '[]'),
      defaultAccess: row.default_access,
      metadata: JSON.parse(row.metadata || '{}'),
      createdBy: row.created_by,
      createdAt: row.created_at,
      memberCount: row.member_count ?? 0,
    };
  }

  // ============ Channel Membership ============

  async addChannelMember(channelId: string, agentId: string): Promise<void> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO channel_members (channel_id, agent_id, joined_at)
      VALUES (?, ?, ?)
    `).run(channelId, agentId, Date.now());

    // Update member count
    this.db.prepare(`
      UPDATE channels SET member_count = (
        SELECT COUNT(*) FROM channel_members WHERE channel_id = ?
      ) WHERE id = ?
    `).run(channelId, channelId);
  }

  async removeChannelMember(channelId: string, agentId: string): Promise<void> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    this.db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ?')
      .run(channelId, agentId);

    // Update member count
    this.db.prepare(`
      UPDATE channels SET member_count = (
        SELECT COUNT(*) FROM channel_members WHERE channel_id = ?
      ) WHERE id = ?
    `).run(channelId, channelId);
  }

  async getChannelMembers(channelId: string): Promise<string[]> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const rows = this.db.prepare('SELECT agent_id FROM channel_members WHERE channel_id = ?')
      .all(channelId) as { agent_id: string }[];
    return rows.map(r => r.agent_id);
  }

  async isChannelMember(channelId: string, agentId: string): Promise<boolean> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const row = this.db.prepare(
      'SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_id = ?'
    ).get(channelId, agentId);
    return !!row;
  }

  // ============ Presence Operations ============

  async savePresence(presence: StoredPresence): Promise<void> {
    if (!this.db || !this.insertPresenceStmt) {
      throw new Error('SqliteStorage not initialized');
    }

    this.insertPresenceStmt.run(
      presence.agentId,
      presence.status,
      presence.statusText ?? null,
      presence.lastActivityAt,
      presence.typingIn ?? null,
      presence.customStatus ?? null
    );
  }

  async getPresence(agentId: string): Promise<StoredPresence | null> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const row = this.db.prepare('SELECT * FROM presence WHERE agent_id = ?').get(agentId);
    return row ? this.rowToPresence(row) : null;
  }

  async getAllPresence(): Promise<StoredPresence[]> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const rows = this.db.prepare('SELECT * FROM presence ORDER BY last_activity DESC').all();
    return rows.map((row: any) => this.rowToPresence(row));
  }

  async deletePresence(agentId: string): Promise<void> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    this.db.prepare('DELETE FROM presence WHERE agent_id = ?').run(agentId);
  }

  private rowToPresence(row: any): StoredPresence {
    return {
      agentId: row.agent_id,
      status: row.status,
      statusText: row.status_text ?? undefined,
      lastActivityAt: row.last_activity,
      typingIn: row.typing_in ?? undefined,
      customStatus: row.custom_status ?? undefined,
    };
  }

  // ============ Statistics ============

  async getStats(): Promise<{
    messageCount: number;
    agentCount: number;
    channelCount: number;
    oldestMessageTs?: number;
  }> {
    if (!this.db) {
      throw new Error('SqliteStorage not initialized');
    }

    const msgCount = this.db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
    const agentCount = this.db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
    const channelCount = this.db.prepare('SELECT COUNT(*) as count FROM channels').get() as { count: number };
    const oldest = this.db.prepare('SELECT MIN(ts) as ts FROM messages').get() as { ts: number | null };

    return {
      messageCount: msgCount.count,
      agentCount: agentCount.count,
      channelCount: channelCount.count,
      oldestMessageTs: oldest.ts ?? undefined,
    };
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }
}

export default SqliteStorage;
