/* eslint max-lines: ["error", { "max": 455 }] */
import { MakaioBus, type ScopedBus, type IMakaioBus } from '@makaio/bus-core';
import type { AIAgent } from '../agent/ai-agent.js';
import type { AdapterNamespace } from '../factory/index.js';
import { AIAgentConnector, type BaseAgentConnectorConfig } from '../agent/index.js';
import type { AIAgentConfig } from '../agent/types.js';
import type { ConfigFactoryInput } from './ai-adapter-config.js';
import type { AdapterProviderDefinition, PlatformDefaults } from '../types/index.js';
import { AdapterSubjects, AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { ActiveAgentHandle, AgentCreationOptions, AIAdapterConstructorConfig } from './types.js';
import {
  ActiveAgentRegistry,
  toAgentSummary,
  type AgentDisposalReport,
  type AgentTeardownOptions,
} from './agent-registry.js';
import { AgentTeardownArbiter } from '../agent/agent-teardown-arbiter.js';
import { AgentRehydrationManager } from './ai-adapter-rehydration.js';
import { handleInfer } from './ai-adapter-infer.js';
import { buildAgentConfig } from './ai-adapter-agent-config.js';
import { createStartAgentHandler } from './ai-adapter-start-handler.js';
import type { AdapterAuthRuntimePreparer } from '../config/adapter-auth-runtime.js';

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
  /**
   * The one place a teardown and a connector replacement meet on this instance.
   *
   * Constructed here because one adapter instance is exactly its scope, and
   * declared before the registry so it can be handed to it as a required
   * dependency — see {@link AgentTeardownArbiter}.
   */
  private readonly teardownArbiter = new AgentTeardownArbiter();
  /** Registry of active agents with session info and usage totals. */
  private readonly registry: ActiveAgentRegistry<TBus, TConnector, TAgent>;
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
  /** Trusted host-local normalized auth preparation strategy. */
  protected readonly prepareAuthRuntime?: AdapterAuthRuntimePreparer<TBus>;
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
    this.prepareAuthRuntime = config.prepareAuthRuntime as AdapterAuthRuntimePreparer<TBus> | undefined;
    this.registry = new ActiveAgentRegistry({
      globalBus: this.globalBus,
      adapterName: this.name,
      arbiter: this.teardownArbiter,
    });
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
          globalBus: this.globalBus,
          adapterId: this.adapterId,
          adapterName: this.name,
          clientId: this.clientId,
          adapterCapabilities: this.capabilities,
          definitionProviders: this.definitionProviders,
          platformDefaults: this.platformDefaults,
          configFactory: this.configFactory,
          connectorFactory: this.connectorFactory,
          prepareAuthRuntime: this.prepareAuthRuntime,
        }),
      ),
      filteredBus.on(AgentSubjects.session.closed, this.handleSessionClosed),
      filteredBus.on(AgentSubjects.started, this.handleStartedReconcileRegistry),
      filteredBus.on(AgentSubjects.usage, this.handleUsage),
      // Listen for session-driven closures to evict agents
      this.globalBus.on(SessionSubjects.closed, this.handleSessionClosedByService),
      filteredBus.on(AdapterSubjects.listAgents, (ctx) => {
        ctx.setResult({ agents: Array.from(this.registry.values()).map(toAgentSummary) });
      }),
      filteredBus.on(AdapterSubjects.getAgent, (ctx) => {
        const entry = this.registry.get(ctx.payload.agentId);
        ctx.setResult({ agent: entry ? toAgentSummary(entry) : null });
      }),
      filteredBus.on(AdapterSubjects.stopAgent, async (ctx) => {
        // The deadline travels in: a teardown that waits for a connector
        // replacement ends its wait inside the deadline of whoever awaits it.
        const report = await this.disposeAgent(ctx.payload.agentId, { deadline: ctx.deadline });
        ctx.setResult({
          success: report.found,
          evidence: report.evidence,
          ...(report.detail !== undefined && { detail: report.detail }),
        });
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
  private handleSessionClosed = (ctx: { payload: { agentId: string; adapterSessionId?: string; reason?: string } }) => {
    const { agentId, adapterSessionId, reason } = ctx.payload;
    const entry = this.registry.get(agentId);

    if (!entry) {
      console.warn(`Agent ${agentId} not found, can't emit AgentSubjects.session.closed`);
      return;
    }

    // Prefer the event payload, fall back to the registry's stored value —
    // by session-close time the ID should be confirmed, but the agent event
    // schema allows it missing for unconfirmed fork sessions.
    const resolvedAdapterSessionId = adapterSessionId ?? entry.adapterSessionId ?? '';

    void this.registry.evict(agentId).catch((error) => {
      console.error(`[AIAdapter:${this.name}] Failed to evict agent ${agentId} after session.closed:`, error);
    });

    void this.globalBus.emit(AdapterSubjects.session.closed, {
      adapterId: this.adapterId,
      adapterName: this.name,
      agentId,
      sessionId: entry.sessionId,
      adapterSessionId: resolvedAdapterSessionId,
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
          .evict(agentId, { emitSessionClosed: false })
          .catch((error) =>
            console.error(`[AIAdapter:${this.name}] Failed to evict agent ${agentId} after session.closed:`, error),
          ),
      ),
    );
  };

  /**
   * Reconcile registry adapterSessionId on first confirmed agent.started (idle fork starts).
   * @param ctx - Event context with started payload
   */
  private handleStartedReconcileRegistry = (ctx: { payload: { agentId: string; adapterSessionId?: string } }): void => {
    const { agentId, adapterSessionId } = ctx.payload;
    if (!adapterSessionId) return;
    const entry = this.registry.get(agentId);
    if (entry && !entry.adapterSessionId) entry.adapterSessionId = adapterSessionId;
  };

  /**
   * Handle agent.usage — aggregate and emit session totals.
   * @param ctx - Event context with usage payload
   */
  private handleUsage = (ctx: {
    payload: { agentId: string; adapterSessionId?: string; inputTokens: number; outputTokens: number };
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

  /** Initialize adapter (idempotent). Creates scoped bus, sets up handlers, emits adapter.initialized. */
  public async init(): Promise<void> {
    if (this.initialized) return;

    this.globalBus.registerNamespaces([this.namespace.definition]);
    this.adapterBus ??= (await this.namespace.scopedBus(this.globalBus.getContext())) as TBus;

    this.setupHandlers();

    await this.onInit();

    this.initialized = true;

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
    return this.agentFactory(
      buildAgentConfig<TBus, TConnector>(request, {
        agentId,
        sessionId,
        adapterId: this.adapterId,
        adapterName: this.name,
        globalBus: this.globalBus,
        adapterBus: this.adapterBus,
        // One arbiter per instance: the agents replace connectors against the
        // same maps the registry tears them down through.
        teardownArbiter: this.teardownArbiter,
        capabilities: this.capabilities,
        nativeTools: this.nativeTools,
        definitionProviders: this.definitionProviders,
        configFactory: this.configFactory,
        connectorFactory: this.connectorFactory,
        prepareAuthRuntime: this.prepareAuthRuntime,
        platformDefaults: this.platformDefaults,
        clientId: this.clientId,
      }),
    ) as TAgent;
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
      // Every close goes through the registry's teardown flight rather than
      // straight at the agents: an instance shutdown overlapping a stop used to
      // close one connector twice, and no failing agent may skip onClose() —
      // which the flight preserves by reporting instead of rejecting.
      const reports = await this.registry.closeAll();

      await this.onClose();

      const closeErrors = reports
        .map((report) => report.closeError)
        .filter((error): error is unknown => error !== undefined);
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
   * Get a live agent and its registry-owned session metadata.
   * @param agentId - Agent identifier
   * @returns Active agent handle, or undefined if not found
   */
  public getAgent(agentId: string): ActiveAgentHandle<TAgent> | undefined {
    const entry = this.registry.get(agentId);
    return entry === undefined ? undefined : toActiveAgentHandle(entry);
  }

  /**
   * Dispose resources for an agent and report what the teardown observed.
   *
   * `found` answers the question the boolean return always answered — was there an
   * agent here — and the class answers the one it could not: whether anything of
   * ours provably stopped speaking to the provider.
   * @param agentId - Agent identifier
   * @param options - The driving request's deadline, when there is one
   * @returns Whether an agent was found, and what its teardown observed
   */
  public async disposeAgent(agentId: string, options: AgentTeardownOptions = {}): Promise<AgentDisposalReport> {
    return this.registry.dispose(agentId, options);
  }

  /**
   * Get all active agents managed by this adapter.
   * @returns Active agent handles
   */
  public getActiveAgents(): Array<ActiveAgentHandle<TAgent>> {
    return Array.from(this.registry.values()).map(toActiveAgentHandle);
  }

  /**
   * Check if the adapter has been initialized.
   * @returns true if init() has been called successfully
   */
  public isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Project a registry entry onto the handle both public agent reads return.
 *
 * Shared so the single-agent and the list read cannot drift on which fields a
 * handle carries — the same reason the summary projection beside it is shared.
 * @param entry - Registry entry to project
 * @returns Handle exposing the agent and its registry-owned session metadata
 */
function toActiveAgentHandle<TAgent>(entry: {
  readonly agent: TAgent;
  readonly sessionId: string;
  readonly adapterSessionId: string | undefined;
}): ActiveAgentHandle<TAgent> {
  return { agent: entry.agent, sessionId: entry.sessionId, adapterSessionId: entry.adapterSessionId };
}
