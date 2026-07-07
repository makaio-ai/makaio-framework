/**
 * Codex App-Server Agent - Event routing layer.
 *
 * Wires connector events to global agent.* subjects.
 * Auto-enriches payloads with AgentContext via emitGlobal().
 *
 * Responsibilities:
 * 1. Wire connector's scoped bus events to global agent.* subjects
 * 2. Auto-enrich payloads with AgentContext
 * 3. Track usage metrics
 * 4. Route tool approval to global bus
 * 5. Emit normalized client.session.* observed-semantics events
 * 6. Emit client.runtime.observe (best-effort) when a thread starts with a confirmed adapter session ID
 *
 * Event Flow:
 * - CodexAppServerConnector emits to adapter:codex-app-server:* subjects
 * - CodexAppServerAgent routes to semantic subjects via wireConnectorEvents()
 * - CodexAppServerAgent subscribes to semantic subjects and emits to global bus (agent.*)
 * - Downstream consumers subscribe to normalized agent.* subjects
 * @packageDocumentation
 */

import { AIAgent, type NormalizedCallUsage } from '@makaio/ai-adapters-core';
import { CodexAppServerConnector } from './connector.js';
import { CodexAppServerSubjects, type CodexAppServerBus } from './namespaces/index.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { AgentSubjects, ClientSubjects, type SessionMessageBlock } from '@makaio/contracts';
import { buildClientSessionBase, emitBestEffort } from '@makaio/subsystem-client';

/**
 * Maximum number of characters retained in `toolOutputCache` per tool call.
 *
 * Streaming consumers already receive every chunk via
 * `AgentSubjects.tool.output`, so the cache is only needed to populate the
 * final `tool_output` content block in `emitToolStepFinished`. Capping it
 * prevents unbounded memory growth for long-running commands (builds, test
 * suites, etc.) whose output can otherwise reach tens of megabytes.
 */
const MAX_TOOL_OUTPUT_CACHE_CHARS = 256 * 1024;

/**
 * Keep the newest tool output in the bounded per-tool cache.
 *
 * Streaming consumers receive every chunk via `AgentSubjects.tool.output`; the
 * cache is only the final content-block snapshot, so retaining the tail keeps
 * the diagnostic context where command failures usually appear.
 * @param output - Full accumulated output candidate
 * @returns Output capped to the configured character count
 */
function capToolOutputCache(output: string): string {
  return output.length > MAX_TOOL_OUTPUT_CACHE_CHARS ? output.slice(-MAX_TOOL_OUTPUT_CACHE_CHARS) : output;
}

/**
 * Codex App-Server Agent - Middle layer between AIAdapter and CodexAppServerConnector.
 *
 * Responsibilities:
 * 1. Wire connector's scoped bus events to global agent.* subjects
 * 2. Auto-enrich payloads with AgentContext via emitGlobal()
 * 3. Emit normalized client.session.* observed-semantics events (best-effort)
 * 4. Emit client.runtime.observe (best-effort) when a thread starts with a confirmed adapter session ID
 *
 * Event Flow:
 * - CodexAppServerConnector emits to adapter:codex-app-server:* subjects
 * - CodexAppServerAgent routes to semantic subjects via wireConnectorEvents()
 * - CodexAppServerAgent subscribes to semantic subjects and emits to global bus (agent.*)
 * - Downstream consumers subscribe to normalized agent.* subjects
 */
export class CodexAppServerAgent extends AIAgent<CodexAppServerBus, CodexAppServerConnector> {
  /** Cache of tool call arguments indexed by callId for content blocks */
  private toolCallCache = new Map<
    string,
    { command: string[]; cwd: string; toolCallId: string; name: string; args: Record<string, unknown> }
  >();

  /** Accumulated tool output indexed by callId during streaming */
  private toolOutputCache = new Map<string, string>();

  /** Track toolCallId to blockIndex for correlation between step.started and step.finished */
  private toolBlockIndexMap = new Map<string, number>();

