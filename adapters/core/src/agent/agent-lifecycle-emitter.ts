import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/core';
import { AgentSchemas, type AgentStarted } from '@makaio/contracts';
import { updateAgentActivityStatusBestEffort } from './agent-storage-status.js';
import type { AgentContext } from './types.js';
import { z } from 'zod';
import type { MessageResult } from '../message-handle/index.js';
import { extractErrorCategory } from './agent-config-input.js';

/**
 * Build the `agent.complete` payload for a message that reached its terminal result.
 * @param messageId - Message that completed
 * @param result - Terminal result of the message handle
 * @param turnId - Lifecycle turn the message belonged to, when it had one
 * @returns Completion payload without AgentContext fields
 */
export function buildCompletionPayload(
  messageId: string,
  result: MessageResult,
  turnId: string | undefined,
): Omit<z.infer<typeof AgentSchemas.complete>, keyof AgentContext> {
  const error = result.error;
  const errorStr = error instanceof Error ? error.message : error;
  const errorCategory = error instanceof Error ? extractErrorCategory(error) : undefined;
  return {
    message: result.result?.message,
    messageId,
    ...(turnId !== undefined && { turnId }),
    outcome: result.outcome,
    ...(errorStr && { error: errorStr }),
    ...(errorCategory && { errorCategory }),
    ...(result.structuredOutputValidation !== undefined
      ? { structuredOutputValidation: result.structuredOutputValidation }
      : {}),
  };
}

/**
 * Dependencies for AgentLifecycleEmitter.
 */
export interface AgentLifecycleEmitterConfig {
  /** Stable agent identifier for persistence updates. */
  agentId: string;
  /** Global bus for best-effort status updates. */
  globalBus: IMakaioBus;
  /**
   * Emit callback for `agent.started`.
   * @param call - Call context the emission is made under
   * @param payload - Start payload without auto-enriched AgentContext fields
   */
  emitStarted: (
    call: CallContext,
    payload: Omit<AgentStarted, 'agentId' | 'adapterId' | 'adapterName' | 'adapterSessionId'>,
  ) => Promise<void>;
  /**
   * Emit callback for `agent.complete`.
   * @param call - Call context the emission is made under
   * @param payload - Completion payload without AgentContext fields
   */
  emitComplete: (
    call: CallContext,
    payload: Omit<z.infer<typeof AgentSchemas.complete>, keyof AgentContext>,
  ) => Promise<void>;
  /**
   * Emit callback for `agent.session.closed`.
   * @param call - Call context the emission is made under
   * @param payload - Closure payload
   */
  emitSessionClosed: (call: CallContext, payload: { reason?: string }) => Promise<void>;
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
   * @param call - Call context of the message that starts the agent
   * @param event - Start payload without auto-enriched AgentContext fields
   */
  public async emitStart(
    call: CallContext,
    event: Omit<AgentStarted, 'agentId' | 'adapterId' | 'adapterName' | 'adapterSessionId'>,
  ): Promise<void> {
    await this.config.emitStarted(call, event);
  }

  /**
   * Emit a terminal completion event for one message handle.
   * @param call - Call context of the message that completed
   * @param result - Completion payload without AgentContext fields
   */
  public async emitCompletion(
    call: CallContext,
    result: Omit<z.infer<typeof AgentSchemas.complete>, keyof AgentContext>,
  ): Promise<void> {
    if (this.completedMessageIds.has(result.messageId)) return;
    this.completedMessageIds.add(result.messageId);
    try {
      await this.config.onBeforeEmitCompletion();
      this.config.clearMessageToolCalls(result.messageId);
      await this.config.emitComplete(call, result);
      this.completedMessageOrder.push(result.messageId);
      if (this.completedMessageOrder.length > AgentLifecycleEmitter.COMPLETION_DEDUP_LIMIT) {
        const released = this.completedMessageOrder.shift();
        if (released !== undefined) this.completedMessageIds.delete(released);
      }
      updateAgentActivityStatusBestEffort(call, this.config.globalBus, this.config.agentId, 'idle');
    } catch (error) {
      this.completedMessageIds.delete(result.messageId);
      throw error;
    }
  }

  /**
   * Emit `agent.session.closed` once for this agent lifecycle.
   * @param call - Call context of the close or abort that ends the session
   * @param reason - Optional closure reason
   */
  public emitSessionClosed(call: CallContext, reason?: string): void {
    if (this.sessionClosedEmitted) return;
    this.sessionClosedEmitted = true;
    void this.config.emitSessionClosed(call, { reason }).catch((error) => {
      console.warn(`[AIAgent] Failed to emit session.closed for agent ${this.config.agentId}:`, error);
    });
  }
}
