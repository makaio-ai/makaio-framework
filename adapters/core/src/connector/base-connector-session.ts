import type { ScopedBus } from '@makaio/bus-core';

/**
 * Configuration for a connector session.
 * @typeParam TBus - Scoped bus type for adapter namespace
 */
export interface ConnectorSessionConfig<TBus extends ScopedBus<string> = ScopedBus<string>> {
  bus: TBus;
  adapterId: string;
  adapterName: string;
  cwd: string;
  model: string;
  env: Record<string, string>;
}

/**
 * Interface for turn-like objects that support pause/abort operations.
 * Allows base session class to work with different turn implementations.
 */
export interface PausableTurn {
  pause(): Promise<unknown>;
}

/**
 * Base abstract class for connector session implementations.
 *
 * Sessions manage SDK query lifecycle across multiple turns:
 * - SDK connection management
 * - Turn creation and coordination
 * - Session ID management
 *
 * Each adapter implements its own session subclass.
 * @typeParam TConfig - Configuration type extending ConnectorSessionConfig
 */
export abstract class BaseConnectorSession<TConfig extends ConnectorSessionConfig = ConnectorSessionConfig> {
  protected readonly config: TConfig;
  protected readonly bus: TConfig['bus'];
  protected sessionId?: string;
  protected currentTurn?: PausableTurn;

  public constructor(config: TConfig) {
    this.config = config;
    this.bus = config.bus;
  }

  /**
   * Abort the session and cleanup resources.
   * Pauses the current turn if one is active.
   */
  public async abort(): Promise<void> {
    await this.currentTurn?.pause();
  }

  /**
   * Send a message to the provider.
   * Not used - subclasses should implement processQueue instead.
   * @param _message - Unused message parameter
   * @param _options - Unused options parameter
   */
  public async sendMessage(_message: unknown, _options?: unknown): Promise<void> {
    throw new Error('Use processQueue instead');
  }

  /**
   * Get the adapter session ID.
   * @returns The session ID from the provider
   */
  public async getAdapterSessionId(): Promise<string> {
    return this.sessionId!;
  }
}