  /**
   * Guard: client.session.* global bus observations are wired once per agent
   * lifetime (not per connector swap). Connector-level wiring uses
   * addConnectorWiringCleanup(); these stable global subscriptions use
   * addBusHandlerCleanup() and must not accumulate across swaps.
   */
  private clientSessionObservationsWired = false;

  /**
   * Codex owns the conversation thread natively — resume reuses the existing thread
   * via `thread/resume` rather than replaying history into a fresh one.
   * @returns true — Codex supports native session resume
   */
  protected override supportsNativeResume(): boolean {
    return true;
  }

  /**
   * Codex supports provider-native session branching via `thread/fork`.
   * When the orchestrator supplies a `NativeForkDirective`, the connector
   * sends `thread/fork` instead of `thread/start`, avoiding history replay.
   * @returns true — Codex supports native session fork
   */
  protected override supportsNativeFork(): boolean {
    return true;
  }

  protected wireEvents(connector: CodexAppServerConnector): void {
    // Wire connector events to global agent.* subjects
    this.wireConnectorEvents(connector);

    // Wire tool approval RPC: forward approval requests to global AgentSubjects.toolApprove
    this.wireToolApprovalRpc(connector);

    // Wire stable global bus observations for client.session.* semantics (once per agent)
    this.wireClientSessionTurnObservations();
  }

  /**
   * Wire connector's bus events to global agent.* subjects.
   *
   * Maps CodexAppServerSubjects.* to AgentSubjects.*
   *
   * Note: Turn lifecycle events (turn.started, turn.completed) are NOT wired here
   * because the base AIAgent's message-lifecycle-tracker already handles emitting
   * these global events when messages are acknowledged and turns complete.
   * @param connector - The CodexAppServerConnector to wire events from
   */
  private wireConnectorEvents(connector: CodexAppServerConnector): void {
    this.wireThreadLifecycleEvents(connector);
    this.wireMessageEvents(connector);
    this.wireToolEvents(connector);
    this.wireUsageTracking(connector);
  }

  /**
   * Build the shared base payload for all `client.session.*` observed-semantics
   * events by forwarding this agent's current identity fields to the shared
   * {@link buildClientSessionBase} helper.
   *
   * Captures the adapter session ID best-effort: if the connector has not yet
   * confirmed a session ID (e.g., very early in initialization), the field is
   * omitted rather than blocking emission.
   * @returns Base payload with clientId, source, observedAt, and optional session IDs
   */
  private getClientSessionBase() {
    return buildClientSessionBase({
      clientId: this.config.clientId ?? 'codex',
      sessionId: this.sessionId,
      adapterSessionId: this.connector?.adapterSessionId,
    });
  }

  /**
   * Wire stable global bus subscriptions for client.session.turn.* events.
   *
   * Uses addBusHandlerCleanup() so these subscriptions survive connector swaps.
   * Guarded by clientSessionObservationsWired so they are registered exactly once
   * per agent lifetime regardless of how many connector swaps occur.
   *
   * Subscribes to:
   * - AgentSubjects.turn.started → client.session.turn.started
   * - AgentSubjects.turn.completed → client.session.turn.completed
   * - AgentSubjects.user_message.sent → client.session.userPrompt.submitted
   */
  private wireClientSessionTurnObservations(): void {
    if (this.clientSessionObservationsWired) {
      return;
    }
    this.clientSessionObservationsWired = true;

    const filteredBus = this.globalBus.withFilter({ agentId: this.agentId });

    this.addBusHandlerCleanup(
      filteredBus.on(AgentSubjects.turn.started, () => {
        emitBestEffort(async () => {
          await this.globalBus.emit(ClientSubjects.session.turn.started, this.getClientSessionBase());
        });
      }),
    );

    this.addBusHandlerCleanup(
      filteredBus.on(AgentSubjects.turn.completed, () => {
        emitBestEffort(async () => {
          await this.globalBus.emit(ClientSubjects.session.turn.completed, this.getClientSessionBase());
        });
      }),
    );

    this.addBusHandlerCleanup(
      filteredBus.on(AgentSubjects.user_message.sent, (ctx) => {
        const prompt = ctx.payload.content.message;
        emitBestEffort(async () => {
          await this.globalBus.emit(ClientSubjects.session.userPrompt.submitted, {
            ...this.getClientSessionBase(),
            ...(prompt !== undefined && { prompt }),
          });
        });
      }),
    );
  }

