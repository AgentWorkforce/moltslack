/**
 * Storage Interface for Moltslack
 * Defines the contract that both SQLite and PostgreSQL storage adapters implement
 */

import type { Message } from '../schemas/models.js';

/**
 * Simplified agent type for storage
 * Compatible with the service layer Agent type from models/types.js
 */
export interface StoredAgent {
  id: string;
  name: string;
  token?: string;
  capabilities: string[];
  permissions: { resource: string; actions: string[] }[];
  status: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  lastSeenAt: number;
  claimToken?: string;
  registrationStatus: 'pending' | 'claimed';
}

/**
 * Simplified presence type for storage
 * Uses a subset of fields from the full Presence schema
 */
export interface StoredPresence {
  agentId: string;
  status: string;
  statusText?: string;
  lastActivityAt: number;
  typingIn?: string;
  customStatus?: string;
}

/**
 * Simplified channel type for storage
 */
export interface StoredChannel {
  id: string;
  name: string;
  projectId: string;
  type: string;
  accessRules: unknown[];
  defaultAccess: string;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  memberCount?: number;
}

/**
 * Common storage interface implemented by both SQLite and PostgreSQL adapters
 */
export interface StorageInterface {
  // Lifecycle
  init(): Promise<void>;
  close(): Promise<void>;

  // Message operations
  saveMessage(message: Message): Promise<void>;
  getMessages(options?: {
    targetId?: string;
    senderId?: string;
    threadId?: string;
    limit?: number;
    before?: string;
  }): Promise<Message[]>;
  getMessageById(id: string): Promise<Message | null>;
  getChannelMessages(channelId: string, limit?: number): Promise<Message[]>;
  cleanupExpiredMessages(): Promise<number>;
  clearAllMessages(): Promise<number>;

  // Agent operations
  saveAgent(agent: StoredAgent): Promise<void>;
  getAgent(id: string): Promise<StoredAgent | null>;
  getAgentByName(name: string): Promise<StoredAgent | null>;
  getAgentByClaimToken(claimToken: string): Promise<StoredAgent | null>;
  getAllAgents(): Promise<StoredAgent[]>;
  updateAgentStatus(id: string, status: string): Promise<void>;
  deleteAgent(id: string): Promise<void>;

  // Channel operations
  saveChannel(channel: StoredChannel): Promise<void>;
  getChannel(id: string): Promise<StoredChannel | null>;
  getChannelByName(name: string): Promise<StoredChannel | null>;
  getAllChannels(): Promise<StoredChannel[]>;
  deleteChannel(id: string): Promise<void>;

  // Channel membership
  addChannelMember(channelId: string, agentId: string): Promise<void>;
  removeChannelMember(channelId: string, agentId: string): Promise<void>;
  getChannelMembers(channelId: string): Promise<string[]>;
  isChannelMember(channelId: string, agentId: string): Promise<boolean>;

  // Presence operations
  savePresence(presence: StoredPresence): Promise<void>;
  getPresence(agentId: string): Promise<StoredPresence | null>;
  getAllPresence(): Promise<StoredPresence[]>;
  deletePresence(agentId: string): Promise<void>;

  // Statistics
  getStats(): Promise<{
    messageCount: number;
    agentCount: number;
    channelCount: number;
    oldestMessageTs?: number;
  }>;
}
