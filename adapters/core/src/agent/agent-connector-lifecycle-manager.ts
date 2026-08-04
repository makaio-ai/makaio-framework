import type { ScopedBus } from '@makaio/bus-core';
import type { SystemPrompt } from '@makaio/contracts';
import type { AgentConnectorConfigOverrides } from './types.js';
import type { ConfigFactoryInput } from '../adapter/index.js';
import type { MessageHandle } from '../message-handle/index.js';
import type { AIAgentConnector } from '../connector/index.js';
import type { BaseAgentConnectorConfig } from './types.js';
import { closeConnectorRuntime, createConnectorRuntime, type ConnectorRuntimeHandle } from './connector-runtime.js';
import type { AdapterAuthRuntimePreparer } from '../config/adapter-auth-runtime.js';

/** Sanitized lifecycle diagnostic emitted after a replacement became primary. */
export interface ConnectorCleanupDiagnostic {
  /** Stable machine-readable failure category. */
  readonly code: 'previous-connector-cleanup-failed';
  /** Lifecycle stage whose cleanup failed. */
  readonly stage: 'swap-old-runtime';
  /** Agent owning the replacement connector. */
  readonly agentId: string;
}

/** Final async guard run after the replacement is ready but before it becomes primary. */
export type ConnectorSwapCommitGuard = () => void | Promise<void>;

/**
 * Dependencies for connector lifecycle management.
 */
/**
 * Where a swap publishes the provider session its replacement confirmed.
 *
 * May be asynchronous: the sink also announces the movement, which the swap
 * awaits before publishing the replacement runtime. `settledByCaller` is the
 * one case with nothing to announce — the swap's caller writes that movement's
 * durable currency itself, so the sink records the identity and stays silent.
 *
 * **Named rather than written out at each site**, because it is written out at
 * three: a site that redeclares it with one parameter still accepts the
 * two-parameter sink, and the flag would then be dropped by a later wrapper
 * with no type error and no symptom but a second settle producer.
 */
export type AdapterSessionPublicationSink = (
  adapterSessionId: string | undefined,
  settledByCaller?: boolean,
) => void | Promise<void>;

export interface AgentConnectorLifecycleManagerConfig<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
> {
  /** Stable agent identifier (used for diagnostics). */
  agentId: string;
  /** Create config input for connector/config factories. */
  buildConfigInput: (overrides?: AgentConnectorConfigOverrides) => ConfigFactoryInput<TBus>;
  /** Adapter config factory from AIAgent config. */
  configFactory: (input: ConfigFactoryInput<TBus>) => Promise<BaseAgentConnectorConfig<TBus> & { adapterId: string }>;
  /** Connector factory from AIAgent config. */
  connectorFactory: (
    config: BaseAgentConnectorConfig<TBus> & { adapterId: string },
  ) => Promise<TConnector> | TConnector;
  /** Trusted host-local auth preparer shared by every connector generation. */
  prepareAuthRuntime?: AdapterAuthRuntimePreparer<TBus>;
  /** Build onMessageSent callback for connector creation. */
  createOnMessageSent: () => (handle: MessageHandle) => void;
  /**
   * Sink for provider-session rotations a connector performs on its own.
   *
   * Handed to every connector generation, not just the first: a replacement
   * connector rotates on the same in-flight decisions the original does, and a
   * generation created without the sink would leave the session row advertising
   * the thread it abandoned.
   */
  announceAdapterSessionMoved: () => Promise<void>;
  /** Wire adapter-specific events on a connector instance. */
  wireEvents: (connector: TConnector) => void | Promise<void>;
  /** Emit idle lifecycle event on processing-state idle transitions. */
  emitIdle: () => Promise<void>;
  /** Get current connector plus its explicit client config lease. */
  getConnectorRuntime: () => ConnectorRuntimeHandle<TConnector>;
  /** Replace active connector and lease together on successful swap. */
  setConnectorRuntime: (runtime: ConnectorRuntimeHandle<TConnector>) => void;
  /** Get runtime system prompt to preserve across swaps. */
  getRuntimeSystemPrompt: () => SystemPrompt | undefined;
  /**
   * Store latest adapter session ID for enrichment after swaps.
   *
   * May be asynchronous: the sink also announces the swap as a provider-session
   * movement, which the swap awaits before publishing the replacement runtime —
   * unless the swap's caller settles that movement's currency itself, which it
   * says with `settledByCaller` and the sink then records without announcing.
   */
  setLastKnownAdapterSessionId: (
    adapterSessionId: string | undefined,
    settledByCaller?: boolean,
  ) => void | Promise<void>;
  /** Publish a sanitized cleanup diagnostic without exposing connector errors. */
  reportCleanupFailure: (diagnostic: ConnectorCleanupDiagnostic) => void | Promise<void>;
}

