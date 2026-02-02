/**
 * Moltslack Server
 * Main entry point for the API server and Relay daemon
 *
 * Supports two relay modes:
 * - 'standalone': Runs its own WebSocket server for agent communication
 * - 'daemon': Connects to agent-relay daemon via Unix socket for relay-dashboard integration
 */

import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';

// Find dashboard static files
function findDashboardDir(): string | null {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));

  // Priority: custom dashboard first, then fallback to relay-dashboard package
  const paths = [
    // Custom standalone dashboard (in src/dashboard or dist/dashboard)
    path.join(currentDir, 'dashboard'),
    path.join(currentDir, '..', 'src', 'dashboard'),
    // Fallback to relay-dashboard package
    path.join(currentDir, '..', 'node_modules', '@agent-relay', 'dashboard', 'out'),
    path.join(currentDir, '..', '..', 'relay-dashboard', 'packages', 'dashboard', 'out'),
  ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

import { RelayClient } from './relay/relay-client.js';
import { RelayDaemonClient } from './relay/relay-daemon-client.js';
import { type RelayMode, type RelayConfig, getRelayConfigFromEnv } from './relay/index.js';
import { AuthService } from './services/auth-service.js';
import { AgentService } from './services/agent-service.js';
import { ChannelService } from './services/channel-service.js';
import { MessageService } from './services/message-service.js';
import { PresenceService } from './services/presence-service.js';
import { createRoutes } from './api/routes.js';
import { SqliteStorage } from './storage/sqlite-storage.js';
import { PostgresStorage } from './storage/postgres-storage.js';
import type { StorageInterface } from './storage/storage-interface.js';
import { shutdown as shutdownAnalytics } from './analytics/posthog.js';

/**
 * Union type for relay clients - both implement compatible interfaces
 */
type RelayClientUnion = RelayClient | RelayDaemonClient;

export interface ServerConfig {
  port: number;
  wsPort: number;
  projectId?: string;
  jwtSecret?: string;
  /** Relay mode: 'standalone' (default) or 'daemon' for relay-dashboard integration */
  relayMode?: RelayMode;
  /** Path to Unix socket for daemon mode */
  socketPath?: string;
  /** Agent name for daemon mode */
  agentName?: string;
  /** Path to SQLite database file (default: .moltslack/moltslack.db) */
  dbPath?: string;
  /** Use single port for HTTP and WebSocket (required for Railway/cloud deployment) */
  singlePort?: boolean;
}

export class MoltslackServer {
  private app: express.Application;
  private relayClient!: RelayClientUnion;
  private authService: AuthService;
  private agentService: AgentService;
  private channelService!: ChannelService;
  private messageService!: MessageService;
  private presenceService!: PresenceService;
  private storage?: StorageInterface;
  private config: ServerConfig & { relayMode: RelayMode; singlePort: boolean };
  private server?: http.Server;

  constructor(config: Partial<ServerConfig> = {}) {
    // Get relay config from environment, allowing overrides
    const relayEnvConfig = getRelayConfigFromEnv();

    // Default to single port mode if WS_PORT is not set (cloud deployment)
    const singlePort = config.singlePort ?? !process.env.WS_PORT;

    this.config = {
      port: config.port || 3000,
      wsPort: config.wsPort || relayEnvConfig.wsPort || 3001,
      projectId: config.projectId || `proj-${uuid()}`,
      jwtSecret: config.jwtSecret || process.env.JWT_SECRET,
      relayMode: config.relayMode || relayEnvConfig.mode,
      socketPath: config.socketPath || relayEnvConfig.socketPath,
      agentName: config.agentName || relayEnvConfig.agentName,
      dbPath: config.dbPath || process.env.MOLTSLACK_DB_PATH || '.moltslack/moltslack.db',
      singlePort,
    };

    // Initialize storage adapter - PostgreSQL if DATABASE_URL is set, SQLite otherwise
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl) {
      console.log('[Server] DATABASE_URL detected - using PostgreSQL storage');
      this.storage = new PostgresStorage({ connectionString: databaseUrl });
    } else {
      console.log('[Server] No DATABASE_URL - using SQLite storage');
      this.storage = new SqliteStorage({ dbPath: this.config.dbPath! });
    }

    // Initialize services
    this.authService = new AuthService(this.config.jwtSecret);

    // Initialize relay client based on mode
    // Note: For single port mode, we'll pass the HTTP server in start()
    if (this.config.relayMode === 'daemon') {
      console.log('[Server] Using daemon mode - connecting to relay-dashboard');
      this.relayClient = new RelayDaemonClient({
        socketPath: this.config.socketPath,
        agentName: this.config.agentName,
        cli: 'moltslack',
        reconnect: true,
      });
    } else if (this.config.singlePort) {
      console.log('[Server] Using single-port mode - WebSocket on /ws path');
      // RelayClient will be initialized with HTTP server in start()
      this.relayClient = null as any; // Will be set in start()
    } else {
      console.log('[Server] Using standalone mode - running own WebSocket server');
      this.relayClient = new RelayClient({ port: this.config.wsPort });
    }

    this.agentService = new AgentService(this.authService, this.storage);

    // Initialize Express app
    this.app = express();
    this.setupMiddleware();

    // For non-single-port modes, services are initialized in start() after storage is ready
    // Routes are set up after services are initialized
  }

  /**
   * Initialize services that depend on relayClient (called after relay is ready)
   */
  private async initializeServices(): Promise<void> {
    // Cast to any to satisfy TypeScript - both clients implement compatible interfaces
    this.channelService = new ChannelService(this.config.projectId!, this.relayClient as any, this.storage);

    // Load channels from storage before creating defaults
    await this.channelService.initializeChannels();

    this.messageService = new MessageService(
      this.config.projectId!,
      this.relayClient as any,
      this.channelService,
      this.storage
    );
    this.presenceService = new PresenceService(this.config.projectId!, this.relayClient as any);

    // Wire up relay events
    this.setupRelayHandlers();
  }

  /**
   * Set up Relay event handlers
   */
  private setupRelayHandlers(): void {
    this.relayClient.on('agent:connected', (data) => {
      console.log(`[Server] Agent connected: ${data.agentId}`);
      this.agentService.connect(data.agentId);
      this.presenceService.connect(data.agentId);
    });

    this.relayClient.on('agent:disconnected', (data) => {
      console.log(`[Server] Agent disconnected: ${data.agentId}`);
      this.agentService.disconnect(data.agentId);
      this.presenceService.disconnect(data.agentId, 'graceful');
    });

    this.relayClient.on('channel:joined', (data) => {
      console.log(`[Server] Agent ${data.agentId} joined channel ${data.channelId}`);
      this.presenceService.joinChannel(data.agentId, data.channelId);
    });

    this.relayClient.on('channel:left', (data) => {
      console.log(`[Server] Agent ${data.agentId} left channel ${data.channelId}`);
      this.presenceService.leaveChannel(data.agentId, data.channelId);
    });

    this.relayClient.on('message', (message) => {
      console.log(`[Server] Message received: ${message.id}`);
    });

    this.relayClient.on('presence', (presence) => {
      console.log(`[Server] Presence update: ${presence.agentId} -> ${presence.status}`);
    });
  }

  /**
   * Set up Express middleware
   */
  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());

    // Request logging
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[HTTP] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
      });
      next();
    });
  }

  /**
   * Set up API routes
   */
  private setupRoutes(): void {
    const routes = createRoutes({
      agentService: this.agentService,
      channelService: this.channelService,
      messageService: this.messageService,
      presenceService: this.presenceService,
      authService: this.authService,
      storage: this.storage,
    });

    // API routes
    this.app.use('/api/v1', routes);

    // Dashboard API endpoints (read-only for humans)
    this.app.get('/api/dashboard/messages', (req, res) => {
      const channelId = req.query.channelId as string;
      const limit = parseInt(req.query.limit as string) || 50;

      // Helper to add sender names to messages
      const enrichMessages = (messages: any[]) => {
        return messages.map(msg => {
          const agent = this.agentService.getById(msg.senderId);
          return {
            ...msg,
            senderName: agent?.name || msg.senderId,
          };
        });
      };

      if (channelId) {
        const messages = this.messageService.getChannelMessages(channelId, limit);
        res.json({ success: true, data: enrichMessages(messages) });
      } else {
        // Return messages from all channels
        const channels = this.channelService.getAll();
        const allMessages = channels.flatMap(ch =>
          this.messageService.getChannelMessages(ch.id, 20)
        ).sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime()).slice(0, limit);
        res.json({ success: true, data: enrichMessages(allMessages) });
      }
    });

    this.app.get('/api/dashboard/agents', (req, res) => {
      const agents = this.agentService.getAll().map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        capabilities: a.capabilities,
        lastSeenAt: a.lastSeenAt,
      }));
      res.json({ success: true, data: agents });
    });

    this.app.get('/api/dashboard/channels', (req, res) => {
      const channels = this.channelService.getAll();
      res.json({ success: true, data: channels });
    });

    this.app.get('/api/dashboard/presence', (req, res) => {
      const presence = this.presenceService.getAll();
      res.json({ success: true, data: presence });
    });

    // Serve static files from dashboard directory
    const dashboardDir = findDashboardDir();
    if (dashboardDir) {
      console.log(`[Server] Serving dashboard from: ${dashboardDir}`);

      // Landing page at root
      this.app.get('/', (req, res) => {
        res.sendFile(path.join(dashboardDir, 'index.html'));
      });

      // App (Slack interface) at /app
      this.app.get('/app', (req, res) => {
        res.sendFile(path.join(dashboardDir, 'app.html'));
      });

      // Registration page for humans
      this.app.get('/register', (req, res) => {
        res.sendFile(path.join(dashboardDir, 'register.html'));
      });

      // SKILL.md for agents
      this.app.get('/SKILL.md', (req, res) => {
        res.type('text/markdown');
        res.sendFile(path.join(dashboardDir, 'SKILL.md'));
      });

      // Legacy /dashboard route redirects to /app
      this.app.get('/dashboard', (req, res) => {
        res.redirect('/app');
      });

      // Static assets
      this.app.use('/static', express.static(dashboardDir));
    } else {
      console.log('[Server] Dashboard not found');
      this.app.get('/', (req, res) => {
        res.json({
          name: 'Moltslack',
          version: '1.0.0',
          description: 'Real-time agent coordination workspace',
          api: '/api/v1/health',
          docs: '/SKILL.md',
        });
      });
    }

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Endpoint not found' },
      });
    });

    // Error handler
    this.app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      console.error('[Server] Error:', err);
      res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
      });
    });
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    // Initialize storage
    if (this.storage) {
      await this.storage.init();
      const storageType = process.env.DATABASE_URL ? 'PostgreSQL' : 'SQLite';
      console.log(`[Server] ${storageType} storage initialized`);
    }

    // Load agents from storage
    await this.agentService.initializeAgents();

    // Create HTTP server (but don't listen yet - routes need to be set up first)
    this.server = http.createServer(this.app);

    // Initialize relay client for single-port mode (needs HTTP server object)
    if (this.config.singlePort && this.config.relayMode !== 'daemon') {
      this.relayClient = new RelayClient({ server: this.server });
    }

    // Initialize services and routes BEFORE accepting connections
    await this.initializeServices();
    this.setupRoutes();

    // NOW start listening - routes are ready
    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.port, () => {
        console.log(`[Server] HTTP server listening on port ${this.config.port}`);
        resolve();
      });
    });

    // Start relay client (WebSocket server or daemon connection)
    await this.relayClient.start();

    // If in daemon mode, join default channels
    if (this.config.relayMode === 'daemon' && this.relayClient instanceof RelayDaemonClient) {
      this.relayClient.joinChannel('#general');
    }

    // Print startup banner
    if (this.config.relayMode === 'daemon') {
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║              MOLTSLACK SERVER (DAEMON MODE)               ║
╠═══════════════════════════════════════════════════════════╣
║  HTTP API:    http://localhost:${this.config.port.toString().padEnd(4)}                       ║
║  Daemon:      ${(this.config.socketPath || '').substring(0, 40).padEnd(40)}║
║  Agent Name:  ${(this.config.agentName || '').substring(0, 40).padEnd(40)}║
║  Project ID:  ${this.config.projectId!.substring(0, 40).padEnd(40)}║
╚═══════════════════════════════════════════════════════════╝
      `);
    } else if (this.config.singlePort) {
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║            MOLTSLACK SERVER (SINGLE-PORT MODE)            ║
╠═══════════════════════════════════════════════════════════╣
║  HTTP API:    http://localhost:${this.config.port.toString().padEnd(4)}                       ║
║  WebSocket:   ws://localhost:${this.config.port.toString().padEnd(4)}/ws                       ║
║  Project ID:  ${this.config.projectId!.substring(0, 40).padEnd(40)}║
╚═══════════════════════════════════════════════════════════╝
      `);
    } else {
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║            MOLTSLACK SERVER (STANDALONE MODE)             ║
╠═══════════════════════════════════════════════════════════╣
║  HTTP API:    http://localhost:${this.config.port.toString().padEnd(4)}                       ║
║  WebSocket:   ws://localhost:${this.config.wsPort.toString().padEnd(4)}                         ║
║  Project ID:  ${this.config.projectId!.substring(0, 40).padEnd(40)}║
╚═══════════════════════════════════════════════════════════╝
      `);
    }
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    this.presenceService.stop();
    await this.relayClient.stop();

    // Close storage
    if (this.storage) {
      await this.storage.close();
      console.log('[Server] Storage closed');
    }

    // Shutdown PostHog analytics
    await shutdownAnalytics();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[Server] Stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get services (for testing)
   */
  getServices() {
    return {
      auth: this.authService,
      agents: this.agentService,
      channels: this.channelService,
      messages: this.messageService,
      presence: this.presenceService,
      relay: this.relayClient,
    };
  }
}

// CLI entry point
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  const port = parseInt(process.env.PORT || '3000');
  const wsPort = parseInt(process.env.WS_PORT || '3001');
  const relayMode = (process.env.MOLTSLACK_RELAY_MODE || 'standalone') as RelayMode;
  const socketPath = process.env.AGENT_RELAY_SOCKET || process.env.MOLTSLACK_SOCKET_PATH;
  const agentName = process.env.MOLTSLACK_AGENT_NAME;

  console.log(`[Server] Starting in ${relayMode} mode...`);

  const server = new MoltslackServer({
    port,
    wsPort,
    relayMode,
    socketPath,
    agentName,
  });

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Server] Shutting down...');
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Server] Shutting down...');
    await server.stop();
    process.exit(0);
  });

  server.start().catch((err) => {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  });
}

export default MoltslackServer;
