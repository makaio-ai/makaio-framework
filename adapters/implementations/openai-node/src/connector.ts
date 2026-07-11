import OpenAI from 'openai';
import type { ChatCompletionTool } from 'openai/resources/index.js';
import { MakaioBus } from '@makaio/bus-core';
import type { WireSessionSubjects } from '@makaio/ai-adapters-core';
import { BaseStreamConnector } from '@makaio/ai-adapters-stream-session';
import { OpenAINodeConnectorNamespace, OpenAINodeConnectorSubjects, type SdkEventMessage } from './namespaces/index.js';
import type { OpenAINodeAgentConfig, OpenAIBus } from './types/index.js';
import { fetchToolsForOpenAI } from './tool-handling.js';
import { OpenAIConnectorSession } from './session.js';
import { DEFAULT_MODEL } from './constants.js';
import { resolveOpenAIConstructorAuth } from './constructor-auth.js';

/**
 * Typed narrow-cast of the opaque provider `capabilities` bag
 * for OpenAI-protocol providers.
 *
 * Adapters read this from `providerContext.capabilities` to detect
 * structured output features without maintaining hardcoded provider ID sets.
 */
interface OpenAIProviderCapabilities {
  structuredOutput?: {
    /** Whether `response_format: json_schema` can be sent alongside `tools`. */
    responseFormatWithTools?: boolean;
    /** Whether `strict: true` is accepted on `json_schema` response format payloads. */
    strict?: boolean;
  };
}

/**
 * Read OpenAI protocol capabilities only from a resolved provider context.
 * @param providerContext - Normalized provider context supplied to the connector
 * @returns OpenAI protocol capability flags when the context is resolved
 */
function getOpenAIProviderCapabilities(
  providerContext: OpenAINodeAgentConfig['providerContext'],
): OpenAIProviderCapabilities | undefined {
  return providerContext?.state === 'resolved'
    ? (providerContext.capabilities as OpenAIProviderCapabilities | undefined)
    : undefined;
}

/** Default adapter identifier for standalone OpenAINodeAgent instances (without adapter layer) */
const defaultAdapterId = crypto.randomUUID();

/** Default scoped bus for OpenAI Node adapter */
const defaultBus = await OpenAINodeConnectorNamespace.scopedBus();

/**
 * OpenAI Node Agent - Wraps the OpenAI SDK for agentic chat completions.
 *
 * Implements the agentic loop pattern:
 * 1. Send user message to OpenAI
 * 2. Process streaming response
 * 3. If tool_calls present, execute tools via Bus RPC and recurse
 * 4. When no tool_calls, mark turn complete
 *
 * Tools are fetched from ToolRegistry via MakaioBus.request(ToolSubjects.list)
 * on the first turn. Tool execution routes through MakaioBus.request(ToolSubjects.execute)
 * to the ToolRegistry, which validates input and executes the tool handler.
 *
 * Authentication is resolved once by the central adapter runtime and delivered
 * through the OpenAI constructor target.
 */
export class OpenAINodeConnector extends BaseStreamConnector<OpenAIBus, OpenAIConnectorSession, OpenAINodeAgentConfig> {
  private readonly constructorAuth: ReturnType<typeof resolveOpenAIConstructorAuth>;
  private client?: OpenAI;
  /** OpenAI-format tools for chat completions API (fetched from bus on first turn) */
  private openAITools: ChatCompletionTool[] = [];

  /**
   * Emit an SDK event wrapped in envelope for type-safe discriminated union handling.
   * Pattern matches codex-mcp's \{ id, msg \} envelope.
   * @param event - The typed SDK event message to emit
   */
  private async emitSdkEvent(event: SdkEventMessage): Promise<void> {
    await this.emit(OpenAINodeConnectorSubjects.sdk.event, { event });
  }

  public constructor(config: OpenAINodeAgentConfig & { adapterId?: string }) {
    const { adapterAuth, ...baseConfig } = config;
    super({
      ...baseConfig,
      env: baseConfig.env ?? {},
      bus: config?.bus ?? defaultBus,
      adapterId: config?.adapterId ?? defaultAdapterId,
      adapterName: config?.adapterName ?? 'openai-node',
    });
    this.constructorAuth = resolveOpenAIConstructorAuth(adapterAuth);

    this.model = config?.model ?? DEFAULT_MODEL;

    // Generate local session ID (OpenAI doesn't provide server-side sessions)
    // Base constructor may have already set this from config (swap case)
    this.initAdapterSessionId();
  }

  // ---------------------------------------------------------------------------
  // BaseStreamConnector abstract implementations
  // ---------------------------------------------------------------------------

