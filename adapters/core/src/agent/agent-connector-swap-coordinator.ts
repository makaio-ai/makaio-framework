import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import type { ProviderContext } from '@makaio/contracts';
import type { AIAgentConnector } from '../connector/index.js';
import { AgentConnectorLifecycleManager, type ConnectorSwapCommitGuard } from './agent-connector-lifecycle-manager.js';
import { AgentProviderContextActivation } from './agent-provider-context-activation.js';
import { AgentRuntimeMutationBarrier } from './agent-runtime-mutation-barrier.js';
import { closeConnectorRuntime, type ConnectorRuntimeHandle } from './connector-runtime.js';
import type { AgentTeardownArbiter, ClosableConnectorRuntime } from './agent-teardown-arbiter.js';
import type { TeardownReport } from '../connector/teardown-report.js';
import type { AgentConnectorConfigOverrides } from './types.js';

/** Mutable agent config fields published after a connector replacement commits. */
interface AgentConnectorSwapRuntimeConfig {
  /** Refs-only provider selection used to build later connector generations. */
  providerContext?: ProviderContext;
  /** MCP session context used to build later connector generations. */
  mcpSessionContext?: AgentConnectorConfigOverrides['mcpSessionContext'];
}

/**
 * Sink for an explicit per-swap resume decision.
 *
 * Resume-target inheritance is movement-seam state, not a plain config field:
 * the decision carries both the session later generations inherit and whether
 * this agent inherits one at all. So the coordinator hands the decision to the
 * seam's owner instead of writing the config, which keeps the two halves from
 * drifting apart.
 * @param resumeAdapterSessionId - Session later generations inherit, or
 *   `undefined` to make them start fresh
 */
export type ResumeTargetDecisionSink = (resumeAdapterSessionId: string | undefined) => void;

/** Dependencies for the connector-replacement transaction coordinator. */
export interface AgentConnectorSwapCoordinatorConfig<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
> {
  /** Stable agent identifier, the key both arbitration maps are keyed by. */
  readonly agentId: string;
  /** Host-local bus used for managed-account activation. */
  readonly globalBus: IMakaioBus;
  /** Connector runtime lifecycle owner. */
  readonly lifecycleManager: AgentConnectorLifecycleManager<TBus, TConnector>;
  /** Mutable config backing future connector generations. */
  readonly runtimeConfig: AgentConnectorSwapRuntimeConfig;
  /** Sink applying an explicit resume decision. */
  readonly publishResumeTargetDecision: ResumeTargetDecisionSink;
  /**
   * Adapter-instance arbiter both acts consult.
   *
   * **Required**, so an agent whose replacements would bypass arbitration does
   * not compile. It is the smallest seam that lets the teardown side and the
   * admission side read one another's map without either owning the other.
   */
  readonly arbiter: AgentTeardownArbiter;
  /**
   * Whether the agent still holds a connector runtime.
   *
   * A non-throwing read on purpose: the door refuses a replacement for a
   * runtime-less agent *typed*, where the untyped alternative fails late — after
   * the producer's own effects — and is indistinguishable from a failure that
   * reached the provider.
   */
  readonly hasConnectorRuntime: () => boolean;
  /**
   * Take the agent's current runtime away from it, if it has one.
   *
   * Clearing the reference is part of taking it: the runtimes closed on the
   * abandoned-waiter path must not stay reachable through the agent afterwards,
   * for exactly the reason the ordinary teardown clears it before closing.
   */
  readonly detachConnectorRuntime: () => ConnectorRuntimeHandle<TConnector> | undefined;
  /**
   * Book what this replacement's own closes observed on the agent, because no
   * teardown took the settlement carrying it.
   *
   * The settlement is a channel to a *waiter*; without one it has no consumer, and
   * a weak-but-clean class — `detached`, the ordinary answer of a process connector
   * that signalled a kill it did not see land — would simply be discarded. The
   * agent keeps living, so the agent is who is still answerable: its later
   * `close()` aggregates what is booked here instead of claiming its own runtime's
   * class alone.
   * @param reports - Reports of every close this replacement performed itself
   */
  readonly recordUnreportedCloseReports: (reports: readonly TeardownReport[]) => void;
}