/**
 * Manages connector lifecycle for AIAgent.
 *
 * Owns per-connector wiring cleanup registration and swap lifecycle choreography.
 */
export class AgentConnectorLifecycleManager<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>> {
  /** Cleanup functions for connector event wiring (cleared on each connector swap) */
  private connectorWiringCleanups: Array<() => void> = [];

  private readonly config: AgentConnectorLifecycleManagerConfig<TBus, TConnector>;

  public constructor(config: AgentConnectorLifecycleManagerConfig<TBus, TConnector>) {
    this.config = config;
  }

  /**
   * Register a cleanup function for connector wiring.
   * @param cleanup - Cleanup function to register
   */
  public addConnectorWiringCleanup(cleanup: () => void): void {
    this.connectorWiringCleanups.push(cleanup);
  }

  /**
   * Clear connector wiring cleanups.
   */
  public clearConnectorWiring(): void {
    for (const cleanup of this.connectorWiringCleanups) {
      try {
        cleanup();
      } catch (error) {
        console.warn(`[AIAgent] Connector wiring cleanup failed for agent ${this.config.agentId}:`, error);
      }
    }
    this.connectorWiringCleanups = [];
  }

  /**
   * Wire base and adapter-specific connector events.
   * @param connector - Connector instance to wire
   */
  public async wireAllConnectorEvents(connector: TConnector): Promise<void> {
    const unsubProcessingState = connector.onProcessingStateChanged((state) => {
      if (state === 'idle') {
        this.config.emitIdle().catch((error) => {
          console.warn(`[AIAgent] Failed to emit idle for agent ${this.config.agentId}:`, error);
        });
      }
    });
    this.addConnectorWiringCleanup(unsubProcessingState);

    await this.config.wireEvents(connector);
  }

  /**
   * Replace the active connector with a fresh instance.
   *
   * Uses create-before-close pattern with rollback to preserve availability.
   * @param configOverrides - Optional runtime override fields
   * @param beforeCommit - Final guard after replacement initialization and before publication
   * @param settledByCaller - Whether the caller writes the replacement's durable
   *   currency itself, in which case the confirmed identity is recorded without
   *   being announced as a movement
   * @returns The replacement's provider-confirmed session ID, when it has one
   */
  public async swapConnector(
    configOverrides?: AgentConnectorConfigOverrides,
    beforeCommit?: ConnectorSwapCommitGuard,
    settledByCaller = false,
  ): Promise<string | undefined> {
    const currentRuntime = this.config.getConnectorRuntime();
    const currentConnector = currentRuntime.connector;
    if (currentConnector.getProcessingState() !== 'idle') {
      throw new Error(`Cannot swap connector while processing (state: ${currentConnector.getProcessingState()})`);
    }
    const newRuntime = await this.createReplacementRuntime(currentConnector, configOverrides);
    const oldWiringCleanups = this.connectorWiringCleanups;
    this.connectorWiringCleanups = [];
    const confirmedAdapterSessionId = await this.initializeReplacement(newRuntime, oldWiringCleanups, beforeCommit);

    // Publication is non-failing after the final commit guard, and it happens in
    // this order: **the identity is recorded before the replacement becomes
    // reachable.** Recording is awaited rather than fired off because it
    // announces the provider-session movement, and the seam's second duty is
    // that a producer orders an acknowledged announcement ahead of whatever
    // depends on it — here, the connector a concurrent resume can reach. The
    // other order published a connector whose provider session the session row
    // did not name yet. Nothing in recording reads the published runtime: the
    // tracker announces from the agent's stable identity and caches from the
    // value passed in. A caller that settles that currency itself is the one
    // case with nothing to announce — the ordering it needs is its own, and it
    // takes it after the swap returns.
    if (confirmedAdapterSessionId !== undefined) {
      await this.config.setLastKnownAdapterSessionId(confirmedAdapterSessionId, settledByCaller);
    }
    this.config.setConnectorRuntime(newRuntime);
    this.runWiringCleanups(oldWiringCleanups);
    await this.closePreviousRuntime(currentRuntime);
    return confirmedAdapterSessionId;
  }

