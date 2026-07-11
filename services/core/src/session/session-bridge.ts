import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects, type SessionMessageBlock } from '@makaio/contracts';
import { MessageStorageSubjects } from './messages/namespace.js';
import { MessageRoutingSubjects } from './message-routing/namespace.js';

/**
 * Handles agent message persistence to session storage.
 *
 * Maintains agentId to sessionId mapping from session.agent.added events,
 * accumulates message blocks from agent.* events, and stores them
 * as assistant messages on agent.complete.
 *
 * Note: Does NOT bridge events to session.agent.* namespace anymore.
 * Consumers should subscribe directly to AgentSubjects.* with sessionId filter.
 */
/** Turn-scoped assistant response owned by SessionBridge until matching completion. */
interface PendingAssistantResponse {
  sessionId: string;
  turnId: string;
  messageId: string;
  agentId: string;
  blocks: SessionMessageBlock[];
}

/**
 * Validated terminal message override from agent completion metadata.
 *
 * When structured-output enforcement rewrites the terminal text, this content
 * replaces the accumulated provider blocks so persisted assistant history
 * stores the authoritative post-validation message.
 */
interface AssistantMessageOverride {
  content?: string;
}

export class SessionBridge {
  private readonly agentToSession = new Map<string, string>();
  /** Pending responses keyed by immutable turn/message/agent delivery identity. */
  private readonly pendingAssistantResponses = new Map<string, PendingAssistantResponse>();
  private readonly cleanups: Array<() => void> = [];

  public constructor(private readonly bus: IMakaioBus = MakaioBus) {
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.registerMappingHandlers();
    this.registerTurnTrackingHandlers();
    this.registerBlockAccumulationHandlers();
  }

  /**
   * Build and maintain agentId→sessionId mapping.
   */
  private registerMappingHandlers(): void {
    // Build mapping from session.agent.added
    this.cleanups.push(
      this.bus.on(SessionSubjects.agent.added, (ctx) => {
        this.agentToSession.set(ctx.payload.agentId, ctx.payload.sessionId);
      }),
    );

    // Clean up mapping when session closes
    this.cleanups.push(
      this.bus.on(SessionSubjects.closed, (ctx) => {
        for (const [agentId, sessionId] of this.agentToSession) {
          if (sessionId === ctx.payload.sessionId) {
            this.agentToSession.delete(agentId);
          }
        }
        for (const [key, pending] of this.pendingAssistantResponses) {
          if (pending.sessionId === ctx.payload.sessionId) this.pendingAssistantResponses.delete(key);
        }
      }),
    );
  }

  /**
   * Track turn assignments for agents.
   */
  private registerTurnTrackingHandlers(): void {
    // `turn.started` is the durable first-message lifecycle record. Seed its
    // exact fanout as well; later `user_message.sent` records additional
    // messages in the same turn without replacing this response.
    this.cleanups.push(
      this.bus.on(SessionSubjects.turn.started, (ctx) => {
        const { sessionId, turnId, messageId, agentIds } = ctx.payload;
        for (const agentId of agentIds) {
          const key = this.pendingKey(turnId, messageId, agentId);
          if (!this.pendingAssistantResponses.has(key)) {
            this.pendingAssistantResponses.set(key, { sessionId, turnId, messageId, agentId, blocks: [] });
          }
        }
      }),
    );
    // Seed every admitted delivery before provider work starts.
    this.cleanups.push(
      this.bus.on(SessionSubjects.user_message.sent, (ctx) => {
        const { sessionId, turnId, messageId, agentIds } = ctx.payload;
        for (const agentId of agentIds) {
          const key = this.pendingKey(turnId, messageId, agentId);
          this.pendingAssistantResponses.set(key, {
            sessionId,
            turnId,
            messageId,
            agentId,
            blocks: [],
          });
        }
      }),
    );

    // Associate acknowledged fallback deliveries to the existing turn context.
    this.cleanups.push(
      this.bus.on(SessionSubjects.user_message.acknowledged, (ctx) => {
        const key = this.pendingKey(ctx.payload.turnId, ctx.payload.messageId, ctx.payload.agentId);
        if (!this.pendingAssistantResponses.has(key)) {
          this.pendingAssistantResponses.set(key, {
            sessionId: ctx.payload.sessionId,
            turnId: ctx.payload.turnId,
            messageId: ctx.payload.messageId,
            agentId: ctx.payload.agentId,
            blocks: [],
          });
        }
      }),
    );
    this.cleanups.push(
      this.bus.on(SessionSubjects.turn.assistantPersistenceSettled, (ctx) => {
        const { turnId, messageId, agentId } = ctx.payload;
        this.pendingAssistantResponses.delete(this.pendingKey(turnId, messageId, agentId));
      }),
    );
    this.cleanups.push(
      this.bus.on(SessionSubjects.turn.completed, (ctx) => {
        const { sessionId, turnId } = ctx.payload;
        for (const [key, pending] of this.pendingAssistantResponses) {
          if (pending.sessionId === sessionId && pending.turnId === turnId) {
            this.pendingAssistantResponses.delete(key);
          }
        }
      }),
    );
  }

