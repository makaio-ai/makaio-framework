import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSchemas, type AgentStarted } from '@makaio/contracts';
import { updateAgentActivityStatusBestEffort } from './agent-storage-status.js';
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
  /** Clear tool-call tracker entries owned by one terminal message. */
  clearMessageToolCalls: (messageId: string) => void;
}

/**
 * Stateful lifecycle emitter for AIAgent terminal/start/session events.
 */
export class AgentLifecycleEmitter {
  private static readonly COMPLETION_DEDUP_LIMIT = 1024;
  /** Tracks whether session.closed has been emitted (emit only once). */
  private sessionClosedEmitted = false;
  /** Terminal messages already emitted; overlapping handles must not share a mutable turn guard. */
  private readonly completedMessageIds = new Set<string>();
  private readonly completedMessageOrder: string[] = [];
  private readonly config: AgentLifecycleEmitterConfig;

  public constructor(config: AgentLifecycleEmitterConfig) {
    this.config = config;
  }

  /**
   * Emit `agent.started`.
   * @param event - Start payload without auto-enriched AgentContext fields
   */
  public async emitStart(
    event: Omit<AgentStarted, 'agentId' | 'adapterId' | 'adapterName' | 'adapterSessionId'>,
  ): Promise<void> {
    await this.config.emitStarted(event);
  }

  /**
   * Emit a terminal completion event for one message handle.
   * @param result - Completion payload without AgentContext fields
   */
  public async emitCompletion(result: Omit<z.infer<typeof AgentSchemas.complete>, keyof AgentContext>): Promise<void> {
    if (this.completedMessageIds.has(result.messageId)) return;
    this.completedMessageIds.add(result.messageId);
    try {
      await this.config.onBeforeEmitCompletion();
      this.config.clearMessageToolCalls(result.messageId);
      await this.config.emitComplete(result);
      this.completedMessageOrder.push(result.messageId);
      if (this.completedMessageOrder.length > AgentLifecycleEmitter.COMPLETION_DEDUP_LIMIT) {
        const released = this.completedMessageOrder.shift();
        if (released !== undefined) this.completedMessageIds.delete(released);
      }
      updateAgentActivityStatusBestEffort(this.config.globalBus, this.config.agentId, 'idle');
    } catch (error) {
      this.completedMessageIds.delete(result.messageId);
      throw error;
    }
  }

  /**
   * Emit `agent.session.closed` once for this agent lifecycle.
   * @param reason - Optional closure reason
   */
  public emitSessionClosed(reason?: string): void {
    if (this.sessionClosedEmitted) return;
    this.sessionClosedEmitted = true;
    void this.config.emitSessionClosed({ reason }).catch((error) => {
      console.warn(`[AIAgent] Failed to emit session.closed for agent ${this.config.agentId}:`, error);
    });
  }
}
