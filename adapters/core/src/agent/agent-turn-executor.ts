import { runPreUserMessageHooks, runPostUserMessageHooks } from '@makaio/hooks';
import {
  SessionContextSchema,
  type MessageInput,
  type ResponseSchemaDescriptor,
  type RequestCorrelationContext,
  type SessionContext,
  type StartMode,
} from '@makaio/contracts';
import { normalizeMessageInput, type NormalizedMessageInput } from '../utils/index.js';
import type { MessageHandle } from '../message-handle/index.js';
import type { AIAgentConnector } from '../connector/index.js';
import type { AgentStartResult, ConnectorStartOptions, SendMessageRequestPayload, StartAgentOptions } from './types.js';
import type { IMakaioBus } from '@makaio/bus-core';
import { buildStructuredOutputTurnContext } from './structured-output-turn-context.js';

/**
 * Runtime dependencies for AgentTurnExecutor.
 */
export type AgentMessageHandleCallback = (messageHandle: MessageHandle, turnId: string | undefined) => Promise<void>;

export interface AgentTurnExecutorConfig {
  /** Stable agent identifier. */
  agentId: string;
  /** Stable adapter identifier. */
  adapterId: string;
  /** Optional Makaio session identifier. */
  sessionId?: string;
  /** Capability tags reported by the adapter (e.g. `'structuredOutput'`). */
  adapterCapabilities?: string[];
  /** Global bus instance for hooks. */
  globalBus: IMakaioBus;
  /** Current connector reference resolver. */
  getConnector: () => AIAgentConnector;
  /** Native resume decision function. */
  shouldUseNativeResume: ShouldUseNativeResumeFn;
  /**
   * Whether the agent config carries a concrete resume target
   * (`resumeAdapterSessionId`).
   *
   * Used by {@link AgentTurnExecutor.deriveStartMode} to distinguish
   * native-attach starts (resume target, no sessionContext) from
   * truly sessionless/ephemeral starts (no resume target, no context).
   */
  hasResumeTarget: () => boolean;
  /**
   * Set the start mode on the owning agent before connector dispatch.
   *
   * The turn executor computes the mode from session context signals and
   * calls this so `emitStart()` can include it in the `agent.started`
   * payload when the connector fires its lifecycle event.
   * @param mode - Derived start mode for this turn
   */
  setPendingStartMode: (mode: StartMode) => void;
  /** Completion/lifecycle tracker hook. */
  onMessageHandle: AgentMessageHandleCallback;
  /** Side-effect callback to mark agent status active before dispatch. */
  onBeforeDispatch?: () => void | Promise<void>;
  /** Serialize the complete pre-hook-to-send boundary with credential mutations. */
  runDispatch?: <T>(dispatch: () => Promise<T>) => Promise<T>;
  /** When true, PreUserMessage hooks are skipped. */
  ephemeral?: boolean;
}

/**
 * Function type for native resume decision.
 */
export type ShouldUseNativeResumeFn = (sessionContext?: StartAgentOptions['sessionContext']) => boolean;

interface PreUserMessageTurnResult {
  message: MessageInput | NormalizedMessageInput;
  sessionContext?: StartAgentOptions['sessionContext'];
}

interface PreUserMessageTurnInput extends PreUserMessageTurnResult {
  cwd: string;
  messageId?: string;
}

/**
 * Merge orchestrator correlation with runtime-owned identifiers.
 * Undefined runtime fields do not erase an explicitly supplied value.
 * @param context - Optional correlation supplied by session orchestration
 * @param runtime - Identifiers owned by the current runtime dispatch
 * @returns Merged correlation, or undefined when no identifier is available
 */
