import type { ScopedBus } from '@makaio/bus-core';
import type { MessageHandle } from '../message-handle/message-handle.js';
import { SESSION_CLOSED_QUEUE_ERROR } from '../session/process-queue.js';

/**
 * Configuration for a connector session.
 * @typeParam TBus - Scoped bus type for adapter namespace
 */
export interface ConnectorSessionConfig<TBus extends ScopedBus<string> = ScopedBus<string>> {
  bus: TBus;
  adapterId: string;
  adapterName: string;
  cwd: string;
  model: string;
  env: Record<string, string>;
  /** Auth-free environment safe for bus-routable tool and MCP contexts. */
  contextEnv?: Readonly<Record<string, string>>;
}

/**
 * Interface for turn-like objects that support pause/abort operations.
 * Allows base session class to work with different turn implementations.
 */
export interface PausableTurn {
  pause(): Promise<unknown>;
}

/**
 * Base abstract class for connector session implementations.
 *
 * Sessions manage SDK query lifecycle across multiple turns:
 * - SDK connection management
 * - Turn creation and coordination
 * - Session ID management
 *
 * Each adapter implements its own session subclass.
 * @typeParam TConfig - Configuration type extending ConnectorSessionConfig
 */
export abstract class BaseConnectorSession<TConfig extends ConnectorSessionConfig = ConnectorSessionConfig> {
  protected readonly config: TConfig;
  protected readonly bus: TConfig['bus'];
  protected sessionId?: string;
  protected currentTurn?: PausableTurn;

  /**
   * True once `close()` or `abort()` has begun; gates queue processing.
   *
   * ## Shutdown vs queue processing invariant
   *
   * Once `close()` or `abort()` begins, no new turn may start.
   * `processQueue` implementations must refuse to dequeue or start turns
   * when `this.closing` is `true`, and drain all remaining queued handles
   * with an error outcome so that callers awaiting `waitForCompletion()`
   * resolve deterministically instead of hanging.
   *
   * A dequeued handle that has entered the start-turn path either starts
   * its turn before `close()` begins, or is completed with the closing
   * error at every await point where `close()` can interleave. This is
   * enforced by {@link completeHandleIfClosing}, which rechecks the flag
   * after each awaited setup step and completes the handle with the same
   * error contract used by {@link rejectQueuedHandles}.
   */
  protected closing = false;

  public constructor(config: TConfig) {
    this.config = config;
    this.bus = config.bus;
  }

  /**
   * Recheck the shutdown flag after an awaited setup step in the start path.
   *
   * When `close()` sets `this.closing` while the subclass start-turn method
   * is awaiting an async setup step (schema rotation, query creation, MCP
   * registration, env resolution), the dequeued handle is no longer in the
   * queue and {@link rejectQueuedHandles} cannot reach it. This helper
   * completes the handle with the same error contract so callers see a
   * consistent shutdown outcome.
   * @param handle - Dequeued message handle currently being set up
   * @returns `true` when the session is closing and the handle was completed
   */
  protected completeHandleIfClosing(handle: MessageHandle): boolean {
    if (!this.closing) return false;
    if (!handle.isProcessed) {
      handle.markCompleted({
        outcome: 'error',
        error: new Error(SESSION_CLOSED_QUEUE_ERROR),
      });
    }
    return true;
  }

  /**
   * Abort the session and cleanup resources.
   * Pauses the current turn if one is active.
   */
  public async abort(): Promise<void> {
    await this.currentTurn?.pause();
  }

  /**
   * Send a message to the provider.
   * Not used - subclasses should implement processQueue instead.
   * @param _message - Unused message parameter
   * @param _options - Unused options parameter
   */
  public async sendMessage(_message: unknown, _options?: unknown): Promise<void> {
    throw new Error('Use processQueue instead');
  }

  /**
   * Get the adapter session ID.
   * @returns The session ID from the provider
   */
  public async getAdapterSessionId(): Promise<string> {
    return this.sessionId!;
  }
}
