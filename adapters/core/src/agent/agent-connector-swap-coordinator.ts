import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import type { ProviderContext } from '@makaio/contracts';
import type { AIAgentConnector } from '../connector/index.js';
import { AgentConnectorLifecycleManager, type ConnectorSwapCommitGuard } from './agent-connector-lifecycle-manager.js';
import { AgentProviderContextActivation } from './agent-provider-context-activation.js';
import { AgentRuntimeMutationBarrier } from './agent-runtime-mutation-barrier.js';
import type { AgentConnectorConfigOverrides } from './types.js';

/** Mutable agent config fields published after a connector replacement commits. */
interface AgentConnectorSwapRuntimeConfig {
  /** Refs-only provider selection used to build later connector generations. */
  providerContext?: ProviderContext;
  /** MCP session context used to build later connector generations. */
  mcpSessionContext?: AgentConnectorConfigOverrides['mcpSessionContext'];
  /** Resume target inherited by later connector generations (explicit `undefined` = fresh). */
  resumeAdapterSessionId?: string | undefined;
}

/** Own serialized connector replacement, account activation, and config publication. */
export class AgentConnectorSwapCoordinator<TBus extends ScopedBus<string>, TConnector extends AIAgentConnector<TBus>> {
  private readonly barrier = new AgentRuntimeMutationBarrier();

  /**
   * Create the connector-swap transaction coordinator.
   * @param globalBus - Host-local bus used for managed-account activation
   * @param lifecycleManager - Connector runtime lifecycle owner
   * @param runtimeConfig - Mutable config backing future connector generations
   */
  public constructor(
    private readonly globalBus: IMakaioBus,
    private readonly lifecycleManager: AgentConnectorLifecycleManager<TBus, TConnector>,
    private readonly runtimeConfig: AgentConnectorSwapRuntimeConfig,
  ) {}

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
   */
  public async swapConnector(
    configOverrides?: AgentConnectorConfigOverrides,
    beforeCommit?: ConnectorSwapCommitGuard,
  ): Promise<void> {
    await this.runExclusive(async () => {
      let activation: AgentProviderContextActivation | undefined;
      try {
        if (configOverrides?.providerContext !== undefined) {
          activation = await AgentProviderContextActivation.prepare(this.globalBus, configOverrides.providerContext);
        }
        await this.swapConnectorUnlocked(configOverrides, async () => {
          await beforeCommit?.();
          await activation?.commit();
        });
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
   * @param configOverrides - Connector construction overrides
   * @param beforeCommit - Final guard after initialization and before publication
   */
  public async swapConnectorUnlocked(
    configOverrides?: AgentConnectorConfigOverrides,
    beforeCommit?: ConnectorSwapCommitGuard,
  ): Promise<void> {
    const confirmedAdapterSessionId = await this.lifecycleManager.swapConnector(configOverrides, beforeCommit);
    if (configOverrides?.providerContext !== undefined) {
      this.runtimeConfig.providerContext = configOverrides.providerContext;
    }
    if (configOverrides?.mcpSessionContext !== undefined) {
      this.runtimeConfig.mcpSessionContext = configOverrides.mcpSessionContext;
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
      this.runtimeConfig.resumeAdapterSessionId =
        configOverrides.resumeAdapterSessionId === undefined
          ? undefined
          : (confirmedAdapterSessionId ?? configOverrides.resumeAdapterSessionId);
    }
  }
}
