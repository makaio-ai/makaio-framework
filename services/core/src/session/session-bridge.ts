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
/** Agent context for turn tracking */
interface AgentContext {
  sessionId: string;
  turnId?: string;
  adapterSessionId?: string;
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
  /** Extended mapping: agentId -\> \{ sessionId, turnId, adapterSessionId \} */
  private readonly agentContext = new Map<string, AgentContext>();
  /** Block accumulator: agentId -\> blocks (one agent = one response per turn) */
  private readonly agentBlocks = new Map<string, SessionMessageBlock[]>();
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
            this.agentContext.delete(agentId);
            this.agentBlocks.delete(agentId);
          }
        }
      }),
    );
  }

  /**
   * Track turn assignments for agents.
   */
  private registerTurnTrackingHandlers(): void {
    // Track turn assignment from turn.started
    this.cleanups.push(
      this.bus.on(SessionSubjects.turn.started, (ctx) => {
        const { sessionId, turnId, agentIds } = ctx.payload;
        for (const agentId of agentIds) {
          const existing = this.agentContext.get(agentId);
          this.agentContext.set(agentId, {
            ...existing,
            sessionId,
            turnId,
          });
          // Initialize block accumulator for this agent
          this.agentBlocks.set(agentId, []);
        }
      }),
    );

    // Associate acknowledged fallback deliveries to the existing turn context.
    this.cleanups.push(
      this.bus.on(SessionSubjects.user_message.acknowledged, (ctx) => {
        const existing = this.agentContext.get(ctx.payload.agentId);
        this.agentContext.set(ctx.payload.agentId, {
          ...existing,
          sessionId: ctx.payload.sessionId,
          turnId: ctx.payload.turnId,
        });
        if (!this.agentBlocks.has(ctx.payload.agentId)) {
          this.agentBlocks.set(ctx.payload.agentId, []);
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
        const blocks = this.agentBlocks.get(ctx.payload.agentId);
        if (blocks) {
          blocks.push({ type: 'text', content: ctx.payload.content });
        }
      }),
    );

    // Accumulate reasoning blocks
    this.cleanups.push(
      this.bus.on(AgentSubjects.reasoning, (ctx) => {
        const blocks = this.agentBlocks.get(ctx.payload.agentId);
        if (blocks) {
          blocks.push({ type: 'reasoning', content: ctx.payload.content });
        }
      }),
    );

    // Accumulate tool_call blocks
    this.cleanups.push(
      this.bus.on(AgentSubjects.tool.use, (ctx) => {
        const blocks = this.agentBlocks.get(ctx.payload.agentId);
        if (blocks) {
          blocks.push({
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
        const blocks = this.agentBlocks.get(ctx.payload.agentId);
        if (blocks) {
          const result = ctx.payload.result;
          const output = typeof result === 'string' ? result : JSON.stringify(result);
          blocks.push({
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
        // Guard: events from the import pipeline carry _import metadata.
        // Storage is already handled by the importer — skip here to avoid duplicates.
        if ((ctx.payload as Record<string, unknown>)['_import']) {
          this.agentBlocks.delete(ctx.payload.agentId);
          return;
        }
        const { agentId, adapterSessionId, outcome, error, message, structuredOutputValidation } = ctx.payload;
        await this.storeAssistantMessage(
          agentId,
          outcome === 'error' ? undefined : adapterSessionId,
          outcome === 'error' ? error : undefined,
          structuredOutputValidation !== undefined ? { content: message } : undefined,
        );
      }),
    );
  }

  /**
   * Store accumulated blocks as an assistant message.
   * @param agentId - ID of the agent that produced the message
   * @param adapterSessionId - Optional adapter session ID
   * @param error - Optional error message if agent failed
   * @param messageOverride - Optional validated terminal message to store instead of accumulated provider blocks
   */
  private async storeAssistantMessage(
    agentId: string,
    adapterSessionId?: string,
    error?: string,
    messageOverride?: AssistantMessageOverride,
  ): Promise<void> {
    const context = this.agentContext.get(agentId);
    if (!context?.turnId) return;

    const blocks: SessionMessageBlock[] =
      messageOverride !== undefined
        ? messageOverride.content !== undefined
          ? [{ type: 'text', content: messageOverride.content }]
          : []
        : (this.agentBlocks.get(agentId) ?? []);
    if (blocks.length === 0 && !error) {
      this.agentBlocks.delete(agentId);
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
          turnId: context.turnId,
          sessionId: context.sessionId,
          role: 'assistant',
          contentText: contentText || (error ? `[Error: ${error}]` : ''),
          blocks,
          agentId,
          adapterSessionId,
          timestamp: Date.now(),
        },
      });
      if (!appendResult.handled) {
        this.agentBlocks.delete(agentId);
        return;
      }

      // Update routing status to completed — also optional; skip if no routing handler registered
      const getResult = await this.bus.requestOptional(MessageStorageSubjects.getByTurn, {
        turnId: context.turnId,
      });
      if (getResult.handled) {
        const userMessage = getResult.data.messages.find((m) => m.role === 'user');
        if (userMessage) {
          // Fire-and-forget: routing records are non-critical audit metadata.
          // The result is intentionally not checked — a missing routing handler
          // (e.g. in ephemeral mode) is silently ignored.
          await this.bus.requestOptional(MessageRoutingSubjects.record, {
            messageId: userMessage.messageId,
            agentId,
            status: 'completed',
            timestamp: Date.now(),
            error,
          });
        }
      }
    } catch (err) {
      console.error('[SessionBridge] Failed to store assistant message:', err);
    }

    // Clean up
    this.agentBlocks.delete(agentId);
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
    this.agentContext.clear();
    this.agentBlocks.clear();
  }
}
