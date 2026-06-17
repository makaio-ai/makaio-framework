import Anthropic from '@anthropic-ai/sdk';
import type { WireSessionSubjects } from '@makaio/ai-adapters-core';
import { BaseStreamConnector } from '@makaio/ai-adapters-stream-session';
import { resolveConnectorCredentials } from '@makaio/ai-adapters-core/config';
import {
  AnthropicSdkConnectorNamespace,
  AnthropicSdkConnectorSubjects,
  type SdkEventMessage,
} from './namespaces/index.js';
import type { AnthropicSdkAgentConfig, AnthropicSdkBus } from './types/index.js';
import { fetchToolsForAnthropic } from './tool-handling.js';
import { AnthropicSdkSession } from './session.js';
import { AnthropicSdkAdapterName, DEFAULT_MODEL } from './constants.js';

/** Default scoped bus for Anthropic SDK adapter */
// Intentional module-level await: keeps constructor synchronous while sharing one
// scoped bus instance across connector instances (same pattern as openai-node).
const defaultBus = await AnthropicSdkConnectorNamespace.scopedBus();

/**
 * Anthropic SDK Connector — Wraps the Anthropic SDK for agentic message creation.
 *
 * Implements the agentic loop pattern:
 * 1. Send user message to Anthropic via messages.create (streaming)
 * 2. Process streaming response via stream-bridge
 * 3. If tool_use blocks present, execute tools via Bus RPC and recurse
 * 4. When no tool_use blocks, mark turn complete
 *
 * Tools are fetched from ToolRegistry via MakaioBus.request(ToolSubjects.list)
 * on the first turn. Tool execution routes through MakaioBus.request(ToolSubjects.execute)
 * to the ToolRegistry, which validates input and executes the tool handler.
 *
 * Credential resolution happens in `fetchTools()` (the first async lifecycle hook)
 * via `resolveConnectorCredentials()`. Plaintext credentials are stored in instance
 * fields and never leave the connector.
 */
export class AnthropicSdkConnector extends BaseStreamConnector<
  AnthropicSdkBus,
  AnthropicSdkSession,
  AnthropicSdkAgentConfig
> {
  /** Resolved API key (populated in fetchTools before createSession is called). */
  private resolvedApiKey = '';
  private client?: Anthropic;
  /** Anthropic-format tools for messages.create (fetched from bus on first turn) */
  private anthropicTools: Awaited<ReturnType<typeof fetchToolsForAnthropic>> = [];

  /**
   * Emit an SDK event wrapped in envelope for type-safe discriminated union handling.
   * @param event - The typed SDK event message to emit
   */
  private async emitSdkEvent(event: SdkEventMessage): Promise<void> {
    await this.emit(AnthropicSdkConnectorSubjects.sdk.event, { event });
  }

  public constructor(config: AnthropicSdkAgentConfig & { adapterId?: string }) {
    super({
      ...config,
      bus: config?.bus ?? defaultBus,
      adapterId: config?.adapterId ?? crypto.randomUUID(),
      adapterName: config?.adapterName ?? AnthropicSdkAdapterName,
    });

    this.model = config?.model ?? DEFAULT_MODEL;

    // Generate local session ID (Anthropic SDK adapter uses stateless API)
    // Base constructor may have already set this from config (swap case)
    this.initAdapterSessionId();
  }

  // ---------------------------------------------------------------------------
  // BaseStreamConnector abstract implementations
  // ---------------------------------------------------------------------------

  /**
   * Resolve credentials and fetch available tools from the bus.
   *
   * Resolves `apiKey` from `providerContext.credentialRefs` via the encrypted
   * credential channel, then initializes the Anthropic SDK client. Called once
   * by `BaseStreamConnector.initializeSession()` before `createSession()`.
   *
   * Also converts fetched tools to Anthropic format and caches them in
   * `this.anthropicTools` for use in `createSession`.
   */
  protected async fetchTools(): Promise<void> {
    const credentialRefs = this.config.providerContext?.credentialRefs ?? {};
    const credentials = await resolveConnectorCredentials(this.config.bus, credentialRefs);
    this.resolvedApiKey = credentials['apiKey'] ?? '';

    const baseUrl = this.config.providerConfig?.baseUrl;
    this.client = new Anthropic({
      ...(this.resolvedApiKey ? { apiKey: this.resolvedApiKey } : {}),
      baseURL: baseUrl ?? undefined,
    });

    this.anthropicTools = await fetchToolsForAnthropic(this.adapterId, this.adapterName);
  }

  /**
   * Re-fetch native tools and re-resolve MCP direct-inject tools.
   *
   * Called at turn boundary when `hasPendingToolRefresh` is true.
   * Re-fetches Anthropic-format tools from the registry, re-prepares MCP
   * direct tools (and arms the ledger injection flag via `super.refreshTools()`),
   * then notifies the active session so the next API call uses the updated
   * merged tool list. The ledger `recordInjection` is deferred to
   * `onTurnStarted` so it uses the canonical turn number.
   */
  protected override async refreshTools(): Promise<void> {
    this.anthropicTools = await fetchToolsForAnthropic(this.adapterId, this.adapterName);
    await super.refreshTools(); // re-prepares mcpDirectTools, sets hasPendingLedgerInjection
    const session = this.getSession();
    session?.replaceNativeTools(this.anthropicTools);
    session?.updateTools?.(this.mcpDirectTools);
  }

  /**
   * Construct the Anthropic SDK session with all required config.
   *
   * Called by `BaseStreamConnector.initializeSession()` after `fetchTools()`
   * has resolved credentials and initialized `this.client`.
   * @returns A new `AnthropicSdkSession` instance
   */
  protected createSession(): AnthropicSdkSession {
    if (!this.client) {
      throw new Error('[AnthropicSdkConnector] createSession() called before fetchTools() — client not initialized');
    }
    const systemPrompt = this.resolveSystemPrompt();

    return new AnthropicSdkSession({
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
      env: this.config.env ?? {},
      client: this.client,
      anthropicTools: this.anthropicTools,
      systemPrompt,
      maxTokens: this.config.providerConfig?.maxTokens,
      allowedDirectories: this.config.allowedDirectories,
      supportedReasoningLevels: this.config.supportedReasoningLevels,
      emitSdkEvent: this.emitSdkEvent.bind(this),
      handleError: this.handleError.bind(this),
      requestToolApproval: (payload) =>
        this.requestToolApprovalWithHandling(AnthropicSdkConnectorSubjects.tool_approval, payload),
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
   * Get Anthropic namespace turn subjects.
   * @returns Turn subject definitions
   */
  protected getTurnSubjects(): WireSessionSubjects<AnthropicSdkBus['namespace']> {
    return AnthropicSdkConnectorSubjects.turn;
  }
}
