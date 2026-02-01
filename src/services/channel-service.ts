/**
 * ChannelService - Channel creation, membership, and access control
 */

import { v4 as uuid } from 'uuid';
import {
  ChannelType,
  ChannelAccessLevel,
  type ChannelAccessLevelValue,
  type Channel,
  type ChannelAccessRule,
  type ChannelMetadata,
  type UUID,
} from '../schemas/models.js';
import type { RelayClient } from '../relay/relay-client.js';
import type { RelayDaemonClient } from '../relay/relay-daemon-client.js';
import type { SqliteStorage } from '../storage/sqlite-storage.js';
import { track } from '../analytics/posthog.js';

/**
 * Both RelayClient and RelayDaemonClient implement the methods needed
 * by ChannelService.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RelayClientUnion = RelayClient | RelayDaemonClient;

export interface ChannelCreateInput {
  name: string;
  type?: ChannelType;
  topic?: string;
  isPrivate?: boolean;
  metadata?: Partial<ChannelMetadata>;
}

export class ChannelService {
  private channels: Map<string, Channel> = new Map();
  private nameIndex: Map<string, string> = new Map(); // name -> id
  private memberships: Map<string, Set<string>> = new Map(); // channelId -> Set<agentId>
  private projectId: UUID;
  private relayClient?: RelayClientUnion;
  private storage?: SqliteStorage;

  constructor(projectId: UUID, relayClient?: RelayClientUnion, storage?: SqliteStorage) {
    this.projectId = projectId;
    this.relayClient = relayClient;
    this.storage = storage;
    // Load existing channels from storage, then create defaults if needed
    this.loadFromStorage().then(() => {
      this.createDefaultChannels();
    });
  }

  /**
   * Load channels from SQLite storage
   */
  private async loadFromStorage(): Promise<void> {
    if (!this.storage) return;

    try {
      const storedChannels = await this.storage.getAllChannels();
      for (const stored of storedChannels) {
        const channel: Channel = {
          id: stored.id as UUID,
          name: stored.name,
          projectId: stored.projectId as UUID,
          type: stored.type as ChannelType,
          accessRules: stored.accessRules as ChannelAccessRule[],
          defaultAccess: stored.defaultAccess as ChannelAccessLevelValue,
          metadata: stored.metadata as unknown as ChannelMetadata,
          createdBy: stored.createdBy as UUID,
          createdAt: stored.createdAt,
          memberCount: stored.memberCount || 0,
        };
        this.channels.set(channel.id, channel);
        this.nameIndex.set(channel.name, channel.id);
        console.log(`[ChannelService] Loaded channel from storage: ${channel.name} (${channel.id})`);
      }
      console.log(`[ChannelService] Loaded ${storedChannels.length} channels from storage`);
    } catch (err) {
      console.error('[ChannelService] Failed to load channels from storage:', err);
    }
  }

  /**
   * Create default system channels (only if they don't exist)
   */
  private createDefaultChannels(): void {
    // Create #general channel if it doesn't exist
    if (!this.nameIndex.has('general')) {
      this.create({
        name: 'general',
        type: ChannelType.PUBLIC,
        topic: 'General discussion for all agents',
      }, 'system');
    }

    // Create #announcements channel (broadcast) if it doesn't exist
    if (!this.nameIndex.has('announcements')) {
      this.create({
        name: 'announcements',
        type: ChannelType.BROADCAST,
        topic: 'System-wide announcements',
      }, 'system');
    }
  }

  /**
   * Create a new channel
   */
  create(input: ChannelCreateInput, createdBy: UUID): Channel {
    // Check for duplicate name
    if (this.nameIndex.has(input.name)) {
      throw new Error(`Channel "${input.name}" already exists`);
    }

    const id = `ch-${uuid()}`;
    const now = new Date().toISOString();

    const channel: Channel = {
      id,
      name: input.name,
      projectId: this.projectId,
      type: input.type || ChannelType.PUBLIC,
      accessRules: this.createDefaultAccessRules(input.type || ChannelType.PUBLIC),
      defaultAccess: input.type === ChannelType.PRIVATE ? null : 'read',
      metadata: {
        displayName: input.name,
        topic: input.topic,
        isArchived: false,
        allowExternal: false,
        ...input.metadata,
      },
      createdBy,
      createdAt: now,
      memberCount: 0,
    };

    this.channels.set(id, channel);
    this.nameIndex.set(input.name, id);
    this.memberships.set(id, new Set());

    // Persist to storage
    if (this.storage) {
      this.storage.saveChannel({
        id: channel.id,
        name: channel.name,
        projectId: channel.projectId,
        type: channel.type,
        accessRules: channel.accessRules as unknown[],
        defaultAccess: channel.defaultAccess || 'read',
        metadata: channel.metadata as unknown as Record<string, unknown>,
        createdBy: channel.createdBy,
        createdAt: channel.createdAt,
        memberCount: channel.memberCount,
      }).catch(err => {
        console.error('[ChannelService] Failed to persist channel:', err);
      });
    }

    // Track channel creation
    track(createdBy, 'channel_created', { channel_id: id, channel_type: channel.type });

    console.log(`[ChannelService] Created channel: #${channel.name} (${id})`);
    return channel;
  }

  /**
   * Create default access rules based on channel type
   */
  private createDefaultAccessRules(type: ChannelType): ChannelAccessRule[] {
    switch (type) {
      case ChannelType.PUBLIC:
        return [
          { principal: '*', principalType: 'all', level: 'write' },
        ];
      case ChannelType.PRIVATE:
        return [];
      case ChannelType.BROADCAST:
        return [
          { principal: '*', principalType: 'all', level: 'read' },
        ];
      case ChannelType.DIRECT:
        return [];
      default:
        return [];
    }
  }

  /**
   * Get channel by ID
   */
  getById(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  /**
   * Get channel by name
   */
  getByName(name: string): Channel | undefined {
    const id = this.nameIndex.get(name);
    return id ? this.channels.get(id) : undefined;
  }

  /**
   * Get all channels
   */
  getAll(): Channel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get public channels
   */
  getPublic(): Channel[] {
    return this.getAll().filter(c => c.type === ChannelType.PUBLIC);
  }

  /**
   * Join an agent to a channel
   */
  join(channelId: string, agentId: string): boolean {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    // Check access
    if (!this.checkAccess(channelId, agentId, 'read')) {
      throw new Error('Permission denied: cannot join channel');
    }

    const members = this.memberships.get(channelId);
    if (!members) return false;

    if (!members.has(agentId)) {
      members.add(agentId);
      channel.memberCount = members.size;

      // Notify relay
      this.relayClient?.subscribeToChannel(agentId, channelId);

      // Track channel join
      track(agentId, 'channel_joined', { channel_id: channelId, agent_id: agentId });

      console.log(`[ChannelService] Agent ${agentId} joined #${channel.name}`);
    }
    return true;
  }

  /**
   * Remove an agent from a channel
   */
  leave(channelId: string, agentId: string): boolean {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    const members = this.memberships.get(channelId);
    if (!members) return false;

    if (members.has(agentId)) {
      members.delete(agentId);
      channel.memberCount = members.size;

      // Notify relay
      this.relayClient?.unsubscribeFromChannel(agentId, channelId);

      // Track channel leave
      track(agentId, 'channel_left', { channel_id: channelId, agent_id: agentId });

      console.log(`[ChannelService] Agent ${agentId} left #${channel.name}`);
    }
    return true;
  }

  /**
   * Get channel members
   */
  getMembers(channelId: string): string[] {
    const members = this.memberships.get(channelId);
    return members ? Array.from(members) : [];
  }

  /**
   * Check if agent is a member
   */
  isMember(channelId: string, agentId: string): boolean {
    const members = this.memberships.get(channelId);
    return members?.has(agentId) || false;
  }

  /**
   * Check agent access to channel
   */
  checkAccess(channelId: string, agentId: string, requiredLevel: ChannelAccessLevelValue): boolean {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    // Check access rules
    for (const rule of channel.accessRules) {
      if (this.matchRule(rule, agentId)) {
        return this.accessLevelSatisfies(rule.level, requiredLevel);
      }
    }

    // Check default access
    if (channel.defaultAccess) {
      return this.accessLevelSatisfies(channel.defaultAccess, requiredLevel);
    }

    return false;
  }

  /**
   * Check if rule matches agent
   */
  private matchRule(rule: ChannelAccessRule, agentId: string): boolean {
    if (rule.principalType === 'all') return true;
    if (rule.principalType === 'agent' && rule.principal === agentId) return true;
    // TODO: Add role matching
    return false;
  }

  /**
   * Check if access level satisfies requirement
   */
  private accessLevelSatisfies(actual: ChannelAccessLevelValue, required: ChannelAccessLevelValue): boolean {
    const levels: ChannelAccessLevelValue[] = ['read', 'write', 'admin'];
    return levels.indexOf(actual) >= levels.indexOf(required);
  }

  /**
   * Update channel metadata
   */
  update(channelId: string, updates: Partial<ChannelMetadata>): boolean {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    channel.metadata = { ...channel.metadata, ...updates };
    return true;
  }

  /**
   * Add access rule to channel
   */
  addAccessRule(channelId: string, rule: ChannelAccessRule): boolean {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    channel.accessRules.push(rule);
    return true;
  }

  /**
   * Delete a channel
   */
  delete(channelId: string): boolean {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    this.nameIndex.delete(channel.name);
    this.memberships.delete(channelId);
    this.channels.delete(channelId);

    console.log(`[ChannelService] Deleted channel: #${channel.name}`);
    return true;
  }

  /**
   * Get channel count
   */
  getCount(): number {
    return this.channels.size;
  }

  /**
   * Get channels an agent has access to
   */
  getAccessibleChannels(agentId: string): Channel[] {
    return this.getAll().filter(c =>
      this.checkAccess(c.id, agentId, 'read')
    );
  }

  /**
   * Get channels an agent is a member of
   */
  getJoinedChannels(agentId: string): Channel[] {
    return this.getAll().filter(c => this.isMember(c.id, agentId));
  }
}

export default ChannelService;