  /**
   * Accumulate blocks from agent events for storage on complete.
   */
  private registerBlockAccumulationHandlers(): void {
    // Accumulate text blocks from agent.message
    this.cleanups.push(
      this.bus.on(AgentSubjects.message, (ctx) => {
        const pending = this.pendingForProviderEvent(ctx.payload);
        if (pending) {
          pending.blocks.push({ type: 'text', content: ctx.payload.content });
        }
      }),
    );

    // Accumulate reasoning blocks
    this.cleanups.push(
      this.bus.on(AgentSubjects.reasoning, (ctx) => {
        const pending = this.pendingForProviderEvent(ctx.payload);
        if (pending) {
          pending.blocks.push({ type: 'reasoning', content: ctx.payload.content });
        }
      }),
    );

    // Accumulate tool_call blocks
    this.cleanups.push(
      this.bus.on(AgentSubjects.tool.use, (ctx) => {
        const pending = this.pendingForProviderEvent(ctx.payload);
        if (pending) {
          pending.blocks.push({
            type: 'tool_call',
            toolCallId: ctx.payload.toolCallId,
            name: ctx.payload.toolName,
            args: (ctx.payload.args ?? {}) as Record<string, unknown>,
          });
        }
      }),
    );

    // Accumulate tool_output blocks
    this.cleanups.push(
      this.bus.on(AgentSubjects.tool.completed, (ctx) => {
        const pending = this.pendingForProviderEvent(ctx.payload);
        if (pending) {
          const result = ctx.payload.result;
          const output = typeof result === 'string' ? result : JSON.stringify(result);
          pending.blocks.push({
            type: 'tool_output',
            toolCallId: ctx.payload.toolCallId,
            output,
            isError: ctx.payload.success === false,
          });
        }
      }),
    );

    // On agent.complete, store accumulated blocks as assistant message.
    // Structured-output completions carry the post-validation message as the
    // authoritative assistant text; provisional validation/retry blocks must
    // not be persisted with the final turn.
    // Error outcomes carry an `error` string for partial-block storage.
    this.cleanups.push(
      this.bus.on(AgentSubjects.complete, async (ctx) => {
        // Imported storage is complete; discard its exact delivery before ignoring duplicate persistence.
        if ((ctx.payload as Record<string, unknown>)['_import']) {
          const { turnId, messageId, agentId } = ctx.payload;
          if (turnId) this.pendingAssistantResponses.delete(this.pendingKey(turnId, messageId, agentId));
          return;
        }
        const { agentId, adapterSessionId, outcome, error, message, structuredOutputValidation, turnId, messageId } =
          ctx.payload;
        if (!turnId) {
          return;
        }
        const key = this.pendingKey(turnId, messageId, agentId);
        const pending = this.pendingAssistantResponses.get(key);
        if (!pending) return;

        // Atomically transfer this turn's response out of live agent state.
        // A subsequent turn may now install a fresh accumulator while the old
        // snapshot persists, without old cleanup being able to erase it.
        this.pendingAssistantResponses.delete(key);
        try {
          await this.storeAssistantMessage(
            pending,
            outcome === 'error' ? undefined : adapterSessionId,
            outcome === 'error' ? error : undefined,
            structuredOutputValidation !== undefined ? { content: message } : undefined,
          );
        } finally {
          await this.bus.emit(SessionSubjects.turn.assistantPersistenceSettled, {
            sessionId: pending.sessionId,
            turnId: pending.turnId,
            agentId,
            messageId: pending.messageId,
          });
        }
      }),
    );
  }

