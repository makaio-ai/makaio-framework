import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSchemas, type AgentStarted } from '@makaio/contracts';
import { AgentStorageSubjects } from '@makaio/services-core/session';
import type { AgentContext } from './types.js';
import { z } from 'zod';

/**
 * Dependencies for AgentLifecycleEmitter.
 */
export interface AgentLifecycleEmitterConfig {
  /** Stable agent identifier for persistence updates. */
  agentId: string;
  /** Global bus for best-effort status updates. */
  globalBus: IMakaioBus;
  /** Emit callback for `agent.started`. */
  emitStarted: (
    payload: Omit<AgentStarted, 'agentId' | 'adapterId' | 'adapterName' | 'adapterSessionId'>,
  ) => Promise<void>;
  /** Emit callback for `agent.complete`. */
  emitComplete: (payload: Omit<z.infer<typeof AgentSchemas.complete>, keyof AgentContext>) => Promise<void>;
  /** Emit callback for `agent.session.closed`. */
  emitSessionClosed: (payload: { reason?: string }) => Promise<void>;
  /** Hook executed before terminal completion emission. */
  onBeforeEmitCompletion: () => Promise<void>;
  /** Clear tool-call tracker entries on terminal outcomes. */
  clearToolCallTracker: () => void;
}

/**
 * Stateful lifecycle emitter for AIAgent terminal/start/session events.
 */
export class AgentLifecycleEmitter {
  /** Tracks whether session.closed has been emitted (emit only once). */
  private sessionClosedEmitted = false;
  /** Tracks whether agent.started has been emitted (lifecycle invariant). */
  private agentStartedEmitted = false;
  /** Tracks whether agent.complete has been emitted for the current turn. */
  private agentCompleteEmitted = false;
  /** Stashed error category consumed by the next emitCompletion call. */
  private pendingErrorCategory?: z.infer<typeof AgentSchemas.complete>['errorCategory'];

  private readonly config: AgentLifecycleEmitterConfig;

  public constructor(config: AgentLifecycleEmitterConfig) {
    this.config = config;
  }

  /**
   * Emit `agent.started` and reset per-turn lifecycle state.
   * @param event - Start payload without auto-enriched AgentContext fields
   */
  public async emitStart(
    event: Omit<AgentStarted, 'agentId' | 'adapterId' | 'adapterName' | 'adapterSessionId'>,
  ): Promise<void> {
    this.agentStartedEmitted = true;
    this.agentCompleteEmitted = false;
    this.pendingErrorCategory = undefined;
    await this.config.emitStarted(event);
  }

  /**
   * Reset per-turn dedup state so the next completion can fire.
   *
   * Called when a new message handle is tracked — guarantees the guard
   * resets per-turn even for adapters that don't emit `agent.started`
   * on every turn (e.g., codex emits `thread_started` once per thread).
   */
  public resetTurnState(): void {
    this.agentCompleteEmitted = false;
    this.pendingErrorCategory = undefined;
  }

  /**
   * Emit terminal completion event with deferred error-category propagation.
   * @param result - Completion payload without AgentContext fields
   */
  public async emitCompletion(result: Omit<z.infer<typeof AgentSchemas.complete>, keyof AgentContext>): Promise<void> {
    if (this.agentCompleteEmitted) return;
    await this.config.onBeforeEmitCompletion();
    this.agentCompleteEmitted = true;
    this.config.clearToolCallTracker();

    const errorCategory = this.pendingErrorCategory;
    this.pendingErrorCategory = undefined;

    void this.config.globalBus.requestOptional(AgentStorageSubjects.updateStatus, {
      agentId: this.config.agentId,
      status: 'idle',
    });

    await this.config.emitComplete({
      ...result,
      ...(errorCategory && { errorCategory }),
    });
  }

  /**
   * Stash error metadata for the next completion emission.
   * @param result - Error payload from connector/runtime error handler
   */
  public emitError(result: Pick<z.infer<typeof AgentSchemas.complete>, 'error' | 'errorCategory'>): void {
    this.config.clearToolCallTracker();
    this.pendingErrorCategory = result.errorCategory;
  }

  /**
   * Emit `agent.session.closed` once for this agent lifecycle.
   * @param reason - Optional closure reason
   */
  public emitSessionClosed(reason?: string): void {
    if (this.sessionClosedEmitted) return;
    this.sessionClosedEmitted = true;
    void this.config.emitSessionClosed({ reason });
  }
}
