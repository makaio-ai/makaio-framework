import type { ScopedBus } from '@makaio/bus-core';
import type { SystemPrompt } from '@makaio/contracts';
import type { AgentConnectorConfigOverrides } from './types.js';
import type { ConfigFactoryInput } from '../adapter/index.js';
import type { MessageHandle } from '../message-handle/index.js';
import type { AIAgentConnector } from '../connector/index.js';
import type { BaseAgentConnectorConfig } from './types.js';
import { closeConnectorRuntime, createConnectorRuntime, type ConnectorRuntimeHandle } from './connector-runtime.js';
import type { TeardownReport } from '../connector/teardown-report.js';
import type { AdapterAuthRuntimePreparer } from '../config/adapter-auth-runtime.js';
import { runBestEffortCleanups } from '../utils/runBestEffortCleanups.js';

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
 * Sink for what a close this swap performed itself observed.
 *
 * Every step of a swap's cleanup still swallows — that discipline is what keeps a
 * committed replacement reachable when the superseded runtime's close fails — but
 * swallowing is not the same as forgetting, and **a close that did not fail is
 * still not a close that proved anything.** Both arms can leave a second runtime
 * running (a committed swap whose previous-runtime close fails, a rolled-back swap
 * whose replacement close fails) *and* both arms can close a runtime under a class
 * weaker than observed — `detached` is the ordinary answer of a process connector
 * that signalled a kill it did not see land. A swap that reported only its
 * failures would hand a waiting teardown the failures and keep the weak classes,
 * and the teardown would then aggregate nothing weak and answer stronger than the
 * evidence supports.
 *
 * So the sink carries the **report** of every close, and the handle beside it for
 * the one decision the report also settles: whether anybody still has to close
 * this runtime. Reporting adds consumers for both facts and removes none of the
 * routes either one already takes.
 * @param report - What this close observed, including the failure that capped it
 * @param runtime - Runtime this close was for
 */
export type SwapRuntimeCloseSink<TConnector extends Pick<AIAgentConnector, 'close'>> = (
  report: TeardownReport,
  runtime: ConnectorRuntimeHandle<TConnector>,
) => void;

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
 * Owns swap lifecycle choreography and **both** subscription lifetimes an agent
 * has: the per-connector wiring a swap replaces, and the stable bus handlers that
 * survive every swap. One owner, because a swap must clear exactly one of the two
 * and an agent's end must clear both — invariants that are easier to keep true
 * where both lists are visible than where one of them lives a layer away.
 */
export class AgentConnectorLifecycleManager<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>> {
  /** Cleanup functions for connector event wiring (cleared on each connector swap) */
  private connectorWiringCleanups: Array<() => void> = [];