  /**
   * Wire thread lifecycle events.
   * @param connector - The CodexAppServerConnector to wire events from
   */
  private wireThreadLifecycleEvents(connector: CodexAppServerConnector): void {
    // thread.started -> agent.started
    this.subscribeConnector(connector, CodexAppServerSubjects.thread_started, async () => {
      // Reset cache for new turn
      this.toolCallCache.clear();
      this.toolOutputCache.clear();
      this.toolBlockIndexMap.clear();
      await this.emitStart();
      emitBestEffort(async () => {
        await this.globalBus.emit(ClientSubjects.session.started, this.getClientSessionBase());
      });

      // Best-effort runtime observation — the adapter session ID is strong evidence
      // that the Codex runtime is running. Fire-and-forget so the thread lifecycle
      // is never blocked if the runtime-observe service is absent.
      const adapterSessionId = this.connector?.adapterSessionId;
      if (adapterSessionId) {
        void this.globalBus
          .requestOptional(ClientSubjects.runtime.observe, {
            clientId: this.config.clientId ?? 'codex',
            source: { layer: 'adapter', producer: 'codex-app-server' },
            observedAt: Date.now(),
            adapterSessionId,
            sessionId: this.sessionId,
          })
          .catch(() => {
            /* best-effort: ignore errors so thread lifecycle is never blocked */
          });
      }
    });

    // thread.completed -> agent.complete (session finished)
    this.subscribeConnector(connector, CodexAppServerSubjects.thread_completed, async () => {
      const messageId = crypto.randomUUID();
      return this.emitCompletion({ messageId });
    });
  }

  /**
   * Wire assistant message events.
   *
   * Note: Turn lifecycle events (agent.turn.started, agent.turn.completed) are emitted by
   * MessageLifecycleTracker in ai-adapters-core based on message handle states,
   * not by adapter-specific events.
   * @param connector - The CodexAppServerConnector to wire events from
   */
  private wireMessageEvents(connector: CodexAppServerConnector): void {
    this.subscribeConnector(connector, CodexAppServerSubjects.agent_message_delta, async (ctx) => {
      await this.emitGlobal(AgentSubjects.message_delta, { text: ctx.payload.delta });
    });
    this.subscribeConnector(connector, CodexAppServerSubjects.agent_message, async (ctx) => {
      await this.emitGlobal(AgentSubjects.message, { content: ctx.payload.message });
      await this.emitStepStarted('text');
      await this.emitStepFinished('text', { type: 'text', content: ctx.payload.message });
    });
    this.subscribeConnector(connector, CodexAppServerSubjects.reasoning_delta, async (ctx) => {
      await this.emitGlobal(AgentSubjects.reasoning_delta, { content: ctx.payload.delta });
    });
    this.subscribeConnector(connector, CodexAppServerSubjects.reasoning, async (ctx) => {
      await this.emitGlobal(AgentSubjects.reasoning, { content: ctx.payload.reasoning });
      await this.emitStepStarted('reasoning');
      await this.emitStepFinished('reasoning', { type: 'reasoning', content: ctx.payload.reasoning });
    });
  }

  /**
   * Wire tool-related events.
   * @param connector - The CodexAppServerConnector to wire events from
   */
  private wireToolEvents(connector: CodexAppServerConnector): void {
    this.wireCommandExecutionEvents(connector);
    this.wireFileChangeEvents(connector);
    this.wireDynamicToolCallEvents(connector);
  }

