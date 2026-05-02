/* eslint max-lines: ["error", { "max": 440 }] */
import { MakaioBus, type ScopedBus, type IMakaioBus } from '@makaio/bus-core';
import type { AIAgent } from '../agent/ai-agent.js';
import type { AdapterNamespace } from '../factory/index.js';
import { AIAgentConnector, SessionToolLedger, type BaseAgentConnectorConfig } from '../agent/index.js';
import type { AIAgentConfig } from '../agent/types.js';
import type { ConfigFactoryInput } from './ai-adapter-config.js';
import type { AdapterProviderDefinition, PlatformDefaults } from '../types/index.js';
import { AdapterSubjects, AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { AgentCreationOptions, AIAdapterConstructorConfig } from './types.js';
import { AgentRegistry } from './agent-registry.js';
import { AgentRehydrationManager } from './ai-adapter-rehydration.js';
import { handleInfer } from './ai-adapter-infer.js';
import { buildOptionalAgentConfig, resolveExecutionModels } from './ai-adapter-create-utils.js';
import { createStartAgentHandler } from './ai-adapter-start-handler.js';

/**
 * Base class for AI adapters.
 *
 * An adapter manages a set of agents, handles adapter.* subjects as RPC endpoints,
 * and provides clear file-to-subject mapping.
 *
 * Three-layer architecture:
 * - AIAdapter: Handles adapter.* global subjects, owns agent tracking
 * - AIAgent: Handles agent.* global subjects (filtered by agentId), wraps connector
 * - AIAgentConnector: Owns adapter-specific namespace, SDK-level bridge
 *
 * Subject Ownership:
 * - `adapter.startAgent` - Creates and starts new agents (owned by AIAdapter)
 * - `adapter.initialized` - Emitted when adapter is ready (owned by AIAdapter)
 * - `adapter.session.created` - Emitted after agent starts (owned by AIAdapter)
 * - `session.agent.added` - Emitted to notify global session service (owned by AIAdapter)
 * - `agent.*` subjects - Owned by agent instances (see ai-agent.ts)
 * @typeParam TBus - Scoped bus type for adapter-specific events
 * @typeParam TConnector - Connector type bridging to the AI SDK
 * @typeParam TAgent - Agent implementation type (must extend AIAgent)
 */
export abstract class AIAdapter<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus> = AIAgentConnector<TBus>,
  TAgent extends AIAgent<TBus, TConnector> = AIAgent<TBus, TConnector>,
> {
  /** Unique identifier for this adapter instance. */
  public readonly adapterId: string;
  /** Adapter name (e.g., 'openai-node', 'claude-code'). */
  public readonly name: string;
  /** Adapter capabilities for runtime feature detection. */
  public readonly capabilities: string[];
  /** Native tools built into the adapter (e.g., ['shell_command', 'apply_patch']). */
  public readonly nativeTools: string[];
  /** Adapter namespace for creating scoped bus. */
  protected readonly namespace: AdapterNamespace;
  /** Global bus for cross-adapter communication. */
  protected readonly globalBus: IMakaioBus;
  /** Scoped bus for adapter-specific communication. Created in init(). */
  protected adapterBus: TBus;
  /** Registry of active agents with session info and usage totals. */
  private readonly registry: AgentRegistry<TBus, TConnector, TAgent>;
  /** Cleanup functions for bus subscriptions. */
  private cleanupFns: Array<() => void> = [];
  /** Manages agent rehydration with single-flight deduplication. */
  private readonly rehydrationManager: AgentRehydrationManager<TBus, TConnector, TAgent>;
  /** Tracks whether the adapter has been initialized. */
  private initialized = false;
  /** Client identifier for the application this adapter belongs to (e.g., 'claude-code', 'codex'). */
  protected readonly clientId?: string;
  /** Platform-provided defaults (cwd, env) injected by runtime. Lowest priority. */
  protected platformDefaults?: PlatformDefaults;
  /** Provider definitions for model lookup. Injected by runtime. */
  protected readonly definitionProviders: readonly AdapterProviderDefinition[];
  protected agentFactory: (agentConfig: AIAgentConfig<TBus, TConnector>) => TAgent;
  /** Config factory - transforms partial input into full adapter-specific config (includes adapterId) */
  protected configFactory: (
    input: ConfigFactoryInput<TBus>,
  ) => Promise<BaseAgentConnectorConfig<TBus> & { adapterId: string }>;
  /** Connector factory - creates connector from full config (includes adapterId) */
  protected connectorFactory: (
    config: BaseAgentConnectorConfig<TBus> & { adapterId: string },
  ) => TConnector | Promise<TConnector>;

  /**
   * Create a new AIAdapter instance.
   * Constructor is synchronous - stores config only. Call init() to complete setup.
   * @param config - Adapter configuration
   */
  protected constructor(config: AIAdapterConstructorConfig<TBus, TConnector, TAgent>) {
    this.adapterId = config.adapterId ?? crypto.randomUUID();
    this.name = config.name;
    this.capabilities = config.capabilities;
    this.nativeTools = config.nativeTools ?? [];
    this.globalBus = config.globalBus ?? MakaioBus;
    this.adapterBus = config.scopedBus as TBus;
    this.namespace = config.namespace;
    this.agentFactory = config.agentFactory;
    this.configFactory = config.configFactory;
    this.connectorFactory = config.connectorFactory;
    this.clientId = config.clientId;
    this.platformDefaults = config.platformDefaults;
    this.definitionProviders = config.definitionProviders ?? [];
    this.registry = new AgentRegistry({ globalBus: this.globalBus, adapterName: this.name });
    this.rehydrationManager = new AgentRehydrationManager({
      globalBus: this.globalBus,
      registry: this.registry,
      createAgent: this.createAgent.bind(this),
    });
  }

  /** Set up RPC handlers and event listeners. */
  private setupHandlers(): void {
    const filteredBus = this.globalBus.withFilter({ adapterId: this.adapterId });

    this.cleanupFns.push(
      filteredBus.on(
        AdapterSubjects.startAgent,
        createStartAgentHandler({
          adapterId: this.adapterId,
          name: this.name,
          clientId: this.clientId,
          getPlatformDefaults: () => this.platformDefaults,
          registry: this.registry,
          globalBus: this.globalBus,
          createAgent: this.createAgent.bind(this),
        }),
      ),
      filteredBus.on(AdapterSubjects.rehydrateAgent, this.rehydrationManager.handleRehydrateAgent),
      filteredBus.on(AdapterSubjects.infer, (ctx) =>
        handleInfer(ctx, {
          adapterBus: this.adapterBus,
          adapterId: this.adapterId,
          adapterName: this.name,
          platformDefaults: this.platformDefaults,
          configFactory: this.configFactory,
          connectorFactory: this.connectorFactory,
        }),
      ),
      filteredBus.on(AgentSubjects.session.closed, this.handleSessionClosed),
      filteredBus.on(AgentSubjects.usage, this.handleUsage),
      // Listen for session-driven closures to evict agents
      this.globalBus.on(SessionSubjects.closed, this.handleSessionClosedByService),
      filteredBus.on(AdapterSubjects.listAgents, (ctx) => {
        ctx.setResult({
          agents: Array.from(this.registry.values()).map((entry) => ({
            agentId: entry.agent.agentId,
            sessionId: entry.adapterSessionId,
            adapterSessionId: entry.adapterSessionId,
          })),
        });
      }),
      filteredBus.on(AdapterSubjects.getAgent, (ctx) => {
        const entry = this.registry.get(ctx.payload.agentId);
        ctx.setResult({
          agent: entry
            ? {
                agentId: entry.agent.agentId,
                sessionId: entry.sessionId,
                adapterSessionId: entry.adapterSessionId,
              }
            : null,
        });
      }),
      filteredBus.on(AdapterSubjects.stopAgent, (ctx) => {
        ctx.setResult({ success: this.disposeAgent(ctx.payload.agentId) });
      }),
      filteredBus.on(AdapterSubjects.getCapabilities, (ctx) => {
        ctx.setResult({ capabilities: this.capabilities, nativeTools: this.nativeTools });
      }),
    );
  }

  /**
   * Handle agent.session.closed - cleanup agent + re-emit as adapter.session.closed.
   * @param ctx - Event context with session closed payload
   */
  private handleSessionClosed = (ctx: { payload: { agentId: string; adapterSessionId: string; reason?: string } }) => {
    const { agentId, adapterSessionId, reason } = ctx.payload;
    const entry = this.registry.get(agentId);

    if (!entry) {
      console.warn(`Agent ${agentId} not found, can't emit AgentSubjects.session.closed`);
      return;
    }

    void this.registry.evict(agentId).catch((error) => {
      console.error(`[AIAdapter:${this.name}] Failed to evict agent ${agentId} after session.closed:`, error);
    });

    void this.globalBus.emit(AdapterSubjects.session.closed, {
      adapterId: this.adapterId,
      adapterName: this.name,
      agentId,
      sessionId: entry.sessionId,
      adapterSessionId,
      reason,
    });
  };

  /**
   * Handle session.closed - evict agents when their session is closed.
   * @param ctx - Event context with the closed session's ID
   */
  private handleSessionClosedByService = async (ctx: {
    payload: { sessionId: string; reason?: string };
  }): Promise<void> => {
    const { sessionId } = ctx.payload;

    const agentsToEvict = this.registry.agentIdsBySession(sessionId);

    await Promise.all(
      agentsToEvict.map((agentId) =>
        this.registry
          .evict(agentId)
          .catch((error) =>
            console.error(`[AIAdapter:${this.name}] Failed to evict agent ${agentId} after session.closed:`, error),
          ),
      ),
    );
  };

  /**
   * Handle agent.usage - aggregate and emit session totals.
   * @param ctx - Event context with usage payload
   */
  private handleUsage = (ctx: {
    payload: { agentId: string; adapterSessionId: string; inputTokens: number; outputTokens: number };
  }): void => {
    const { agentId, adapterSessionId, inputTokens, outputTokens } = ctx.payload;

    const entry = this.registry.accumulateUsage(agentId, { inputTokens, outputTokens }, adapterSessionId);
    if (!entry) return;

    void this.globalBus.emit(AdapterSubjects.session.usage, {
      adapterId: this.adapterId,
      adapterName: this.name,
      sessionId: entry.sessionId,
      adapterSessionId: entry.adapterSessionId,
      ...entry.usage,
    });
  };

  /**
   * Initialize adapter - call after construction.
   * Creates scoped bus, sets up handlers, and emits adapter.initialized event.
   * Safe to call multiple times - subsequent calls are no-ops.
   *
   * Note: Agents are NOT eagerly rehydrated on startup. They are rehydrated
   * on-demand when messages arrive (lazy rehydration via handleRehydrateAgent).
   */
  public async init(): Promise<void> {
    if (this.initialized) return;

    this.adapterBus ??= (await this.namespace.scopedBus()) as TBus;

    // Setup handlers
    this.setupHandlers();

    // Subclass hook
    await this.onInit();

    this.initialized = true;

    // Emit initialized event
    await this.globalBus.emit(AdapterSubjects.initialized, {
      adapterId: this.adapterId,
      adapterName: this.name,
      capabilities: this.capabilities,
      nativeTools: this.nativeTools,
    });
  }

  /** Hook for subclass initialization. Override to perform async setup (connections, auth, etc.). */
  protected async onInit(): Promise<void> {}

  /**
   * Create an agent instance.
   *
   * Subclasses implement this to instantiate their specific AIAgent subclass.
   * The agent should NOT be started yet - that's handled by startAgent after creation.
   * @param agentId - Pre-generated agent ID (use this, don't generate your own)
   * @param sessionId - Makaio session ID (created or provided based on mode)
   * @param request - The startAgent request payload
   * @returns The agent instance (NOT started yet)
   */
  protected async createAgent(agentId: string, sessionId: string, request: AgentCreationOptions): Promise<TAgent> {
    if (!this.adapterBus) {
      throw new Error('Adapter bus not initialized. Did you forget to call init()?');
    }

    // Extract only runtime options from request - avoid leaking mode/initialMessage/sourceSessionId
    const { model, cwd, env, allowedTools, disallowedTools, reasoningEffort, mcpSessionContext, harnessId, ephemeral } =
      request;
    // clientId: payload carries it from the caller; adapter definition is the authoritative fallback.
    const clientId = request.clientId ?? this.clientId;
    const resumeAdapterSessionId =
      'adapterSessionId' in request && 'mode' in request && request.mode === 'resume'
        ? (request as { adapterSessionId: string }).adapterSessionId
        : undefined;

    // Resolve provider-scoped models only. Avoid cross-provider flattening because
    // duplicate model names across providers are ambiguous for execution metadata.
    const availableModels = resolveExecutionModels(
      this.definitionProviders,
      model,
      request.providerContext?.definitionId,
    );
    // Per-agent ledger: one instance per createAgent() call, shared across connector swaps.
    const toolLedger = mcpSessionContext !== undefined ? new SessionToolLedger() : undefined;

    const config: AIAgentConfig<TBus, TConnector> = {
      agentId,
      adapterId: this.adapterId,
      adapterName: this.name,
      adapterBus: this.adapterBus,
      capabilities: this.capabilities,
      nativeTools: this.nativeTools,
      availableModels,
      configFactory: this.configFactory,
      connectorFactory: this.connectorFactory,
      sessionId: sessionId,
      ...(request.providerContext !== undefined && { providerContext: request.providerContext }),
      ...buildOptionalAgentConfig({
        platformCwd: this.platformDefaults?.cwd,
        platformEnv: this.platformDefaults?.env,
        model,
        cwd,
        env,
        allowedTools,
        disallowedTools,
        reasoningEffort,
        resumeAdapterSessionId,
        harnessId,
        clientId,
        mcpSessionContext,
        toolLedger,
        ephemeral,
      }),
    };

    return this.agentFactory(config) as TAgent;
  }

  /**
   * Asynchronous cleanup for awaitable shutdown.
   * Runs cleanup functions, aborts agents, allows subclass cleanup via onClose hook.
   * @returns Promise that resolves when cleanup is complete
   */
  public async closeAsync(): Promise<void> {
    try {
      // Close agents FIRST — this interrupts SDK queries and drains connections
      // (e.g., MCP HTTP server connections held by the Claude Agent SDK).
      // onClose() waits for connection drain; agents must be closed before that.
      // Uses allSettled so one failing agent does not skip onClose() and cleanup.
      const results = await Promise.allSettled([...this.registry.values()].map((entry) => entry.agent.close()));
      this.registry.clear();

      await this.onClose();

      const closeErrors = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason instanceof Error ? r.reason : new Error(String(r.reason))));
      if (closeErrors.length > 0) {
        console.warn(`[AIAdapter] ${closeErrors.length} agent(s) failed to close:`, closeErrors);
      }
    } finally {
      for (const cleanup of this.cleanupFns) {
        try {
          cleanup();
        } catch (error) {
          console.warn('[AIAdapter] Cleanup function failed:', error);
        }
      }
      this.cleanupFns = [];
      this.initialized = false;
    }
  }

  /**
   * Cleanup resources and unsubscribe from bus.
   * Runs cleanup functions, aborts agents, allows subclass cleanup via onClose hook.
   */
  public close(): void {
    void this.closeAsync();
  }

  /** Hook for subclass cleanup. Override to perform async teardown (close connections, etc.). */
  protected async onClose(): Promise<void> {}

  /**
   * Get an agent by ID with session info.
   * @param agentId - Agent identifier
   * @returns Agent with session info, or undefined if not found
   */
  public getAgent(agentId: string): (TAgent & { sessionId: string; adapterSessionId: string }) | undefined {
    const entry = this.registry.get(agentId);
    if (!entry) return undefined;
    return Object.assign({}, entry.agent, {
      sessionId: entry.sessionId,
      adapterSessionId: entry.adapterSessionId,
    }) as TAgent & { sessionId: string; adapterSessionId: string };
  }

  /**
   * Dispose resources for an agent.
   *
   * Aborts the agent and removes it from the tracking map.
   * @param agentId - Agent identifier
   * @returns true if agent was found and disposed, false otherwise
   */
  public disposeAgent(agentId: string): boolean {
    return this.registry.dispose(agentId);
  }

  /**
   * Get all active agents managed by this adapter.
   * @returns Array of active agents with session info
   */
  public getActiveAgents(): Array<TAgent & { sessionId: string; adapterSessionId: string }> {
    return Array.from(this.registry.values()).map((entry) =>
      Object.assign({}, entry.agent, {
        sessionId: entry.sessionId,
        adapterSessionId: entry.adapterSessionId,
      }),
    ) as Array<TAgent & { sessionId: string; adapterSessionId: string }>;
  }

  /**
   * Check if the adapter has been initialized.
   * @returns true if init() has been called successfully
   */
  public isInitialized(): boolean {
    return this.initialized;
  }
}