  /**
   * Build and materialize the replacement connector runtime.
   * @param currentConnector - Active connector whose runtime values provide defaults
   * @param configOverrides - Optional requested runtime changes
   * @returns Prepared replacement connector and auth lease
   */
  private async createReplacementRuntime(
    currentConnector: TConnector,
    configOverrides: AgentConnectorConfigOverrides | undefined,
  ): Promise<ConnectorRuntimeHandle<TConnector>> {
    const configInput = this.config.buildConfigInput({
      cwd: configOverrides?.cwd ?? currentConnector.cwd,
      model: configOverrides?.model ?? currentConnector.model,
      ...(configOverrides?.providerContext && { providerContext: configOverrides.providerContext }),
      ...(configOverrides?.mcpSessionContext && { mcpSessionContext: configOverrides.mcpSessionContext }),
      ...(configOverrides !== undefined &&
        'reasoningEffort' in configOverrides && { reasoningEffort: configOverrides.reasoningEffort }),
      adapterSessionId: configOverrides?.adapterSessionId ?? crypto.randomUUID(),
      ...(configOverrides !== undefined &&
        'resumeAdapterSessionId' in configOverrides && {
          resumeAdapterSessionId: configOverrides.resumeAdapterSessionId,
        }),
    });

    const fullConfig = await this.config.configFactory(configInput);
    return createConnectorRuntime({
      config: fullConfig,
      connectorFactory: this.config.connectorFactory,
      onMessageSent: this.config.createOnMessageSent(),
      onAdapterSessionMoved: this.config.announceAdapterSessionMoved,
      prepareAuthRuntime: this.config.prepareAuthRuntime,
    });
  }

  /**
   * Wire and initialize a replacement, restoring the current wiring on failure.
   * @param newRuntime - Replacement connector and auth lease
   * @param oldWiringCleanups - Wiring still owned by the active connector
   * @param beforeCommit - Optional final publication guard
   * @returns Provider-confirmed session ID, when the replacement has one
   */
  private async initializeReplacement(
    newRuntime: ConnectorRuntimeHandle<TConnector>,
    oldWiringCleanups: Array<() => void>,
    beforeCommit: ConnectorSwapCommitGuard | undefined,
  ): Promise<string | undefined> {
    try {
      await this.wireAllConnectorEvents(newRuntime.connector);
      await newRuntime.connector.initialize({
        systemPrompt: this.config.getRuntimeSystemPrompt(),
      });
      // Resolve provider-owned metadata before the commit guard. Once the guard
      // commits an account activation, the only remaining state transition must
      // be the synchronous publication of this ready runtime.
      const confirmedAdapterSessionId = newRuntime.connector.getConfirmedAdapterSessionId();
      await beforeCommit?.();
      return confirmedAdapterSessionId;
    } catch (wiringError) {
      // Managed close handles partially-wired resources and the auth lease.
      // Run replacement wiring cleanups before restoring the still-active
      // previous connector's registrations; connector.close() cannot own
      // arbitrary external subscriptions installed by wireEvents().
      this.clearConnectorWiring();
      this.connectorWiringCleanups = oldWiringCleanups;
      try {
        await closeConnectorRuntime(newRuntime);
      } catch (cleanupError) {
        throw new AggregateError(
          [wiringError, cleanupError],
          `Connector setup and rollback both failed for agent ${this.config.agentId}.`,
          { cause: wiringError },
        );
      }
      throw wiringError;
    }
  }

  /**
   * Run superseded connector wiring cleanups without failing the committed swap.
   * @param cleanups - Previous connector wiring cleanups
   */
  private runWiringCleanups(cleanups: readonly (() => void)[]): void {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        console.warn(
          `[AIAgent] Previous connector cleanup failed during swap for agent ${this.config.agentId}:`,
          error,
        );
      }
    }
  }

  /**
   * Close the superseded runtime and publish only a sanitized diagnostic on failure.
   * @param currentRuntime - Superseded connector and auth lease
   */
  private async closePreviousRuntime(currentRuntime: ConnectorRuntimeHandle<TConnector>): Promise<void> {
    try {
      await closeConnectorRuntime(currentRuntime);
    } catch {
      const diagnostic: ConnectorCleanupDiagnostic = {
        code: 'previous-connector-cleanup-failed',
        stage: 'swap-old-runtime',
        agentId: this.config.agentId,
      };
      try {
        await this.config.reportCleanupFailure(diagnostic);
      } catch {
        console.warn(
          `[AIAgent] ${diagnostic.code} for agent ${diagnostic.agentId}; cleanup diagnostic delivery also failed.`,
        );
      }
    }
  }
}