  /**
   * Wire command execution events (bash tool).
   * @param connector - The CodexAppServerConnector to wire events from
   */
  private wireCommandExecutionEvents(connector: CodexAppServerConnector): void {
    // Tool approval request -> cache tool args for step.started content block
    this.subscribeConnector(connector, CodexAppServerSubjects.exec_approval_request, async (ctx) => {
      const payload = ctx.payload;

      // Cache tool call info for later step.started emission
      this.toolCallCache.set(payload.callId, {
        command: payload.command,
        cwd: payload.cwd,
        toolCallId: payload.callId,
        name: 'bash',
        args: {
          command: payload.command,
          cwd: payload.cwd,
        },
      });

      await this.emitGlobal(AgentSubjects.tool.use, {
        toolName: 'bash',
        args: { command: payload.command, cwd: payload.cwd },
        toolCallId: payload.callId,
      });
    });

    // Tool execution started (command) -> emit step.started with tool_call content
    this.subscribeConnector(connector, CodexAppServerSubjects.exec_command_begin, async (ctx) => {
      await this.handleExecCommandBegin(ctx.payload);
    });

    // Tool output delta -> accumulate output for step.finished
    this.subscribeConnector(connector, CodexAppServerSubjects.exec_command_output_delta, async (ctx) => {
      const payload = ctx.payload;
      const current = this.toolOutputCache.get(payload.callId) ?? '';
      const appended = current + payload.chunk;
      this.toolOutputCache.set(payload.callId, capToolOutputCache(appended));
      await this.emitGlobal(AgentSubjects.tool.output, {
        output: payload.chunk,
        toolCallId: payload.callId,
      });
    });

    // Tool execution completed -> emit step.finished with tool_output content
    this.subscribeConnector(connector, CodexAppServerSubjects.exec_command_end, async (ctx) => {
      const payload = ctx.payload;
      await this.emitGlobal(AgentSubjects.tool.completed, {
        toolName: 'bash',
        args: this.toolCallCache.get(payload.callId)?.args,
        result: { exitCode: payload.exitCode },
        success: payload.exitCode === 0,
        toolCallId: payload.callId,
      });
      await this.emitToolStepFinished(
        payload.callId,
        this.toolOutputCache.get(payload.callId) ?? `Command completed with exit code ${payload.exitCode}`,
        payload.exitCode !== 0,
      );
      emitBestEffort(async () => {
        await this.globalBus.emit(ClientSubjects.session.tool.post, {
          ...this.getClientSessionBase(),
          toolName: 'bash',
          toolCallId: payload.callId,
          success: payload.exitCode === 0,
        });
      });
    });
  }

  /**
   * Handle exec_command_begin: build step.started content, emit step.started,
   * tool.started, and client.session.tool.pre.
   * @param payload - The exec_command_begin event payload
   */
  private async handleExecCommandBegin(payload: { callId: string; command: string[]; cwd: string }): Promise<void> {
    const cachedTool = this.toolCallCache.get(payload.callId);
    const toolCallContent: SessionMessageBlock = cachedTool
      ? {
          type: 'tool_call',
          toolCallId: cachedTool.toolCallId,
          name: cachedTool.name,
          args: cachedTool.args,
        }
      : {
          type: 'tool_call',
          toolCallId: payload.callId,
          name: 'bash',
          args: { command: payload.command, cwd: payload.cwd },
        };

    const blockIndex = this.getBlockIndex();
    this.toolBlockIndexMap.set(payload.callId, blockIndex);
    await this.emitStepStarted(
      'tool_use',
      { type: 'tool_use', toolName: 'bash', toolCallId: payload.callId },
      toolCallContent,
    );
    this.incrementBlockIndex();

    await this.emitGlobal(AgentSubjects.tool.started, {
      toolName: 'bash',
      toolCallId: payload.callId,
    });
    emitBestEffort(async () => {
      await this.globalBus.emit(ClientSubjects.session.tool.pre, {
        ...this.getClientSessionBase(),
        toolName: 'bash',
        toolCallId: payload.callId,
      });
    });
  }