  /**
   * Initialize OpenAI with the centrally delivered authentication snapshot and
   * fetch available tools from the bus.
   *
   * Also converts fetched tools to OpenAI format and caches them in
   * `this.openAITools` for use in `createSession`.
   */
  protected async fetchTools(): Promise<void> {
    const baseUrl = this.config.providerConfig?.baseUrl;
    this.client = new OpenAI({
      ...this.constructorAuth,
      baseURL: baseUrl,
    });

    this.openAITools = await fetchToolsForOpenAI(this.config.globalBus ?? MakaioBus, this.adapterId, this.adapterName, {
      allowedTools: this.config.allowedTools,
      disallowedTools: this.config.disallowedTools,
    });
  }

  /**
   * Re-fetch native tools and re-resolve MCP direct-inject tools.
   *
   * Called at turn boundary when `hasPendingToolRefresh` is true.
   * Re-fetches OpenAI-format tools from the registry, re-prepares MCP
   * direct tools (and arms the ledger injection flag via `super.refreshTools()`),
   * then notifies the active session so the next API call uses the updated
   * merged tool list. The ledger `recordInjection` is deferred to
   * `onTurnStarted` so it uses the canonical turn number.
   */
  protected override async refreshTools(): Promise<void> {
    this.openAITools = await fetchToolsForOpenAI(this.config.globalBus ?? MakaioBus, this.adapterId, this.adapterName, {
      allowedTools: this.config.allowedTools,
      disallowedTools: this.config.disallowedTools,
    });
    await super.refreshTools(); // re-prepares mcpDirectTools, sets hasPendingLedgerInjection
    const session = this.getSession();
    session?.replaceNativeTools(this.openAITools);
    session?.updateTools?.(this.mcpDirectTools);
  }

  /**
   * Construct the OpenAI connector session with all required config.
   *
   * Called by `BaseStreamConnector.initializeSession()` after `fetchTools()`
   * has initialized `this.client` from the delivered auth snapshot.
   * @returns A new `OpenAIConnectorSession` instance
   */
  protected createSession(): OpenAIConnectorSession {
    if (!this.client) {
      throw new Error('[OpenAINodeConnector] createSession() called before fetchTools() — client not initialized');
    }
    const systemPrompt = this.resolveSystemPrompt();
    const caps = getOpenAIProviderCapabilities(this.config.providerContext);

    return new OpenAIConnectorSession({
      bus: this.config.bus,
      adapterId: this.config.adapterId ?? '',
      adapterName: this.config.adapterName ?? '',
      agentId: this.agentId,
      sessionId: this.config.sessionId,
      adapterSessionId: this.adapterSessionId,
      cwd: this.cwd,
      model: this.model ?? '',
      reasoningEffort: this.config.reasoningEffort,
      streamStartTimeoutMs: this.getTimeoutMs('eventWait'),
      env: { ...(this.config.contextEnv ?? {}) },
      client: this.client,
      openAITools: this.openAITools,
      requestCorrelationHeaders: this.config.providerConfig?.requestCorrelationHeaders,
      systemPrompt,
      supportsResponseFormatWithTools:
        this.config.providerConfig?.supportsResponseFormatWithTools ??
        caps?.structuredOutput?.responseFormatWithTools ??
        false,
      supportsStructuredOutputStrict:
        this.config.providerConfig?.supportsStructuredOutputStrict ?? caps?.structuredOutput?.strict ?? false,
      allowedDirectories: this.config.allowedDirectories,
      supportedReasoningLevels: this.config.supportedReasoningLevels,
      emitSdkEvent: this.emitSdkEvent.bind(this),
      globalBus: this.config.globalBus ?? MakaioBus,
      handleError: this.handleError.bind(this),
      requestToolApproval: (payload) =>
        this.requestToolApprovalWithHandling(OpenAINodeConnectorSubjects.tool_approval, payload),
      logLowLevelEvent: this.logLowLevelEvent,
      onTurnStart: (handle) => {
        this.pendingMessageHandle = handle;
      },
      onTurnComplete: (_handle, result) => {
        this.lastResult = result;
        this.pendingMessageHandle = undefined;
      },
      recordMcpCall: this.config.toolLedger
        ? (toolFullName: string) => {
            this.config.toolLedger?.recordCall(toolFullName, this.currentTurnNumber);
          }
        : undefined,
    });
  }

  /**
   * Get OpenAI namespace turn subjects.
   * @returns Turn subject definitions
   */
  protected getTurnSubjects(): WireSessionSubjects<OpenAIBus['namespace']> {
    return OpenAINodeConnectorSubjects.turn;
  }
}