/** Own serialized connector replacement, account activation, and config publication. */
export class AgentConnectorSwapCoordinator<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>> {
  private readonly barrier = new AgentRuntimeMutationBarrier();

  /**
   * Create the connector-swap transaction coordinator.
   * @param config - Lifecycle owner, arbiter, runtime reads and publication sinks
   */
  public constructor(private readonly config: AgentConnectorSwapCoordinatorConfig<TBus, TConnector>) {}

  /**
   * Run one connector-affecting operation through the shared agent barrier.
   * @param action - Complete mutation or turn-dispatch transaction
   * @returns Action result
   */
  public runExclusive<T>(action: () => Promise<T>): Promise<T> {
    return this.barrier.runExclusive(action);
  }

  /**
   * Atomically activate an optional managed account and replace the connector.
   * @param configOverrides - Connector construction overrides
   * @param beforeCommit - Optional caller guard before account commit and publication
   * @param settledByCaller - Whether the caller settles the replacement's currency itself
   */
  public async swapConnector(
    configOverrides?: AgentConnectorConfigOverrides,
    beforeCommit?: ConnectorSwapCommitGuard,
    settledByCaller = false,
  ): Promise<void> {
    await this.runExclusive(async () => {
      let activation: AgentProviderContextActivation | undefined;
      try {
        if (configOverrides?.providerContext !== undefined) {
          activation = await AgentProviderContextActivation.prepare(
            this.config.globalBus,
            configOverrides.providerContext,
          );
        }
        await this.swapConnectorUnlocked(
          configOverrides,
          async () => {
            await beforeCommit?.();
            await activation?.commit();
          },
          settledByCaller,
        );
      } catch (error) {
        if (activation !== undefined) {
          try {
            await activation.rollbackPending();
          } catch (rollbackError) {
            const sanitizedPrimary = new Error('Public connector replacement failed.');
            throw new AggregateError(
              [sanitizedPrimary, rollbackError],
              'Connector replacement and account activation rollback both failed.',
              { cause: sanitizedPrimary },
            );
          }
        }
        throw error;
      }
    });
  }

  /**
   * Replace and publish a connector while the caller already owns the barrier.
   *
   * **This is the door**, and every connector replacement in the system passes
   * through it: the lifecycle manager below is the sole replacement mechanism and
   * this is its sole caller, so the seam is a place that already exists and is
   * already mandatory rather than a value producers must remember to carry.
   *
   * The prologue is synchronous and has no await between its steps, which is what
   * makes the arbitration exhaustive — a teardown is either installed before this
   * instant or it is not. The waited region that follows contains no
   * human-interactive step and no second lock, which is why admitting *here*
   * rather than before a producer's first effect matters: a model-change
   * confirmation dialog would otherwise sit inside the region a teardown waits on,
   * and no discipline fixes a stop that blocks until somebody answers a modal.
   *
   * Settling in this function's own `finally` is equally load-bearing: a producer
   * that throws after admission still settles, so a teardown already waiting does
   * not wait out its whole bound for a replacement that is over.
   * @param configOverrides - Connector construction overrides
   * @param beforeCommit - Final guard after initialization and before publication
   * @param settledByCaller - Whether the caller settles the replacement's currency itself
   * @throws ConnectorSwapVetoedError When a teardown is in flight, or the agent
   *   holds no runtime to replace
   */
  public async swapConnectorUnlocked(
    configOverrides?: AgentConnectorConfigOverrides,
    beforeCommit?: ConnectorSwapCommitGuard,
    settledByCaller = false,
  ): Promise<void> {
    const admission = this.config.arbiter.admitSwap(this.config.agentId, this.config.hasConnectorRuntime);
    const unclosed: ClosableConnectorRuntime[] = [];
    const closeReports: TeardownReport[] = [];
    let outcome: 'committed' | 'rolled-back' = 'rolled-back';
    try {
      const confirmedAdapterSessionId = await this.config.lifecycleManager.swapConnector(
        configOverrides,
        beforeCommit,
        settledByCaller,
        // **One rule, one place.** Every close this replacement performs is
        // reported to a waiting teardown, and the report is also what decides
        // whether the handle still needs closing — so the "could not prove closed"
        // test lives here once instead of at each of the two sites that close.
        (report, runtime) => {
          closeReports.push(report);
          if (report.closeError !== undefined) unclosed.push(runtime);
        },
      );
      // Committed the moment the replacement is published; the publications that
      // follow cannot un-publish it, so they must not be able to report otherwise.
      outcome = 'committed';
      this.publishRuntimeConfig(configOverrides, confirmedAdapterSessionId);
    } finally {
      const handover = admission.settle({ outcome, unclosed, closeReports });
      try {
        // **A report nobody took is not a report that may be dropped.** The
        // settlement carries these closes to a waiting teardown; with no waiter, or
        // with one that gave up, the classes have no consumer — and a weak one that
        // failed nothing appears in neither `unclosed` nor any error channel, so
        // discarding it would let this agent's next close answer more strongly than
        // its own replacement proved. Booking is the same move I33 makes for a
        // generation whose end nobody could wait for, one layer up.
        if (!handover.reportsConsumedByWaiter) this.config.recordUnreportedCloseReports(closeReports);
        if (handover.abandonedByWaiter) {
          await this.closeRuntimesForAbandonedWaiter(unclosed);
        }
      } finally {
        admission.retire();
      }
    }
  }

