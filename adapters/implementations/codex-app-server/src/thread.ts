/**
 * Codex App-Server Thread Management
 *
 * Manages thread lifecycle for the codex app-server protocol.
 * Threads represent conversations (similar to MCP sessions).
 *
 * Key differences from MCP:
 * - Uses threadId instead of sessionId
 * - Events: thread/started, thread/completed, thread/tokenUsage/updated
 * - No separate "session_configured" event - threadId comes from thread/started
 */

import type { CodexAppServerBus } from './namespaces/index.js';
import { CodexAppServerSubjects } from './namespaces/index.js';

/**
 * Thread state in the app-server protocol.
 */
export type ThreadState = 'active' | 'completed' | 'archived';

/**
 * Thread configuration overrides.
 * Matches app-server ThreadConfig structure.
 */
export interface ThreadConfig {
  model?: string;
  cwd?: string;
  approvalPolicy?: 'never' | 'always' | 'auto';
  sandboxMode?: 'none' | 'docker' | 'vm';
}

/**
 * Token usage from thread/tokenUsage/updated event.
 */
export interface TokenUsage {
  promptTokens: number;
  inputCachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  modelContextWindow?: number;
}

/**
 * Thread configuration for CodexAppServerThread.
 */
export interface CodexAppServerThreadConfig {
  bus: CodexAppServerBus;
  adapterId: string;
  agentId: string;
}

/**
 * Thread lifecycle management for Codex App-Server.
 *
 * Tracks thread state and emits namespace bus events:
 * - thread_started when thread/started notification received
 * - thread_completed when thread is archived or completed
 * - token_usage when thread/tokenUsage/updated received
 *
 * Thread is created by connector when thread/start response is received,
 * and updated throughout the conversation via notifications.
 */
export class CodexAppServerThread {
  private readonly bus: CodexAppServerBus;
  private readonly adapterId: string;
  private readonly agentId: string;
  private _threadId?: string;
  private _state: ThreadState = 'active';
  private _config: ThreadConfig = {};
  private _tokenUsage?: TokenUsage;

  public constructor(config: CodexAppServerThreadConfig) {
    this.bus = config.bus;
    this.adapterId = config.adapterId;
    this.agentId = config.agentId;
  }

  /**
   * Get the thread ID.
   * @returns Thread ID or undefined if not yet started
   */
  public get threadId(): string | undefined {
    return this._threadId;
  }

  /**
   * Get the current thread state.
   * @returns Current thread state
   */
  public get state(): ThreadState {
    return this._state;
  }

  /**
   * Get the thread configuration.
   * @returns Thread configuration overrides
   */
  public get config(): ThreadConfig {
    return { ...this._config };
  }

  /**
   * Get the current token usage.
   * @returns Token usage or undefined if not yet received
   */
  public get tokenUsage(): TokenUsage | undefined {
    return this._tokenUsage;
  }

  /**
   * Check if thread is active.
   * @returns True if thread is active
   */
  public isActive(): boolean {
    return this._state === 'active';
  }

  /**
   * Check if thread is completed.
   * @returns True if thread is completed
   */
  public isCompleted(): boolean {
    return this._state === 'completed';
  }

  /**
   * Handle thread/started notification.
   * Sets threadId and transitions to active state.
   * @param threadId - Thread ID from thread/started notification
   */
  public async handleThreadStarted(threadId: string): Promise<void> {
    this._threadId = threadId;
    this._state = 'active';

    await this.bus.emit(CodexAppServerSubjects.thread_started, {
      agentId: this.agentId,
      threadId: this._threadId,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle thread completion or archival.
   * Transitions state and emits completion event.
   * @param newState - New thread state (completed or archived)
   */
  public async handleThreadCompleted(newState: 'completed' | 'archived' = 'completed'): Promise<void> {
    if (!this._threadId) {
      throw new Error('Cannot complete thread: threadId not set');
    }

    this._state = newState;

    await this.bus.emit(CodexAppServerSubjects.thread_completed, {
      agentId: this.agentId,
      threadId: this._threadId,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle thread/tokenUsage/updated notification.
   * Updates token usage tracking.
   * @param promptTokens - Prompt/input tokens used
   * @param inputCachedTokens - Cached input tokens reused for this update
   * @param completionTokens - Completion/output tokens used
   * @param reasoningTokens - Reasoning output tokens used (subset of completionTokens)
   * @param totalTokens - Full protocol-reported total for this update
   * @param modelContextWindow - Optional model context window size
   */
  public async handleTokenUsageUpdated(
    promptTokens: number,
    inputCachedTokens: number,
    completionTokens: number,
    reasoningTokens: number,
    totalTokens: number,
    modelContextWindow?: number,
  ): Promise<void> {
    this._tokenUsage = {
      promptTokens,
      inputCachedTokens,
      completionTokens,
      reasoningTokens,
      totalTokens,
      modelContextWindow,
    };

    await this.bus.emit(CodexAppServerSubjects.token_usage, {
      agentId: this.agentId,
      threadId: this._threadId ?? '',
      promptTokens,
      inputCachedTokens,
      completionTokens,
      reasoningTokens,
      totalTokens,
      modelContextWindow,
      timestamp: Date.now(),
    });
  }

  /**
   * Update thread configuration.
   * Used for per-turn overrides.
   * @param config - Configuration updates
   */
  public updateConfig(config: Partial<ThreadConfig>): void {
    this._config = { ...this._config, ...config };
  }
}