  /**
   * Store accumulated blocks as an assistant message.
   * @param response - Detached turn-scoped response to persist
   * @param adapterSessionId - Optional adapter session ID
   * @param error - Optional error message if agent failed
   * @param messageOverride - Optional validated terminal message to store instead of accumulated provider blocks
   */
  private async storeAssistantMessage(
    response: PendingAssistantResponse & { agentId: string },
    adapterSessionId?: string,
    error?: string,
    messageOverride?: AssistantMessageOverride,
  ): Promise<void> {
    const blocks: SessionMessageBlock[] =
      messageOverride !== undefined
        ? messageOverride.content !== undefined
          ? [{ type: 'text', content: messageOverride.content }]
          : []
        : response.blocks;
    if (blocks.length === 0 && !error) {
      return;
    }

    // Extract text content for FTS
    const contentText = blocks
      .filter((b): b is SessionMessageBlock & { type: 'text' } => b.type === 'text')
      .map((b) => b.content)
      .join('\n');

    const messageId = crypto.randomUUID();

    try {
      // Store assistant message — skip silently if no storage handler is registered
      const appendResult = await this.bus.requestOptional(MessageStorageSubjects.append, {
        message: {
          messageId,
          turnId: response.turnId,
          sessionId: response.sessionId,
          role: 'assistant',
          contentText: contentText || (error ? `[Error: ${error}]` : ''),
          blocks,
          agentId: response.agentId,
          adapterSessionId,
          timestamp: Date.now(),
        },
      });
      if (!appendResult.handled) {
        return;
      }

      // Update routing status to completed — also optional; skip if no routing handler registered
      const getResult = await this.bus.requestOptional(MessageStorageSubjects.getByTurn, {
        turnId: response.turnId,
      });
      if (getResult.handled) {
        const userMessage = getResult.data.messages.find(
          (m) => m.role === 'user' && m.messageId === response.messageId,
        );
        if (userMessage) {
          // Fire-and-forget: routing records are non-critical audit metadata.
          // The result is intentionally not checked — a missing routing handler
          // (e.g. in ephemeral mode) is silently ignored.
          await this.bus.requestOptional(MessageRoutingSubjects.record, {
            messageId: userMessage.messageId,
            agentId: response.agentId,
            status: 'completed',
            timestamp: Date.now(),
            error,
          });
        }
      }
    } catch (err) {
      console.error('[SessionBridge] Failed to store assistant message:', err);
    }
  }

  /**
   * Stop the bridge and clean up subscriptions.
   */
  public destroy(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups.length = 0;
    this.agentToSession.clear();
    this.pendingAssistantResponses.clear();
  }

  /**
   * Find a response only when the provider event carries explicit delivery correlation.
   * @param payload - Explicit provider event correlation.
   * @returns Matching pending response, when every identity component is present.
   */
  private pendingForProviderEvent(payload: {
    agentId: string;
    turnId?: string;
    messageId?: string;
  }): PendingAssistantResponse | undefined {
    if (!payload.turnId || !payload.messageId) return undefined;
    return this.pendingAssistantResponses.get(this.pendingKey(payload.turnId, payload.messageId, payload.agentId));
  }

  /**
   * Build an unambiguous in-memory identity for one assistant response.
   * @param turnId - Managed turn identity.
   * @param messageId - User-message identity.
   * @param agentId - Agent identity.
   * @returns Collision-free composite key.
   */
  private pendingKey(turnId: string, messageId: string, agentId: string): string {
    return JSON.stringify([turnId, messageId, agentId]);
  }
}