  /**
   * Wire file change events (patch tool).
   * @param connector - The CodexAppServerConnector to wire events from
   */
  private wireFileChangeEvents(connector: CodexAppServerConnector): void {
    this.subscribeConnector(connector, CodexAppServerSubjects.file_change_approval_request, async (ctx) => {
      const { itemId, reason, grantRoot } = ctx.payload;
      const args = { reason, grantRoot };
      this.toolCallCache.set(itemId, { command: [], cwd: '', toolCallId: itemId, name: 'patch', args });
      await this.emitGlobal(AgentSubjects.tool.use, { toolName: 'patch', args, toolCallId: itemId });
      // Reserve blockIndex for this tool call
      const blockIndex = this.getBlockIndex();
      this.toolBlockIndexMap.set(itemId, blockIndex);
      await this.emitStepStarted(
        'tool_use',
        { type: 'tool_use', toolName: 'patch', toolCallId: itemId },
        { type: 'tool_call', toolCallId: itemId, name: 'patch', args },
      );
      this.incrementBlockIndex(); // Reserve this slot
      emitBestEffort(async () => {
        await this.globalBus.emit(ClientSubjects.session.tool.pre, {
          ...this.getClientSessionBase(),
          toolName: 'patch',
          toolCallId: itemId,
        });
      });
    });
    this.subscribeConnector(connector, CodexAppServerSubjects.file_change_output_delta, async (ctx) => {
      const { itemId, delta } = ctx.payload;
      const current = this.toolOutputCache.get(itemId) ?? '';
      const appended = current + delta;
      this.toolOutputCache.set(itemId, capToolOutputCache(appended));
      await this.emitGlobal(AgentSubjects.tool.output, { output: delta, toolCallId: itemId });
    });
    this.subscribeConnector(connector, CodexAppServerSubjects.item_completed, async (ctx) => {
      const cached = this.toolCallCache.get(ctx.payload.itemId);
      if (cached?.name === 'patch') {
        const output = this.toolOutputCache.get(ctx.payload.itemId) ?? 'File change applied';
        await this.emitGlobal(AgentSubjects.tool.completed, {
          toolName: 'patch',
          args: cached.args,
          result: { output },
          success: true,
          toolCallId: ctx.payload.itemId,
        });
        await this.emitToolStepFinished(ctx.payload.itemId, output, false);
        emitBestEffort(async () => {
          await this.globalBus.emit(ClientSubjects.session.tool.post, {
            ...this.getClientSessionBase(),
            toolName: 'patch',
            toolCallId: ctx.payload.itemId,
            success: true,
          });
        });
      }
    });
  }

  /**
   * Wire dynamic tool call events (experimental API).
   *
   * Handles registry tools declared in `dynamicTools` at `thread/start`.
   * The execution happens in the `item/tool/call` server request handler; these
   * events carry the cached result into the agent's step lifecycle.
   * @param connector - The CodexAppServerConnector to wire events from
   */
  private wireDynamicToolCallEvents(connector: CodexAppServerConnector): void {
    // Tool execution started — populate cache and emit step.started
    this.subscribeConnector(connector, CodexAppServerSubjects.dynamic_tool_call_begin, async (ctx) => {
      const { itemId, name, args } = ctx.payload;
      this.toolCallCache.set(itemId, { command: [], cwd: '', toolCallId: itemId, name, args });
      const blockIndex = this.getBlockIndex();
      this.toolBlockIndexMap.set(itemId, blockIndex);
      await this.emitGlobal(AgentSubjects.tool.use, { toolName: name, args, toolCallId: itemId });
      await this.emitGlobal(AgentSubjects.tool.started, { toolName: name, toolCallId: itemId });
      await this.emitStepStarted(
        'tool_use',
        { type: 'tool_use', toolName: name, toolCallId: itemId },
        { type: 'tool_call', toolCallId: itemId, name, args },
      );
      this.incrementBlockIndex();
      emitBestEffort(async () => {
        await this.globalBus.emit(ClientSubjects.session.tool.pre, {
          ...this.getClientSessionBase(),
          toolName: name,
          toolCallId: itemId,
        });
      });
    });

    // Tool execution completed — emit output, step.finished and clean up
    this.subscribeConnector(connector, CodexAppServerSubjects.dynamic_tool_call_end, async (ctx) => {
      const { itemId, name, output, success } = ctx.payload;
      const cached = this.toolCallCache.get(itemId);
      await this.emitGlobal(AgentSubjects.tool.output, { output, toolCallId: itemId });
      await this.emitGlobal(AgentSubjects.tool.completed, {
        toolName: name,
        args: cached?.args,
        result: { output },
        success,
        toolCallId: itemId,
      });
      await this.emitToolStepFinished(itemId, output, !success);
      emitBestEffort(async () => {
        await this.globalBus.emit(ClientSubjects.session.tool.post, {
          ...this.getClientSessionBase(),
          toolName: name,
          toolCallId: itemId,
          success,
        });
      });
    });
  }

