/**
 * MessageService - Message sending, storage, and retrieval
 */

import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import {
  MessageType,
  MessageDeliveryStatus,
  ChannelAccessLevel,
  type Message,
  type MessageContent,
  type UUID,
} from '../schemas/models.js';
import type { RelayClient } from '../relay/relay-client.js';
import type { RelayDaemonClient } from '../relay/relay-daemon-client.js';
import type { ChannelService } from './channel-service.js';
import type { StorageInterface } from '../storage/storage-interface.js';
import { track } from '../analytics/posthog.js';

/**
 * Interface for relay client functionality needed by MessageService.
 * Both RelayClient and RelayDaemonClient implement these methods, though
 * with slightly different signatures. We use 'any' for message types
 * to allow both implementations.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RelayClientUnion = RelayClient | RelayDaemonClient;

export interface MessageSendInput {
  targetId: string;
  targetType: 'channel' | 'agent' | 'broadcast';
  type?: MessageType;
  text: string;
  data?: Record<string, unknown>;
  threadId?: string;
  correlationId?: string;
}

export class MessageService {
  private messages: Map<string, Message> = new Map();
  private channelMessages: Map<string, string[]> = new Map(); // channelId -> messageIds
  private threadMessages: Map<string, string[]> = new Map(); // threadId -> messageIds
  private projectId: UUID;
  private relayClient?: RelayClientUnion;
  private channelService?: ChannelService;
  private signingKey: string;
  private storage?: StorageInterface;

  constructor(
    projectId: UUID,
    relayClient?: RelayClientUnion,
    channelService?: ChannelService,
    storage?: StorageInterface
  ) {
    this.projectId = projectId;
    this.relayClient = relayClient;
    this.channelService = channelService;
    this.storage = storage;
    this.signingKey = process.env.MESSAGE_SIGNING_KEY || uuid();
  }

  /**
   * Send a new message
   */
  send(input: MessageSendInput, senderId: UUID): Message {
    // Validate channel access if sending to a channel
    if (input.targetType === 'channel' && this.channelService) {
      if (!this.channelService.checkAccess(input.targetId, senderId, ChannelAccessLevel.WRITE)) {
        throw new Error('Permission denied: cannot send to this channel');
      }
    }

    const id = `msg-${uuid()}`;
    const now = new Date().toISOString();

    const content: MessageContent = {
      text: input.text,
      data: input.data,
      mentions: this.extractMentions(input.text),
      attachments: [],
    };

    const message: Message = {
      id,
      projectId: this.projectId,
      targetId: input.targetId,
      targetType: input.targetType,
      senderId,
      type: input.type || MessageType.TEXT,
      content,
      threadId: input.threadId as UUID | undefined,
      correlationId: input.correlationId as UUID | undefined,
      signature: this.signMessage(id, senderId, content, now),
      deliveryStatus: MessageDeliveryStatus.SENT,
      sentAt: now,
    };

    // Store message in memory
    this.messages.set(id, message);

    // Index by channel
    if (input.targetType === 'channel') {
      if (!this.channelMessages.has(input.targetId)) {
        this.channelMessages.set(input.targetId, []);
      }
      this.channelMessages.get(input.targetId)!.push(id);
    }

    // Index by thread
    if (input.threadId) {
      if (!this.threadMessages.has(input.threadId)) {
        this.threadMessages.set(input.threadId, []);
      }
      this.threadMessages.get(input.threadId)!.push(id);
    }

    // Persist to SQLite if storage is available
    if (this.storage) {
      this.storage.saveMessage(message).catch(err => {
        console.error('[MessageService] Failed to persist message to SQLite:', err);
      });
    }

    // Broadcast via relay
    this.broadcastMessage(message);

    // Track message sent (no content for privacy)
    track(senderId, 'message_sent', {
      message_type: message.type,
      target_type: input.targetType,
      has_thread: !!input.threadId,
    });

    console.log(`[MessageService] Message sent: ${id} to ${input.targetType}:${input.targetId}`);
    return message;
  }

  /**
   * Broadcast message via relay
   */
  private broadcastMessage(message: Message): void {
    if (!this.relayClient) return;

    const wsMessage = {
      type: 'message' as const,
      data: message,
      timestamp: Date.now(),
    };

    switch (message.targetType) {
      case 'channel':
        this.relayClient.broadcastToChannel(message.targetId, wsMessage);
        break;
      case 'agent':
        this.relayClient.sendToAgent(message.targetId, wsMessage);
        break;
      case 'broadcast':
        this.relayClient.broadcast(wsMessage);
        break;
    }
  }

  /**
   * Get message by ID
   */
  getById(id: string): Message | undefined {
    return this.messages.get(id);
  }

  /**
   * Get messages in a channel
   */
  getChannelMessages(channelId: string, limit = 50, before?: string): Message[] {
    const ids = this.channelMessages.get(channelId) || [];
    let messages = ids.map(id => this.messages.get(id)!).filter(Boolean);

    // If in-memory is empty but storage is available, try loading from SQLite
    if (messages.length === 0 && this.storage) {
      // Note: This is synchronous for API compatibility. Consider async refactor in future.
      // For now, we'll load messages into memory on first access.
      this.loadChannelMessagesFromStorage(channelId, limit);
      const reloadedIds = this.channelMessages.get(channelId) || [];
      messages = reloadedIds.map(id => this.messages.get(id)!).filter(Boolean);
    }

    // Filter soft-deleted messages
    messages = messages.filter(m => !m.deletedAt);

    // Sort by sentAt descending
    messages.sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());

    // Filter before cursor
    if (before) {
      const beforeMsg = this.messages.get(before);
      if (beforeMsg) {
        messages = messages.filter(m => new Date(m.sentAt).getTime() < new Date(beforeMsg.sentAt).getTime());
      }
    }

    return messages.slice(0, limit);
  }

  /**
   * Load channel messages from SQLite storage into memory (sync wrapper)
   */
  private loadChannelMessagesFromStorage(channelId: string, limit: number): void {
    if (!this.storage) return;

    // Use a synchronous approach - get messages and populate in-memory cache
    // Note: SqliteStorage uses synchronous SQLite operations internally
    this.storage.getChannelMessages(channelId, limit)
      .then(messages => {
        for (const msg of messages) {
          if (!this.messages.has(msg.id)) {
            this.messages.set(msg.id, msg);

            // Index by channel
            if (!this.channelMessages.has(msg.targetId)) {
              this.channelMessages.set(msg.targetId, []);
            }
            const channelMsgIds = this.channelMessages.get(msg.targetId)!;
            if (!channelMsgIds.includes(msg.id)) {
              channelMsgIds.push(msg.id);
            }

            // Index by thread
            if (msg.threadId) {
              if (!this.threadMessages.has(msg.threadId)) {
                this.threadMessages.set(msg.threadId, []);
              }
              const threadMsgIds = this.threadMessages.get(msg.threadId)!;
              if (!threadMsgIds.includes(msg.id)) {
                threadMsgIds.push(msg.id);
              }
            }
          }
        }
        console.log(`[MessageService] Loaded ${messages.length} messages from storage for channel ${channelId}`);
      })
      .catch(err => {
        console.error('[MessageService] Failed to load messages from storage:', err);
      });
  }

  /**
   * Get thread messages
   */
  getThreadMessages(threadId: string): Message[] {
    const ids = this.threadMessages.get(threadId) || [];
    return ids
      .map(id => this.messages.get(id)!)
      .filter(m => m && !m.deletedAt)
      .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
  }

  /**
   * Edit a message
   */
  edit(messageId: string, newText: string, editorId: UUID): boolean {
    const message = this.messages.get(messageId);
    if (!message) return false;

    // Only sender can edit
    if (message.senderId !== editorId) {
      throw new Error('Permission denied: only sender can edit message');
    }

    message.content.text = newText;
    message.editedAt = new Date().toISOString();
    message.signature = this.signMessage(message.id, message.senderId, message.content, message.sentAt);

    // Broadcast edit event
    this.relayClient?.emitRelayEvent({
      type: 'message.sent',
      source: editorId,
      target: message.targetId,
      data: { messageId, action: 'edited', newText },
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Delete a message (soft delete)
   */
  delete(messageId: string, deleterId: UUID): boolean {
    const message = this.messages.get(messageId);
    if (!message) return false;

    // Only sender can delete (or admin)
    if (message.senderId !== deleterId) {
      throw new Error('Permission denied: only sender can delete message');
    }

    message.deletedAt = new Date().toISOString();

    // Broadcast delete event
    this.relayClient?.emitRelayEvent({
      type: 'message.sent',
      source: deleterId,
      target: message.targetId,
      data: { messageId, action: 'deleted' },
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Mark message as delivered
   */
  markDelivered(messageId: string, recipientId: UUID): void {
    const message = this.messages.get(messageId);
    if (message && message.deliveryStatus === MessageDeliveryStatus.SENT) {
      message.deliveryStatus = MessageDeliveryStatus.DELIVERED;
    }
  }

  /**
   * Mark message as read
   */
  markRead(messageId: string, readerId: UUID): void {
    const message = this.messages.get(messageId);
    if (message) {
      message.deliveryStatus = MessageDeliveryStatus.READ;
    }
  }

  /**
   * Extract @mentions from text
   */
  private extractMentions(text: string): Message['content']['mentions'] {
    const mentions: Message['content']['mentions'] = [];
    const regex = /@(\w+)/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      mentions.push({
        type: match[1] === 'all' || match[1] === 'here' ? 'all' : 'agent',
        startIndex: match.index,
        length: match[0].length,
      });
    }

    return mentions;
  }

  /**
   * Sign a message for integrity verification
   */
  private signMessage(id: string, senderId: string, content: MessageContent, sentAt: string): string {
    const payload = JSON.stringify({ id, senderId, content, sentAt });
    return crypto
      .createHmac('sha256', this.signingKey)
      .update(payload)
      .digest('base64');
  }

  /**
   * Verify message signature
   */
  verifySignature(message: Message): boolean {
    const expectedSig = this.signMessage(
      message.id,
      message.senderId,
      message.content,
      message.sentAt
    );
    return message.signature === expectedSig;
  }

  /**
   * Get message count
   */
  getCount(): number {
    return this.messages.size;
  }

  /**
   * Search messages by text
   */
  search(query: string, options?: { channelId?: string; senderId?: string; limit?: number }): Message[] {
    const limit = options?.limit || 20;
    const results: Message[] = [];

    for (const message of this.messages.values()) {
      if (message.deletedAt) continue;
      if (options?.channelId && message.targetId !== options.channelId) continue;
      if (options?.senderId && message.senderId !== options.senderId) continue;

      if (message.content.text.toLowerCase().includes(query.toLowerCase())) {
        results.push(message);
        if (results.length >= limit) break;
      }
    }

    return results;
  }

  /**
   * Clear all messages (in-memory cache)
   */
  clearAll(): number {
    const count = this.messages.size;
    this.messages.clear();
    this.channelMessages.clear();
    this.threadMessages.clear();
    console.log(`[MessageService] Cleared ${count} messages from memory`);
    return count;
  }
}

export default MessageService;
