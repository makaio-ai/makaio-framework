import { runPreUserMessageHooks, runPostUserMessageHooks } from '@makaio/hooks';
import { SessionContextSchema, type MessageInput, type ResponseSchemaDescriptor } from '@makaio/contracts';
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
  /** Completion/lifecycle tracker hook. */
  onMessageHandle: AgentMessageHandleCallback;
  /** Side-effect callback to mark agent status active before dispatch. */
  onBeforeDispatch?: () => void | Promise<void>;
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
  private readonly onMessageHandle: AgentMessageHandleCallback;
  private readonly onBeforeDispatch?: () => void | Promise<void>;
  private readonly ephemeral: boolean;

  public constructor(config: AgentTurnExecutorConfig) {
    this.agentId = config.agentId;
    this.adapterId = config.adapterId;
    this.sessionId = config.sessionId;
    this.adapterCapabilities = config.adapterCapabilities ?? [];
    this.globalBus = config.globalBus;
    this.getConnector = config.getConnector;
    this.shouldUseNativeResume = config.shouldUseNativeResume;
    this.onMessageHandle = config.onMessageHandle;
    this.onBeforeDispatch = config.onBeforeDispatch;
    this.ephemeral = config.ephemeral ?? false;
  }

  /**
   * Execute the turn pipeline for agent.sendMessage.
   * @param payload - agent.sendMessage request payload
   * @returns Resolved messageId from connector handle
   */
  public async executeSendMessage(payload: SendMessageRequestPayload): Promise<{ messageId: string }> {
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

    const useNativeResume = this.shouldUseNativeResume(hookResult.sessionContext);
    const normalizedMessage = normalizeMessageInput(hookResult.message);

    const handle = await connector.sendMessage(normalizedMessage, {
      deliveryMode: payload.deliveryMode,
      messageId: payload.messageId,
      messageHistory: useNativeResume ? undefined : hookResult.sessionContext?.messageHistory,
      cacheStrategy: useNativeResume ? undefined : hookResult.sessionContext?.cacheStrategy,
      turnContext: buildStructuredOutputTurnContext(
        hookResult.sessionContext?.turnContext,
        payload.responseSchema,
        this.adapterCapabilities,
      ),
      ...(payload.responseSchema !== undefined && { responseSchema: payload.responseSchema }),
    });

    this.firePostUserMessageHooks(handle.messageId);
    await this.onMessageHandle(handle, payload.turnId);

    return { messageId: handle.messageId };
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
    await this.onBeforeDispatch?.();

    const connector = this.getConnector();
    const parsedSessionContext = options?.sessionContext
      ? SessionContextSchema.parse(options.sessionContext)
      : undefined;
    const hookResult = await this.resolvePreUserMessageTurn({
      message,
      sessionContext: parsedSessionContext,
      cwd: connector.cwd,
    });

    const useNativeResume = this.shouldUseNativeResume(hookResult.sessionContext);
    const normalizedMessage = normalizeMessageInput(hookResult.message);

    const connectorOptions: ConnectorStartOptions = {
      systemPrompt,
      messageHistory: useNativeResume ? undefined : hookResult.sessionContext?.messageHistory,
      cacheStrategy: useNativeResume ? undefined : hookResult.sessionContext?.cacheStrategy,
      turnContext: buildStructuredOutputTurnContext(
        hookResult.sessionContext?.turnContext,
        responseSchema,
        this.adapterCapabilities,
      ),
      ...(responseSchema !== undefined && { responseSchema }),
    };

    const startResult = await connector.start(normalizedMessage, connectorOptions);

    this.firePostUserMessageHooks(startResult.messageHandle.messageId);
    await this.onMessageHandle(startResult.messageHandle, undefined);

    return startResult;
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
}