  /** Cleanup functions for the agent's stable bus subscriptions (survive swaps) */
  private busHandlerCleanups: Array<() => void> = [];

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
    runBestEffortCleanups(this.connectorWiringCleanups, `Connector wiring for agent ${this.config.agentId}`);
    this.connectorWiringCleanups = [];
  }

  /**
   * Register cleanups for subscriptions that outlive every connector generation.
   * @param cleanups - Unsubscribe functions for the agent's stable bus handlers
   */
  public addBusHandlerCleanups(...cleanups: Array<() => void>): void {
    this.busHandlerCleanups.push(...cleanups);
  }

  /**
   * Take both subscription lifetimes out of service, handing the stable
   * cleanups back unrun.
   *
   * For the failed-`init()` rollback, which aggregates every cleanup failure into
   * the initialization error and therefore has to run them itself. Everything is
   * detached synchronously, so no event can arrive between the two lists.
   * @returns The stable bus-handler cleanups, for the caller to run
   */
  public detachWiring(): Array<() => void> {
    const handlerCleanups = this.takeBusHandlerCleanups();
    this.clearConnectorWiring();
    return handlerCleanups;
  }

  /**
   * Take the stable cleanups off the list, so a second release runs none of them.
   *
   * Idempotence lives here rather than in each caller: both release paths reach
   * this, and the abandoned-handover path can be reached after `AIAgent.close()`
   * already ran on the same agent.
   * @returns The stable bus-handler cleanups, now owned by the caller
   */
  private takeBusHandlerCleanups(): Array<() => void> {
    const handlerCleanups = this.busHandlerCleanups;
    this.busHandlerCleanups = [];
    return handlerCleanups;
  }

  /**
   * Take the stable subscriptions out of service, best-effort, leaving the
   * connector wiring alone.
   *
   * **The half that gives an identity up**, and it is separable from every close:
   * an agent whose stable handlers are gone cannot answer for an identity another
   * agent may re-claim, whatever still happens to its runtimes. That is why the
   * teardown that abandons its wait on a connector replacement runs *this* at the
   * expiry rather than the whole of {@link releaseWiring}: the replacement is
   * still running and its connector wiring is still its own, but the agent has
   * already stopped being the instance that answers.
   */
  public releaseBusHandlers(): void {
    runBestEffortCleanups(this.takeBusHandlerCleanups(), 'Bus handler');
  }

  /**
   * Take both subscription lifetimes out of service, best-effort.
   *
   * The agent's end, minus the runtime close and minus any claim about the
   * conversation. Called by `AIAgent.close()`; the connector replacement that
   * inherited a teardown's obligations releases the two halves at the two points
   * they actually become free instead — the handlers at the abandoning teardown's
   * expiry, the connector wiring when it takes the runtime apart.
   */
  public releaseWiring(): void {
    runBestEffortCleanups(this.detachWiring(), 'Bus handler');
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
   * @param onRuntimeClose - Sink for every close this swap performs itself, on
   *   either arm; the arbitration door passes it down so a waiting teardown can
   *   finish what this swap could not close and cannot claim more than what it
   *   observed
   * @returns The replacement's provider-confirmed session ID, when it has one
   */
  public async swapConnector(
    configOverrides?: AgentConnectorConfigOverrides,
    beforeCommit?: ConnectorSwapCommitGuard,
    settledByCaller = false,
    onRuntimeClose?: SwapRuntimeCloseSink<TConnector>,
  ): Promise<string | undefined> {
    const currentRuntime = this.config.getConnectorRuntime();
    const currentConnector = currentRuntime.connector;
    if (currentConnector.getProcessingState() !== 'idle') {
      throw new Error(`Cannot swap connector while processing (state: ${currentConnector.getProcessingState()})`);
    }
    const newRuntime = await this.createReplacementRuntime(currentConnector, configOverrides);
    const oldWiringCleanups = this.connectorWiringCleanups;
    this.connectorWiringCleanups = [];
    const confirmedAdapterSessionId = await this.initializeReplacement(
      newRuntime,
      oldWiringCleanups,
      beforeCommit,
      onRuntimeClose,
    );

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
    await this.closePreviousRuntime(currentRuntime, onRuntimeClose);
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
   * @param onRuntimeClose - Sink for what the rollback's close of the replacement
   *   observed
   * @returns Provider-confirmed session ID, when the replacement has one
   */
  private async initializeReplacement(
    newRuntime: ConnectorRuntimeHandle<TConnector>,
    oldWiringCleanups: Array<() => void>,
    beforeCommit: ConnectorSwapCommitGuard | undefined,
    onRuntimeClose: SwapRuntimeCloseSink<TConnector> | undefined,
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
      const cleanupReport = await closeConnectorRuntime(newRuntime);
      // Reported whatever it says: a failure means the replacement's connector and
      // lease are unaccounted for and the handle travels to whoever may still be
      // answerable for it, and a weak-but-clean class means nobody downstream may
      // claim a stronger one. The producer's own aggregate below keeps the exact
      // route it has today.
      onRuntimeClose?.(cleanupReport, newRuntime);
      if (cleanupReport.closeError !== undefined) {
        throw new AggregateError(
          [wiringError, cleanupReport.closeError],
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
    runBestEffortCleanups(cleanups, `Superseded connector wiring for agent ${this.config.agentId}`);
  }

  /**
   * Close the superseded runtime, report what that close observed, and publish
   * only a sanitized diagnostic on failure.
   *
   * The swallow is deliberate and unchanged: a committed replacement must stay
   * reachable even when the runtime it superseded refuses to die. What changes is
   * that the outcome is now also *named* — and named on **every** exit, not only
   * the failing one. A teardown told "the replacement is current" and nothing else
   * would leave whatever this close failed to close still holding its connector and
   * its lease; a teardown told only about *failures* would additionally treat a
   * clean-but-weak class as clean, and answer for the agent more strongly than the
   * superseded runtime ever allowed.
   * @param currentRuntime - Superseded connector and auth lease
   * @param onRuntimeClose - Sink for what this close observed
   */
  private async closePreviousRuntime(
    currentRuntime: ConnectorRuntimeHandle<TConnector>,
    onRuntimeClose: SwapRuntimeCloseSink<TConnector> | undefined,
  ): Promise<void> {
    const report = await closeConnectorRuntime(currentRuntime);
    onRuntimeClose?.(report, currentRuntime);
    if (report.closeError === undefined) return;
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
