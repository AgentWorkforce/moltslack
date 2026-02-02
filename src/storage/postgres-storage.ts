/**
 * PostgreSQL Storage Adapter for Moltslack
 * Provides persistent storage for messages, agents, channels, and presence
 * Uses connection pooling for high-traffic scenarios
 */

import pg from 'pg';
import type { Message } from '../schemas/models.js';
import type { StorageInterface, StoredAgent, StoredPresence, StoredChannel } from './storage-interface.js';

const { Pool } = pg;

export interface PostgresStorageOptions {
  /** PostgreSQL connection string (DATABASE_URL) */
  connectionString: string;
  /** Maximum number of clients in the pool (default: 20) */
  maxPoolSize?: number;
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

export class PostgresStorage {
  private pool: pg.Pool;
  private retentionMs: number;
  private cleanupIntervalMs: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(options: PostgresStorageOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxPoolSize ?? 50,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    this.retentionMs = options.messageRetentionMs ?? getRetentionMs();
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? getCleanupIntervalMs();

    const retentionDays = this.retentionMs / (24 * 60 * 60 * 1000);
    const cleanupHours = this.cleanupIntervalMs / (60 * 60 * 1000);
    console.log(`[storage] Message retention: ${retentionDays} days, cleanup interval: ${cleanupHours} hours`);
  }

  async init(): Promise<void> {
    console.log('[storage] Initializing PostgreSQL connection pool...');

    // Test connection
    const client = await this.pool.connect();
    try {
      await client.query('SELECT NOW()');
      console.log('[storage] PostgreSQL connection successful');
    } finally {
      client.release();
    }

    // Create tables
    await this.createTables();

    // Start automatic cleanup if enabled
    if (this.cleanupIntervalMs > 0) {
      this.startCleanupTimer();
    }

    console.log('[storage] PostgreSQL storage initialized');
  }

