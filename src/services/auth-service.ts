/**
 * AuthService - Authentication and authorization for agents
 * Zero-trust model with scoped tokens
 */

import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import type { Permission, TokenPayload, Agent } from '../models/types.js';

const DEFAULT_TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000; // 7 days

export class AuthService {
  private secret: string;
  private tokenExpiry: number;

  constructor(secret?: string, tokenExpiry?: number) {
    this.secret = secret || process.env.JWT_SECRET || uuid();
    this.tokenExpiry = tokenExpiry || DEFAULT_TOKEN_EXPIRY;

    if (!process.env.JWT_SECRET) {
      console.warn('[Auth] No JWT_SECRET set, using random secret (tokens will not persist across restarts)');
    }
  }

  /**
   * Generate a token for an agent
   */
  generateToken(agent: Pick<Agent, 'id' | 'name' | 'permissions'>): string {
    const now = Date.now();
    const payload: TokenPayload = {
      agentId: agent.id,
      agentName: agent.name,
      permissions: agent.permissions,
      issuedAt: now,
      expiresAt: now + this.tokenExpiry,
    };

    return jwt.sign(payload, this.secret, { expiresIn: this.tokenExpiry / 1000 });
  }

  /**
   * Verify and decode a token
   */
  verifyToken(token: string): TokenPayload | null {
    try {
      const payload = jwt.verify(token, this.secret) as TokenPayload;

      // Check expiration
      if (payload.expiresAt < Date.now()) {
        return null;
      }

      return payload;
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if a token has permission for an action on a resource
   */
  hasPermission(
    token: string,
    resource: string,
    action: 'read' | 'write' | 'admin'
  ): boolean {
    const payload = this.verifyToken(token);
    if (!payload) return false;

    return this.checkPermissions(payload.permissions, resource, action);
  }

  /**
   * Check permissions array against resource and action
   */
  checkPermissions(
    permissions: Permission[],
    resource: string,
    action: 'read' | 'write' | 'admin'
  ): boolean {
    for (const perm of permissions) {
      // Check if permission matches resource
      if (this.matchResource(perm.resource, resource)) {
        // Check if action is allowed
        if (perm.actions.includes(action) || perm.actions.includes('admin')) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Match permission resource pattern against requested resource
   * Supports wildcards: channel:* matches channel:general
   */
  private matchResource(pattern: string, resource: string): boolean {
    if (pattern === '*') return true;
    if (pattern === resource) return true;

    // Handle wildcard patterns
    if (pattern.endsWith(':*')) {
      const prefix = pattern.slice(0, -1); // Remove '*'
      return resource.startsWith(prefix);
    }

    return false;
  }

  /**
   * Create default permissions for a new agent
   */
  createDefaultPermissions(): Permission[] {
    return [
      { resource: 'channel:*', actions: ['read', 'write'] },
      { resource: 'message:*', actions: ['read', 'write'] },
      { resource: 'presence:*', actions: ['read', 'write'] },
    ];
  }

  /**
   * Create admin permissions
   */
  createAdminPermissions(): Permission[] {
    return [
      { resource: '*', actions: ['admin'] },
    ];
  }

  /**
   * Extract agent ID from authorization header
   */
  extractAgentId(authHeader: string | undefined): string | null {
    if (!authHeader) return null;

    const token = authHeader.replace(/^Bearer\s+/i, '');
    const payload = this.verifyToken(token);
    return payload?.agentId || null;
  }

  /**
   * Create a middleware function for Express
   */
  middleware() {
    return (req: any, res: any, next: any) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'No authorization header' },
        });
      }

      const token = authHeader.replace(/^Bearer\s+/i, '');
      const payload = this.verifyToken(token);

      if (!payload) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' },
        });
      }

      req.agent = payload;
      next();
    };
  }
}

export default AuthService;