function buildRequestCorrelation(
  context: RequestCorrelationContext | undefined,
  runtime: RequestCorrelationContext,
): RequestCorrelationContext | undefined {
  const merged = { ...context };
  for (const [field, value] of Object.entries(runtime)) {
    if (value !== undefined) merged[field as keyof RequestCorrelationContext] = value;
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/**
 * Shared start/send-message execution pipeline for AIAgent.
 */
export class AgentTurnExecutor {
  private readonly agentId: string;
  private readonly adapterId: string;
  private readonly sessionId?: string;
  private readonly adapterCapabilities: string[];
  private readonly globalBus: IMakaioBus;
  private readonly getConnector: () => AIAgentConnector;
  private readonly shouldUseNativeResume: ShouldUseNativeResumeFn;
  private readonly hasResumeTarget: () => boolean;
  private readonly setPendingStartMode: (mode: StartMode) => void;
  private readonly onMessageHandle: AgentMessageHandleCallback;
  private readonly onBeforeDispatch?: () => void | Promise<void>;
  private readonly runDispatch: <T>(dispatch: () => Promise<T>) => Promise<T>;
  private readonly ephemeral: boolean;

  public constructor(config: AgentTurnExecutorConfig) {
    this.agentId = config.agentId;
    this.adapterId = config.adapterId;
    this.sessionId = config.sessionId;
    this.adapterCapabilities = config.adapterCapabilities ?? [];
    this.globalBus = config.globalBus;
    this.getConnector = config.getConnector;
    this.shouldUseNativeResume = config.shouldUseNativeResume;
    this.hasResumeTarget = config.hasResumeTarget;
    this.setPendingStartMode = config.setPendingStartMode;
    this.onMessageHandle = config.onMessageHandle;
    this.onBeforeDispatch = config.onBeforeDispatch;
    this.runDispatch = config.runDispatch ?? (async (dispatch) => dispatch());
    this.ephemeral = config.ephemeral ?? false;
  }

  /**
   * Derive the {@link StartMode} from session context, resume decision, and
   * resume-target presence.
   *
   * Decision table (evaluated top-to-bottom, first match wins):
   *
   * | sessionContext | nativeFork | hasResumeTarget | useNativeResume | isFirstTurn | Mode       |
   * |----------------|------------|-----------------|-----------------|-------------|------------|
   * | present        | yes        | —               | —               | —           | `fork`     |
   * | absent         | —          | yes             | —               | —           | `resume`   |
   * | absent         | —          | no              | —               | —           | `fresh`    |
   * | present        | no         | —               | true            | —           | `resume`   |
   * | present        | no         | —               | false           | true        | `fresh`    |
   * | present        | no         | —               | false           | false       | `rotation` |
   *
   * The `hasResumeTarget` rule distinguishes native-attach starts (concrete
   * provider session to reconnect to, but no orchestrator session context) from
   * truly sessionless/ephemeral starts. Without this signal, both cases
   * collapsed to `'fresh'` — causing SDK SessionStart hooks to run
   * initialization logic on a resumed conversation.
   *
   * `hasResumeTarget` fires only when sessionContext is absent. Once the
   * orchestrator supplies context (turn 2+), rules 4-6 take over and the
   * resume target on the config has no further effect on mode derivation.
   * @param sessionContext - Session context signals from the orchestrator
   * @param useNativeResume - Whether native resume was selected for this turn
   * @param hasResumeTarget - Whether a concrete resume target
   *   (`resumeAdapterSessionId`) exists on the agent config
   * @returns The derived start mode
   */
  public static deriveStartMode(
    sessionContext: SessionContext | undefined,
    useNativeResume: boolean,
    hasResumeTarget = false,
  ): StartMode {
    if (sessionContext?.nativeFork) return 'fork';
    if (!sessionContext) return hasResumeTarget ? 'resume' : 'fresh';
    if (useNativeResume) return 'resume';
    if (sessionContext.isFirstTurn) return 'fresh';
    return 'rotation';
  }

  /**
   * Derive the start mode for the given resolved session context, stash it
   * as the pending mode for the next lifecycle start emission, and return
   * the native-resume decision shared by the dispatch that follows.
   * @param sessionContext - Session context after pre-user-message hooks
   * @returns Whether the connector should rely on native resume
   */
  private deriveAndSetPendingStartMode(sessionContext: SessionContext | undefined): boolean {
    const useNativeResume = this.shouldUseNativeResume(sessionContext);
    const startMode = AgentTurnExecutor.deriveStartMode(sessionContext, useNativeResume, this.hasResumeTarget());
    this.setPendingStartMode(startMode);
    return useNativeResume;
  }

  /**
   * Execute the turn pipeline for agent.sendMessage.
   * @param payload - agent.sendMessage request payload
   * @returns Resolved messageId from connector handle
   */
  public async executeSendMessage(payload: SendMessageRequestPayload): Promise<{ messageId: string }> {
    return this.runDispatch(async () => {
      await this.onBeforeDispatch?.();

      const connector = this.getConnector();
      const parsedSessionContext = payload.sessionContext
        ? SessionContextSchema.parse(payload.sessionContext)
        : undefined;
      const hookResult = await this.resolvePreUserMessageTurn({
        message: payload.message,
        sessionContext: parsedSessionContext,
        cwd: connector.cwd,
        messageId: payload.messageId,
      });

      const useNativeResume = this.deriveAndSetPendingStartMode(hookResult.sessionContext);
      const normalizedMessage = normalizeMessageInput(hookResult.message);
      const handle = await connector.sendMessage(normalizedMessage, {
        deliveryMode: payload.deliveryMode,
        messageId: payload.messageId,
        turnId: payload.turnId,
        messageHistory: useNativeResume ? undefined : hookResult.sessionContext?.messageHistory,
        cacheStrategy: useNativeResume ? undefined : hookResult.sessionContext?.cacheStrategy,
        useNativeResume,
        turnContext: buildStructuredOutputTurnContext(
          hookResult.sessionContext?.turnContext,
          payload.responseSchema,
          this.adapterCapabilities,
        ),
        requestCorrelation: buildRequestCorrelation(hookResult.sessionContext?.requestCorrelation, {
          sessionId: this.sessionId,
          turnId: payload.turnId,
          messageId: payload.messageId,
        }),
        ...(payload.responseSchema !== undefined && { responseSchema: payload.responseSchema }),
      });

      this.assertCanonicalMessageId(payload.messageId, handle, connector, 'sendMessage');
      this.firePostUserMessageHooks(handle.messageId);
      await this.onMessageHandle(handle, payload.turnId);
      return { messageId: handle.messageId };
    });
  }

  /**
   * Execute the turn pipeline for agent.start.
   * @param message - Initial message payload
   * @param options - Start options from caller
   * @param systemPrompt - Runtime system prompt chosen by AIAgent
   * @param responseSchema - Runtime structured output descriptor chosen by AIAgent
   * @returns Agent start result from connector
   */
  public async executeStart(
    message: NormalizedMessageInput | MessageInput,
    options: StartAgentOptions | undefined,
    systemPrompt: StartAgentOptions['systemPrompt'],
    responseSchema?: ResponseSchemaDescriptor,
  ): Promise<AgentStartResult> {
    return this.runDispatch(async () => {
      await this.onBeforeDispatch?.();

      const connector = this.getConnector();
      const parsedSessionContext = options?.sessionContext
        ? SessionContextSchema.parse(options.sessionContext)
        : undefined;
      const hookResult = await this.resolvePreUserMessageTurn({
        message,
        sessionContext: parsedSessionContext,
        cwd: connector.cwd,
        messageId: options?.messageId,
      });

      const useNativeResume = this.deriveAndSetPendingStartMode(hookResult.sessionContext);
      const normalizedMessage = normalizeMessageInput(hookResult.message);
      const connectorOptions: ConnectorStartOptions = {
        systemPrompt,
        messageId: options?.messageId,
        messageHistory: useNativeResume ? undefined : hookResult.sessionContext?.messageHistory,
        cacheStrategy: useNativeResume ? undefined : hookResult.sessionContext?.cacheStrategy,
        useNativeResume,
        turnContext: buildStructuredOutputTurnContext(
          hookResult.sessionContext?.turnContext,
          responseSchema,
          this.adapterCapabilities,
        ),
        requestCorrelation: buildRequestCorrelation(hookResult.sessionContext?.requestCorrelation, {
          sessionId: this.sessionId,
        }),
        ...(responseSchema !== undefined && { responseSchema }),
      };

      const startResult = await connector.start(normalizedMessage, connectorOptions);
      this.assertCanonicalMessageId(options?.messageId, startResult.messageHandle, connector, 'start');
      this.firePostUserMessageHooks(startResult.messageHandle.messageId);
      await this.onMessageHandle(startResult.messageHandle, undefined);
      return startResult;
    });
  }

  /**
   * Resolve the pre-user hook result or preserve the caller payload for ephemeral turns.
   * @param input - Message and context for the outgoing user turn
   * @returns Message and session context to dispatch to the connector
   */
  private async resolvePreUserMessageTurn(input: PreUserMessageTurnInput): Promise<PreUserMessageTurnResult> {
    if (this.ephemeral) {
      return {
        message: input.message,
        sessionContext: input.sessionContext,
      };
    }

    return runPreUserMessageHooks(
      {
        agentId: this.agentId,
        adapterId: this.adapterId,
        message: input.message,
        sessionId: this.sessionId,
        cwd: input.cwd,
        sessionContext: input.sessionContext,
        messageId: input.messageId,
      },
      this.globalBus,
    );
  }

  /**
   * Fire PostUserMessage hooks without blocking the turn.
   * @param messageId - Message ID for correlation
   */
  private firePostUserMessageHooks(messageId: string): void {
    void runPostUserMessageHooks(
      {
        agentId: this.agentId,
        adapterId: this.adapterId,
        sessionId: this.sessionId,
        messageId,
      },
      this.globalBus,
    ).catch((err) => {
      console.error('[AIAgent] PostUserMessage hook error:', err);
    });
  }

  /**
   * Enforce the connector contract for an orchestrator-assigned message identity.
   * @param expectedMessageId - Canonical caller identity, when one was supplied.
   * @param handle - Connector handle returned for the dispatched message.
   * @param connector - Connector that owns fatal teardown for a violated dispatch contract.
   * @param operation - Connector operation that produced the handle.
   */
  private assertCanonicalMessageId(
    expectedMessageId: string | undefined,
    handle: MessageHandle,
    connector: AIAgentConnector,
    operation: 'start' | 'sendMessage',
  ): void {
    if (expectedMessageId === undefined || handle.messageId === expectedMessageId) return;
    const contractError = new Error(
      `Adapter connector contract violation (${this.adapterId}, ${operation}): expected MessageHandle.messageId ` +
        `${JSON.stringify(expectedMessageId)}, received ${JSON.stringify(handle.messageId)}`,
    );
    handle.markCompleted({ outcome: 'error', error: contractError });
    connector.handleError(contractError, true);
    throw contractError;
  }
}