  /**
   * Wire usage tracking events.
   * The base AIAgent.trackUsage() handles dual emission to both
   * AgentSubjects.usage and adapter session usage subjects.
   * @param connector - The CodexAppServerConnector to wire events from
   */
  private wireUsageTracking(connector: CodexAppServerConnector): void {
    this.subscribeConnector(connector, CodexAppServerSubjects.token_usage, async (ctx) => {
      const payload = ctx.payload;

      const normalized: NormalizedCallUsage = {
        provider: 'openai',
        inputTokens: payload.promptTokens,
        inputCachedTokens: payload.inputCachedTokens,
        outputTokens: payload.completionTokens,
        reasoningTokens: payload.reasoningTokens,
        totalTokens: payload.totalTokens,
        costUnits: payload.totalTokens,
        costUnitType: 'tokens',
        contextWindow: payload.modelContextWindow,
      };
      await this.trackUsage(normalized);

      // Emit context window update if we have the context window size
      if (payload.modelContextWindow) {
        await this.emitContextWindowUpdate({
          currentTokens: payload.totalTokens,
          maxTokens: payload.modelContextWindow,
          cachedTokens: payload.inputCachedTokens,
        });
      }
    });
  }

  /**
   * Wire tool approval RPC from connector's scoped bus to global AgentSubjects.toolApprove.
   *
   * Uses centralized tool-handling helper for consistent approval flow.
   * Note: adapterSessionId may be undefined at wire time — the lazy callback resolves it
   * at request time via connector.getAdapterSessionId() to avoid the race condition.
   * sessionId is always set for agents running within a session; asserted here as the
   * Zod schema on AgentSubjects.toolApprove enforces it at runtime.
   * @param connector - The CodexAppServerConnector to wire RPC from
   */
  private wireToolApprovalRpc(connector: CodexAppServerConnector): void {
    this.addConnectorWiringCleanup(
      registerToolApprovalHandler(
        connector,
        async () => {
          if (this.sessionId == null) {
            throw new Error('Agent sessionId is required for tool approval');
          }
          return {
            adapterId: this.adapterId,
            adapterName: this.adapterName,
            agentId: this.agentId,
            adapterSessionId: await this.getAdapterSessionId(),
            sessionId: this.sessionId,
          };
        },
        this.globalBus,
      ),
    );
  }

  /**
   * Emit tool step.finished and cleanup cached data.
   * Shared helper for bash and patch tool completion.
   * @param toolCallId - Tool call identifier
   * @param output - Tool output content
   * @param isError - Whether the tool execution failed
   */
  private async emitToolStepFinished(toolCallId: string, output: string, isError: boolean): Promise<void> {
    // Use stored blockIndex from step.started for correlation
    const blockIndex = this.toolBlockIndexMap.get(toolCallId);
    if (blockIndex === undefined) {
      console.warn(`[CodexAdapter] toolCallId ${toolCallId} not found in toolBlockIndexMap - possible state mismatch`);
    }
    const resolvedBlockIndex = blockIndex ?? -1;
    this.toolBlockIndexMap.delete(toolCallId);
    const content: SessionMessageBlock = { type: 'tool_output', toolCallId, output, isError };
    await this.emitGlobal(AgentSubjects.step.finished, {
      stepType: 'tool_use',
      blockIndex: resolvedBlockIndex,
      content,
    });
    this.toolCallCache.delete(toolCallId);
    this.toolOutputCache.delete(toolCallId);
  }
}