  /**
   * Publish the committed replacement's config fields and resume decision.
   * @param configOverrides - Overrides this replacement was built from
   * @param confirmedAdapterSessionId - Provider session the replacement confirmed
   */
  private publishRuntimeConfig(
    configOverrides: AgentConnectorConfigOverrides | undefined,
    confirmedAdapterSessionId: string | undefined,
  ): void {
    if (configOverrides?.providerContext !== undefined) {
      this.config.runtimeConfig.providerContext = configOverrides.providerContext;
    }
    if (configOverrides?.mcpSessionContext !== undefined) {
      this.config.runtimeConfig.mcpSessionContext = configOverrides.mcpSessionContext;
    }
    // Publish an explicit resume decision before the barrier releases the
    // next queued swap (one-shot discipline, like nativeFork): later swaps
    // that omit the key must inherit this decision instead of resurrecting a
    // consumed start-time resume target — a fresh rehydrate stays fresh
    // across queued model/cwd/credential swaps under any interleaving.
    // A resumed swap publishes the provider-confirmed identity when it
    // diverges from the requested target (providers may rotate the session
    // ID on resume) so the next inherited generation continues the live
    // conversation, not the abandoned one.
    if (configOverrides !== undefined && 'resumeAdapterSessionId' in configOverrides) {
      this.config.publishResumeTargetDecision(
        configOverrides.resumeAdapterSessionId === undefined
          ? undefined
          : (confirmedAdapterSessionId ?? configOverrides.resumeAdapterSessionId),
      );
    }
  }

  /**
   * Close both runtimes because the teardown waiting on this replacement gave up.
   *
   * Region two's loser-obligation, applied to the case where the winner outlived
   * the waiter: the party that was going to close the survivor is gone, so this
   * replacement closes the runtime it would otherwise have handed over — plus
   * anything it could not prove closed on its own. Every step is best-effort and
   * the classification is the result; there is nobody left to report it to.
   *
   * **It inherited an agent's end and not merely two runtimes, and the two halves
   * of that end come down at the two points they become free.** The stable
   * `agent.*` handlers are already gone: the teardown this replacement outlived
   * released them at its expiry, because the identity it dropped the registry entry
   * for was claimable from that instant and waiting for this settlement would have
   * left a successor answering beside a stale handler. What is left here is the
   * connector wiring of the runtimes below, cleared **before** the closes so
   * nothing can be admitted onto a runtime this method is already taking apart.
   * @param unclosed - Runtimes this replacement could not prove closed
   */
  private async closeRuntimesForAbandonedWaiter(unclosed: readonly ClosableConnectorRuntime[]): Promise<void> {
    this.config.lifecycleManager.clearConnectorWiring();
    const survivor = this.config.detachConnectorRuntime();
    for (const runtime of survivor === undefined ? unclosed : [survivor, ...unclosed]) {
      const report = await closeConnectorRuntime(runtime);
      if (report.closeError !== undefined) {
        console.warn(
          `[AIAgent] Agent ${this.config.agentId} connector replacement inherited a teardown's runtimes and could not close one:`,
          report.closeError,
        );
      }
    }
  }
}
