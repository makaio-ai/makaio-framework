import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  type Message,
  type SessionExtensionContext,
  type ForkOptions,
  type ContextWindowState,
} from '@makaio/contracts';
import type { ContextWindowTracker } from './context-window/index.js';

/**
 * Implementation of SessionExtensionContext.
 * Routes all actions through bus subjects.
 */
export class SessionExtensionContextImpl implements SessionExtensionContext {
  private readonly contextContributions = new Map<string, unknown>();

  public constructor(
    private readonly bus: IMakaioBus,
    private readonly _sessionId: string,
    private readonly _extensionId: string,
    private readonly _turnId?: string,
    private readonly _parentSessionId?: string,
    private readonly contextTracker?: ContextWindowTracker,
  ) {}

  // --- Read-Only Properties ---

  public get sessionId(): string {
    return this._sessionId;
  }

  public get turnId(): string | undefined {
    return this._turnId;
  }

  public get parentSessionId(): string | undefined {
    return this._parentSessionId;
  }

  public get extensionId(): string {
    return this._extensionId;
  }

  // --- Message Actions ---

  public async sendToAgent(agentId: string, message: Message): Promise<void> {
    await this.bus.request(SessionSubjects.sendMessage, {
      sessionId: this._sessionId,
      agentIds: [agentId],
      message,
      // Audit trail
      source: 'extension',
      extensionId: this._extensionId,
    });
  }

  // --- Context Contribution ---

  public contributeContext(key: string, value: unknown): void {
    this.contextContributions.set(key, value);
  }

  /**
   * Get all contributions (called by orchestrator at turn boundary).
   * @returns Record of all context contributions
   */
  public getContributions(): Record<string, unknown> {
    return Object.fromEntries(this.contextContributions);
  }

  // --- Session Lifecycle ---

  public async fork(options: ForkOptions): Promise<string> {
    const result = await this.bus.request(SessionSubjects.fork, {
      sourceSessionId: this._sessionId,
      name: options.reason,
      // Note: targetAgentId/initialMessage/inheritContext require fork handler extension
    });
    return result.sessionId;
  }

  public async merge(childSessionId: string, summary?: string): Promise<void> {
    await this.bus.request(SessionSubjects.merge, {
      parentSessionId: this._sessionId,
      childSessionId,
      summary,
      source: 'extension',
      extensionId: this._extensionId,
    });
  }

  public async abandon(childSessionId: string): Promise<void> {
    await this.bus.request(SessionSubjects.abandon, {
      parentSessionId: this._sessionId,
      childSessionId,
      source: 'extension',
      extensionId: this._extensionId,
    });
  }

  // --- Compression ---

  public async requestCompression(reason: string): Promise<void> {
    await this.bus.emit(SessionSubjects.compressionRequested, {
      sessionId: this._sessionId,
      reason,
      source: 'extension',
      extensionId: this._extensionId,
    });
  }

  // --- Query ---

  public async getContextWindowState(): Promise<ContextWindowState> {
    // Try tracker first for real-time data
    if (this.contextTracker) {
      const state = this.contextTracker.getSessionState(this._sessionId);
      if (state) {
        return {
          currentTokens: state.currentTokens,
          maxTokens: state.maxTokens,
          percentage: state.percentage,
          level: state.level,
        };
      }
    }

    // Fallback: check session for agents
    const { session } = await this.bus.request(SessionSubjects.get, {
      sessionId: this._sessionId,
    });

    if (!session || session.agents.length === 0) {
      return { currentTokens: 0, maxTokens: 1, percentage: 0, level: 'ok' };
    }

    // No tracking data yet - return safe default
    return { currentTokens: 0, maxTokens: 200000, percentage: 0, level: 'ok' };
  }

  public async getChildSessions(): Promise<string[]> {
    const result = await this.bus.request(SessionSubjects.getChildren, {
      sessionId: this._sessionId,
    });
    return result.children.map((child) => child.sessionId);
  }
}

/**
 * Factory function for creating SessionExtensionContext instances.
 * @param bus - The bus instance for communication
 * @param sessionId - The session identifier
 * @param extensionId - The extension identifier for audit trail
 * @param turnId - Optional current turn identifier
 * @param parentSessionId - Optional parent session identifier (for forked sessions)
 * @param contextTracker - Optional ContextWindowTracker for real-time context state
 * @returns A new SessionExtensionContextImpl instance
 */
export function createSessionExtensionContext(
  bus: IMakaioBus,
  sessionId: string,
  extensionId: string,
  turnId?: string,
  parentSessionId?: string,
  contextTracker?: ContextWindowTracker,
): SessionExtensionContextImpl {
  return new SessionExtensionContextImpl(bus, sessionId, extensionId, turnId, parentSessionId, contextTracker);
}
