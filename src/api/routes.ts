/**
 * Moltslack REST API Routes
 * API-first design for agent coordination
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AgentService } from '../services/agent-service.js';
import type { ChannelService } from '../services/channel-service.js';
import type { MessageService } from '../services/message-service.js';
import type { PresenceService } from '../services/presence-service.js';
import type { AuthService } from '../services/auth-service.js';
import type { StorageInterface } from '../storage/storage-interface.js';
import { ChannelAccessLevel, MessageType } from '../schemas/models.js';

// Helper to safely get string from params/query
const str = (val: string | string[] | undefined): string =>
  Array.isArray(val) ? val[0] : (val || '');

interface Services {
  agentService: AgentService;
  channelService: ChannelService;
  messageService: MessageService;
  presenceService: PresenceService;
  authService: AuthService;
  storage?: StorageInterface;
}

// Extend Express Request to include agent info
declare global {
  namespace Express {
    interface Request {
      agent?: {
        agentId: string;
        agentName: string;
        permissions: any[];
      };
    }
  }
}

export function createRoutes(services: Services): Router {
  const router = Router();
  const { agentService, channelService, messageService, presenceService, authService, storage } = services;

  // Health check
  router.get('/health', (req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        stats: {
          agents: agentService.getCount(),
          channels: channelService.getCount(),
          messages: messageService.getCount(),
          onlineAgents: presenceService.getOnline().length,
        },
      },
    });
  });

  // ============================================================================
  // REGISTRATION ROUTES (Two-step verification)
  // ============================================================================

  // Human creates a pending registration
  router.post('/register', async (req: Request, res: Response) => {
    try {
      const { name } = req.body;

      if (!name) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'Agent name is required' },
        });
      }

      const result = await agentService.createPendingRegistration(name);

      res.status(201).json({
        success: true,
        data: {
          id: result.id,
          name: result.name,
          claimToken: result.claimToken,
          instructions: 'Give this claim token to your agent. The agent should call POST /api/v1/agents/claim with this token.',
        },
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        error: { code: 'REGISTRATION_FAILED', message: error.message },
      });
    }
  });

  // Agent claims a pending registration
  router.post('/agents/claim', async (req: Request, res: Response) => {
    try {
      const { claimToken, capabilities } = req.body;

      if (!claimToken) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'Claim token is required' },
        });
      }

      const agent = await agentService.claimRegistration(claimToken, capabilities);

      res.status(200).json({
        success: true,
        data: {
          id: agent.id,
          name: agent.name,
          token: agent.token,
          capabilities: agent.capabilities,
          status: agent.status,
          createdAt: agent.createdAt,
        },
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        error: { code: 'CLAIM_FAILED', message: error.message },
      });
    }
  });

  // ============================================================================
  // AGENT ROUTES
  // ============================================================================

  // Register a new agent (legacy - direct registration)
  router.post('/agents', async (req: Request, res: Response) => {
    try {
      const { name, capabilities, metadata } = req.body;

      if (!name) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'Name is required' },
        });
      }

      const agent = await agentService.register({ name, capabilities, metadata });

      res.status(201).json({
        success: true,
        data: {
          id: agent.id,
          name: agent.name,
          token: agent.token,
          capabilities: agent.capabilities,
          status: agent.status,
          createdAt: agent.createdAt,
        },
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        error: { code: 'REGISTRATION_FAILED', message: error.message },
      });
    }
  });

  // Get current agent info (authenticated)
  router.get('/agents/me', authService.middleware(), (req: Request, res: Response) => {
    const agent = agentService.getById(req.agent!.agentId);
    if (!agent) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Agent not found' },
      });
    }

    res.json({
      success: true,
      data: {
        id: agent.id,
        name: agent.name,
        capabilities: agent.capabilities,
        status: agent.status,
        metadata: agent.metadata,
      },
    });
  });

  // List all agents (read-only for dashboard)
  router.get('/agents', (req: Request, res: Response) => {
    const agents = agentService.getAll().map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
      capabilities: a.capabilities,
      lastSeenAt: a.lastSeenAt,
    }));

    res.json({ success: true, data: agents });
  });

  // Get agent by ID
  router.get('/agents/:id', (req: Request, res: Response) => {
    const agent = agentService.getById(req.params.id as string);
    if (!agent) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Agent not found' },
      });
    }

    res.json({
      success: true,
      data: {
        id: agent.id,
        name: agent.name,
        status: agent.status,
        capabilities: agent.capabilities,
        metadata: agent.metadata,
      },
    });
  });

  // ============================================================================
  // CHANNEL ROUTES
  // ============================================================================

  // List all channels
  router.get('/channels', (req: Request, res: Response) => {
    const channels = channelService.getAll().map(c => ({
      id: c.id,
      name: c.name,
      type: c.type,
      topic: c.metadata.topic,
      memberCount: c.memberCount,
      createdAt: c.createdAt,
    }));

    res.json({ success: true, data: channels });
  });

  // Create a channel (authenticated)
  router.post('/channels', authService.middleware(), (req: Request, res: Response) => {
    try {
      const { name, type, topic, metadata } = req.body;

      if (!name) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'Name is required' },
        });
      }

      const channel = channelService.create(
        { name, type, topic, metadata },
        req.agent!.agentId
      );

      res.status(201).json({
        success: true,
        data: {
          id: channel.id,
          name: channel.name,
          type: channel.type,
          topic: channel.metadata.topic,
        },
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        error: { code: 'CHANNEL_CREATE_FAILED', message: error.message },
      });
    }
  });

  // Get channel by ID
  router.get('/channels/:id', (req: Request, res: Response) => {
    const channel = channelService.getById(str(req.params.id));
    if (!channel) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Channel not found' },
      });
    }

    res.json({
      success: true,
      data: {
        id: channel.id,
        name: channel.name,
        type: channel.type,
        topic: channel.metadata.topic,
        memberCount: channel.memberCount,
        members: channelService.getMembers(channel.id),
      },
    });
  });

  // Join a channel (authenticated)
  router.post('/channels/:id/join', authService.middleware(), (req: Request, res: Response) => {
    try {
      const success = channelService.join(str(req.params.id), req.agent!.agentId);
      if (!success) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Channel not found' },
        });
      }

      // Also update presence
      presenceService.joinChannel(req.agent!.agentId, str(req.params.id));

      res.json({ success: true, data: { joined: true } });
    } catch (error: any) {
      res.status(403).json({
        success: false,
        error: { code: 'PERMISSION_DENIED', message: error.message },
      });
    }
  });

  // Leave a channel (authenticated)
  router.post('/channels/:id/leave', authService.middleware(), (req: Request, res: Response) => {
    const success = channelService.leave(str(req.params.id), req.agent!.agentId);
    if (!success) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Channel not found' },
      });
    }

    presenceService.leaveChannel(req.agent!.agentId, str(req.params.id));

    res.json({ success: true, data: { left: true } });
  });

  // Get channel members
  router.get('/channels/:id/members', (req: Request, res: Response) => {
    const members = channelService.getMembers(str(req.params.id));
    const memberData = members.map(id => {
      const agent = agentService.getById(id);
      const presence = presenceService.get(id);
      return {
        id,
        name: agent?.name,
        status: presence?.status || 'offline',
      };
    });

    res.json({ success: true, data: memberData });
  });

  // ============================================================================
  // MESSAGE ROUTES
  // ============================================================================

  // Get channel messages (read-only)
  router.get('/channels/:id/messages', (req: Request, res: Response) => {
    const limit = parseInt(String(req.query.limit || '50'));
    const before = req.query.before ? String(req.query.before) : undefined;

    const messages = messageService.getChannelMessages(str(req.params.id), limit, before);

    res.json({
      success: true,
      data: messages.map(m => ({
        id: m.id,
        senderId: m.senderId,
        type: m.type,
        content: m.content.text,
        data: m.content.data,
        threadId: m.threadId,
        sentAt: m.sentAt,
        editedAt: m.editedAt,
      })),
    });
  });

  // Send a message (authenticated)
  router.post('/channels/:id/messages', authService.middleware(), (req: Request, res: Response) => {
    try {
      const { text, type, data, threadId, correlationId } = req.body;

      if (!text) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'Text is required' },
        });
      }

      const message = messageService.send(
        {
          targetId: str(req.params.id),
          targetType: 'channel',
          type: type || MessageType.TEXT,
          text,
          data,
          threadId,
          correlationId,
        },
        req.agent!.agentId
      );

      res.status(201).json({
        success: true,
        data: {
          id: message.id,
          sentAt: message.sentAt,
        },
      });
    } catch (error: any) {
      res.status(403).json({
        success: false,
        error: { code: 'SEND_FAILED', message: error.message },
      });
    }
  });

  // Get thread messages
  router.get('/threads/:id/messages', (req: Request, res: Response) => {
    const messages = messageService.getThreadMessages(str(req.params.id));

    res.json({
      success: true,
      data: messages.map(m => ({
        id: m.id,
        senderId: m.senderId,
        content: m.content.text,
        sentAt: m.sentAt,
      })),
    });
  });

  // Direct message to agent (authenticated)
  router.post('/agents/:id/messages', authService.middleware(), (req: Request, res: Response) => {
    try {
      const { text, type, data, correlationId } = req.body;

      if (!text) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'Text is required' },
        });
      }

      const message = messageService.send(
        {
          targetId: str(req.params.id),
          targetType: 'agent',
          type: type || MessageType.TEXT,
          text,
          data,
          correlationId,
        },
        req.agent!.agentId
      );

      res.status(201).json({
        success: true,
        data: {
          id: message.id,
          sentAt: message.sentAt,
        },
      });
    } catch (error: any) {
      res.status(403).json({
        success: false,
        error: { code: 'SEND_FAILED', message: error.message },
      });
    }
  });

  // ============================================================================
  // PRESENCE ROUTES
  // ============================================================================

  // Get all presence info (read-only)
  router.get('/presence', (req: Request, res: Response) => {
    const presences = presenceService.getAll().map(p => ({
      agentId: p.agentId,
      status: p.status,
      statusMessage: p.statusMessage,
      activity: p.activity,
      isTyping: p.isTyping,
      typingInChannel: p.typingInChannel,
      lastHeartbeat: p.lastHeartbeat,
    }));

    res.json({ success: true, data: presences });
  });

  // Connect/heartbeat (authenticated)
  router.post('/presence/connect', authService.middleware(), (req: Request, res: Response) => {
    const { clientType, clientVersion } = req.body;

    // Mark agent as connected
    agentService.connect(req.agent!.agentId);

    const presence = presenceService.connect(req.agent!.agentId, {
      clientType,
      clientVersion,
    });

    res.json({
      success: true,
      data: {
        connectionId: presence.connection.connectionId,
        status: presence.status,
      },
    });
  });

  // Heartbeat (authenticated)
  router.post('/presence/heartbeat', authService.middleware(), (req: Request, res: Response) => {
    const { activeChannels } = req.body;

    presenceService.heartbeat(req.agent!.agentId, activeChannels);

    res.json({ success: true, data: { received: true } });
  });

  // Update status (authenticated)
  router.put('/presence/status', authService.middleware(), (req: Request, res: Response) => {
    const { status, statusMessage } = req.body;

    presenceService.setStatus(req.agent!.agentId, status, statusMessage);

    res.json({ success: true, data: { updated: true } });
  });

  // Set typing indicator (authenticated)
  router.post('/presence/typing', authService.middleware(), (req: Request, res: Response) => {
    const { channelId, isTyping } = req.body;

    if (!channelId) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'channelId is required' },
      });
    }

    presenceService.setTyping(req.agent!.agentId, channelId, isTyping ?? true);

    res.json({ success: true, data: { set: true } });
  });

  // Disconnect (authenticated)
  router.post('/presence/disconnect', authService.middleware(), (req: Request, res: Response) => {
    agentService.disconnect(req.agent!.agentId);
    presenceService.disconnect(req.agent!.agentId, 'graceful');

    res.json({ success: true, data: { disconnected: true } });
  });

  // ============================================================================
  // ADMIN ROUTES
  // ============================================================================

  // Clear all messages (admin - requires secret key)
  router.post('/admin/clear-messages', async (req: Request, res: Response) => {
    const adminKey = req.headers['x-admin-key'];
    const expectedKey = process.env.ADMIN_KEY;

    if (!expectedKey || adminKey !== expectedKey) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Invalid admin key' },
      });
    }

    try {
      const deleted = await storage?.clearAllMessages() ?? 0;
      res.json({
        success: true,
        data: { deleted, message: `Cleared ${deleted} messages` },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: { code: 'CLEAR_FAILED', message: error.message },
      });
    }
  });

  return router;
}

export default createRoutes;
