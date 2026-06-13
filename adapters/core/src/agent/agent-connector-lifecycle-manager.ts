import type { ScopedBus } from '@makaio/bus-core';
import type { McpRuntimeSessionContext, McpSessionContext, ProviderContext, SystemPrompt } from '@makaio/contracts';
import type { LedgerSessionContext } from './session-tool-ledger.js';
import type { ConfigFactoryInput } from '../adapter/index.js';
import type { MessageHandle } from '../message-handle/index.js';
import type { AIAgentConnector } from '../connector/index.js';
import type { BaseAgentConnectorConfig } from './types.js';

/**
 * Dependencies for connector lifecycle management.
 */
export interface AgentConnectorLifecycleManagerConfig<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
> {
  /** Stable agent identifier (used for diagnostics). */
  agentId: string;
  /** Create config input for connector/config factories. */
  buildConfigInput: (
    overrides?: Partial<{
      cwd: string;
      model: string;
      providerContext: ProviderContext;
      adapterSessionId: string;
      resumeAdapterSessionId: string;
      mcpSessionContext: McpRuntimeSessionContext | McpSessionContext | LedgerSessionContext;
    }>,
  ) => ConfigFactoryInput<TBus>;
  /** Adapter config factory from AIAgent config. */
  configFactory: (input: ConfigFactoryInput<TBus>) => Promise<BaseAgentConnectorConfig<TBus> & { adapterId: string }>;
  /** Connector factory from AIAgent config. */
  connectorFactory: (
    config: BaseAgentConnectorConfig<TBus> & { adapterId: string },
  ) => Promise<TConnector> | TConnector;
  /** Build onMessageSent callback for connector creation. */
  createOnMessageSent: () => (handle: MessageHandle) => void;
  /** Wire adapter-specific events on a connector instance. */
  wireEvents: (connector: TConnector) => void | Promise<void>;
  /** Emit idle lifecycle event on processing-state idle transitions. */
  emitIdle: () => Promise<void>;
  /** Get current connector for swap guards/baseline values. */
  getConnector: () => TConnector;
  /** Replace active connector reference on successful swap. */
  setConnector: (connector: TConnector) => void;
  /** Get runtime system prompt to preserve across swaps. */
  getRuntimeSystemPrompt: () => SystemPrompt | undefined;
  /** Store latest adapter session ID for enrichment after swaps. */
  setLastKnownAdapterSessionId: (adapterSessionId: string | undefined) => void;
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
   */
  public async swapConnector(
    configOverrides?: Partial<{
      cwd: string;
      model: string;
      providerContext: ProviderContext;
      adapterSessionId: string;
      resumeAdapterSessionId: string;
      mcpSessionContext: McpRuntimeSessionContext | McpSessionContext | LedgerSessionContext;
    }>,
  ): Promise<void> {
    const currentConnector = this.config.getConnector();
    if (currentConnector.getProcessingState() !== 'idle') {
      throw new Error(`Cannot swap connector while processing (state: ${currentConnector.getProcessingState()})`);
    }

    const configInput = this.config.buildConfigInput({
      cwd: configOverrides?.cwd ?? currentConnector.cwd,
      model: configOverrides?.model ?? currentConnector.model,
      ...(configOverrides?.providerContext && { providerContext: configOverrides.providerContext }),
      ...(configOverrides?.mcpSessionContext && { mcpSessionContext: configOverrides.mcpSessionContext }),
      adapterSessionId: configOverrides?.adapterSessionId ?? crypto.randomUUID(),
      ...(configOverrides?.resumeAdapterSessionId !== undefined && {
        resumeAdapterSessionId: configOverrides.resumeAdapterSessionId,
      }),
    });

    const fullConfig = await this.config.configFactory(configInput);
    const newConnector = await this.config.connectorFactory({
      ...fullConfig,
      onMessageSent: this.config.createOnMessageSent(),
    });

    const oldWiringCleanups = this.connectorWiringCleanups;
    this.connectorWiringCleanups = [];

    try {
      await this.wireAllConnectorEvents(newConnector);
      await newConnector.initialize({
        systemPrompt: this.config.getRuntimeSystemPrompt(),
      });
    } catch (wiringError) {
      // newConnector.close() handles cleanup of partially-wired resources.
      // The new cleanups in this.connectorWiringCleanups are discarded (not run)
      // because the connector itself is being discarded. Old cleanups are
      // restored for the still-active previous connector.
      try {
        await newConnector.close();
      } catch (closeError) {
        console.warn(`[AIAgent] Failed to close newly-created connector for agent ${this.config.agentId}:`, closeError);
      }
      this.connectorWiringCleanups = oldWiringCleanups;
      throw wiringError;
    }

    this.config.setLastKnownAdapterSessionId(newConnector.adapterSessionId);
    for (const cleanup of oldWiringCleanups) {
      try {
        cleanup();
      } catch (error) {
        console.warn(
          `[AIAgent] Previous connector cleanup failed during swap for agent ${this.config.agentId}:`,
          error,
        );
      }
    }

    const oldConnector = currentConnector;
    this.config.setConnector(newConnector);

    try {
      await oldConnector.close();
    } catch (error) {
      console.warn(`[AIAgent] Failed to close previous connector for agent ${this.config.agentId}:`, error);
    }
  }
}