  private async createTables(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Messages table
      await client.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          target_type TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          type TEXT NOT NULL,
          content JSONB NOT NULL,
          thread_id TEXT,
          correlation_id TEXT,
          signature TEXT NOT NULL,
          delivery_status TEXT NOT NULL,
          sent_at TEXT NOT NULL,
          edited_at TEXT,
          deleted_at TEXT,
          ts BIGINT NOT NULL
        )
      `);
      await client.query('CREATE INDEX IF NOT EXISTS idx_messages_target ON messages (target_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (thread_id)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts)');

      // Agents table
      await client.query(`
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          capabilities JSONB,
          permissions JSONB,
          status TEXT NOT NULL DEFAULT 'offline',
          metadata JSONB,
          last_seen_at BIGINT,
          created_at BIGINT NOT NULL,
          token TEXT,
          claim_token TEXT,
          registration_status TEXT NOT NULL DEFAULT 'claimed'
        )
      `);
      await client.query('CREATE INDEX IF NOT EXISTS idx_agents_name ON agents (name)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_agents_status ON agents (status)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_agents_claim_token ON agents (claim_token)');

      // Channels table
      await client.query(`
        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          project_id TEXT NOT NULL,
          type TEXT NOT NULL,
          access_rules JSONB,
          default_access TEXT NOT NULL,
          metadata JSONB,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          member_count INTEGER DEFAULT 0
        )
      `);
      await client.query('CREATE INDEX IF NOT EXISTS idx_channels_name ON channels (name)');
      await client.query('CREATE INDEX IF NOT EXISTS idx_channels_project ON channels (project_id)');

      // Channel members table
      await client.query(`
        CREATE TABLE IF NOT EXISTS channel_members (
          channel_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          joined_at BIGINT NOT NULL,
          PRIMARY KEY (channel_id, agent_id)
        )
      `);

      // Presence table
      await client.query(`
        CREATE TABLE IF NOT EXISTS presence (
          agent_id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'offline',
          status_text TEXT,
          last_activity BIGINT NOT NULL,
          typing_in TEXT,
          custom_status TEXT
        )
      `);
      await client.query('CREATE INDEX IF NOT EXISTS idx_presence_status ON presence (status)');

      console.log('[storage] PostgreSQL tables created/verified');
    } finally {
      client.release();
    }
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
    const cutoffTs = Date.now() - this.retentionMs;
    const result = await this.pool.query('DELETE FROM messages WHERE ts < $1', [cutoffTs]);
    const deleted = result.rowCount ?? 0;

    if (deleted > 0) {
      console.log(`[storage] Cleaned up ${deleted} expired messages`);
    }

    return deleted;
  }

  async clearAllMessages(): Promise<number> {
    const result = await this.pool.query('DELETE FROM messages');
    const deleted = result.rowCount ?? 0;
    console.log(`[storage] Cleared ${deleted} messages`);
    return deleted;
  }

  // ============ Message Operations ============

  async saveMessage(message: Message): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages
        (id, project_id, target_id, target_type, sender_id, type, content, thread_id, correlation_id, signature, delivery_status, sent_at, edited_at, deleted_at, ts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (id) DO UPDATE SET
          content = EXCLUDED.content,
          delivery_status = EXCLUDED.delivery_status,
          edited_at = EXCLUDED.edited_at,
          deleted_at = EXCLUDED.deleted_at`,
      [
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
        new Date(message.sentAt).getTime(),
      ]
    );
  }

  async getMessages(options: {
    targetId?: string;
    senderId?: string;
    threadId?: string;
    limit?: number;
    before?: string;
  } = {}): Promise<Message[]> {
    const clauses: string[] = ['deleted_at IS NULL'];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.targetId) {
      clauses.push(`target_id = $${paramIndex++}`);
      params.push(options.targetId);
    }
    if (options.senderId) {
      clauses.push(`sender_id = $${paramIndex++}`);
      params.push(options.senderId);
    }
    if (options.threadId) {
      clauses.push(`thread_id = $${paramIndex++}`);
      params.push(options.threadId);
    }

    const where = `WHERE ${clauses.join(' AND ')}`;
    const limit = options.limit ?? 50;
    params.push(limit);

    const result = await this.pool.query(
      `SELECT * FROM messages ${where} ORDER BY ts DESC LIMIT $${paramIndex}`,
      params
    );

    return result.rows.map((row: any) => this.rowToMessage(row));
  }

  async getMessageById(id: string): Promise<Message | null> {
    const result = await this.pool.query('SELECT * FROM messages WHERE id = $1', [id]);
    return result.rows[0] ? this.rowToMessage(result.rows[0]) : null;
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
      content: typeof row.content === 'string' ? JSON.parse(row.content) : row.content,
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
    await this.pool.query(
      `INSERT INTO agents
        (id, name, capabilities, permissions, status, metadata, last_seen_at, created_at, token, claim_token, registration_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          capabilities = EXCLUDED.capabilities,
          permissions = EXCLUDED.permissions,
          status = EXCLUDED.status,
          metadata = EXCLUDED.metadata,
          last_seen_at = EXCLUDED.last_seen_at,
          token = EXCLUDED.token,
          claim_token = EXCLUDED.claim_token,
          registration_status = EXCLUDED.registration_status`,
      [
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
        agent.registrationStatus ?? 'claimed',
      ]
    );
  }

  async getAgent(id: string): Promise<StoredAgent | null> {
    const result = await this.pool.query('SELECT * FROM agents WHERE id = $1', [id]);
    return result.rows[0] ? this.rowToAgent(result.rows[0]) : null;
  }

  async getAgentByName(name: string): Promise<StoredAgent | null> {
    const result = await this.pool.query('SELECT * FROM agents WHERE name = $1', [name]);
    return result.rows[0] ? this.rowToAgent(result.rows[0]) : null;
  }

  async getAgentByClaimToken(claimToken: string): Promise<StoredAgent | null> {
    const result = await this.pool.query('SELECT * FROM agents WHERE claim_token = $1', [claimToken]);
    return result.rows[0] ? this.rowToAgent(result.rows[0]) : null;
  }

  async getAllAgents(): Promise<StoredAgent[]> {
    const result = await this.pool.query('SELECT * FROM agents ORDER BY created_at DESC');
    return result.rows.map((row: any) => this.rowToAgent(row));
  }

  async updateAgentStatus(id: string, status: string): Promise<void> {
    await this.pool.query(
      'UPDATE agents SET status = $1, last_seen_at = $2 WHERE id = $3',
      [status, Date.now(), id]
    );
  }

  async deleteAgent(id: string): Promise<void> {
    await this.pool.query('DELETE FROM agents WHERE id = $1', [id]);
  }

  private rowToAgent(row: any): StoredAgent {
    return {
      id: row.id,
      name: row.name,
      capabilities: typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : (row.capabilities || []),
      permissions: typeof row.permissions === 'string' ? JSON.parse(row.permissions) : (row.permissions || []),
      status: row.status,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}),
      lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : 0,
      createdAt: Number(row.created_at),
      token: row.token ?? undefined,
      claimToken: row.claim_token ?? undefined,
      registrationStatus: row.registration_status ?? 'claimed',
    };
  }

  // ============ Channel Operations ============

  async saveChannel(channel: StoredChannel): Promise<void> {
    await this.pool.query(
      `INSERT INTO channels
        (id, name, project_id, type, access_rules, default_access, metadata, created_by, created_at, member_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          access_rules = EXCLUDED.access_rules,
          default_access = EXCLUDED.default_access,
          metadata = EXCLUDED.metadata,
          member_count = EXCLUDED.member_count`,
      [
        channel.id,
        channel.name,
        channel.projectId,
        channel.type,
        JSON.stringify(channel.accessRules || []),
        channel.defaultAccess,
        JSON.stringify(channel.metadata || {}),
        channel.createdBy,
        channel.createdAt,
        channel.memberCount ?? 0,
      ]
    );
  }

  async getChannel(id: string): Promise<StoredChannel | null> {
    const result = await this.pool.query('SELECT * FROM channels WHERE id = $1', [id]);
    return result.rows[0] ? this.rowToChannel(result.rows[0]) : null;
  }

  async getChannelByName(name: string): Promise<StoredChannel | null> {
    const result = await this.pool.query('SELECT * FROM channels WHERE name = $1', [name]);
    return result.rows[0] ? this.rowToChannel(result.rows[0]) : null;
  }

  async getAllChannels(): Promise<StoredChannel[]> {
    const result = await this.pool.query('SELECT * FROM channels ORDER BY created_at DESC');
    return result.rows.map((row: any) => this.rowToChannel(row));
  }

  async deleteChannel(id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM channels WHERE id = $1', [id]);
      await client.query('DELETE FROM channel_members WHERE channel_id = $1', [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private rowToChannel(row: any): StoredChannel {
    return {
      id: row.id,
      name: row.name,
      projectId: row.project_id,
      type: row.type,
      accessRules: typeof row.access_rules === 'string' ? JSON.parse(row.access_rules) : (row.access_rules || []),
      defaultAccess: row.default_access,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}),
      createdBy: row.created_by,
      createdAt: row.created_at,
      memberCount: row.member_count ?? 0,
    };
  }

  // ============ Channel Membership ============

  async addChannelMember(channelId: string, agentId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO channel_members (channel_id, agent_id, joined_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (channel_id, agent_id) DO UPDATE SET joined_at = EXCLUDED.joined_at`,
        [channelId, agentId, Date.now()]
      );
      // Update member count
      await client.query(
        `UPDATE channels SET member_count = (
          SELECT COUNT(*) FROM channel_members WHERE channel_id = $1
        ) WHERE id = $1`,
        [channelId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async removeChannelMember(channelId: string, agentId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM channel_members WHERE channel_id = $1 AND agent_id = $2',
        [channelId, agentId]
      );
      // Update member count
      await client.query(
        `UPDATE channels SET member_count = (
          SELECT COUNT(*) FROM channel_members WHERE channel_id = $1
        ) WHERE id = $1`,
        [channelId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getChannelMembers(channelId: string): Promise<string[]> {
    const result = await this.pool.query(
      'SELECT agent_id FROM channel_members WHERE channel_id = $1',
      [channelId]
    );
    return result.rows.map((r: { agent_id: string }) => r.agent_id);
  }

  async isChannelMember(channelId: string, agentId: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM channel_members WHERE channel_id = $1 AND agent_id = $2',
      [channelId, agentId]
    );
    return result.rows.length > 0;
  }

  // ============ Presence Operations ============

  async savePresence(presence: StoredPresence): Promise<void> {
    await this.pool.query(
      `INSERT INTO presence (agent_id, status, status_text, last_activity, typing_in, custom_status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agent_id) DO UPDATE SET
         status = EXCLUDED.status,
         status_text = EXCLUDED.status_text,
         last_activity = EXCLUDED.last_activity,
         typing_in = EXCLUDED.typing_in,
         custom_status = EXCLUDED.custom_status`,
      [
        presence.agentId,
        presence.status,
        presence.statusText ?? null,
        presence.lastActivityAt,
        presence.typingIn ?? null,
        presence.customStatus ?? null,
      ]
    );
  }

  async getPresence(agentId: string): Promise<StoredPresence | null> {
    const result = await this.pool.query('SELECT * FROM presence WHERE agent_id = $1', [agentId]);
    return result.rows[0] ? this.rowToPresence(result.rows[0]) : null;
  }

  async getAllPresence(): Promise<StoredPresence[]> {
    const result = await this.pool.query('SELECT * FROM presence ORDER BY last_activity DESC');
    return result.rows.map((row: any) => this.rowToPresence(row));
  }

  async deletePresence(agentId: string): Promise<void> {
    await this.pool.query('DELETE FROM presence WHERE agent_id = $1', [agentId]);
  }

  private rowToPresence(row: any): StoredPresence {
    return {
      agentId: row.agent_id,
      status: row.status,
      statusText: row.status_text ?? undefined,
      lastActivityAt: Number(row.last_activity),
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
    const [msgResult, agentResult, channelResult, oldestResult] = await Promise.all([
      this.pool.query('SELECT COUNT(*) as count FROM messages'),
      this.pool.query('SELECT COUNT(*) as count FROM agents'),
      this.pool.query('SELECT COUNT(*) as count FROM channels'),
      this.pool.query('SELECT MIN(ts) as ts FROM messages'),
    ]);

    return {
      messageCount: parseInt(msgResult.rows[0].count, 10),
      agentCount: parseInt(agentResult.rows[0].count, 10),
      channelCount: parseInt(channelResult.rows[0].count, 10),
      oldestMessageTs: oldestResult.rows[0].ts ? Number(oldestResult.rows[0].ts) : undefined,
    };
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    await this.pool.end();
    console.log('[storage] PostgreSQL connection pool closed');
  }
}

export default PostgresStorage;
