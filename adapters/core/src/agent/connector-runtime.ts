import type { ScopedBus } from '@makaio/bus-core';
import type { MessageHandle } from '../message-handle/index.js';
import type { AIAgentConnector } from '../connector/index.js';
import type { BaseAgentConnectorConfig } from './types.js';
import {
  prepareAdapterAuthRuntime,
  type AdapterAuthRuntimePreparer,
  type AdapterAuthLeaseHandle,
  type BoundAdapterRuntimeConfig,
  type ResolvedAdapterRuntimeConfig,
} from '../config/adapter-auth-runtime.js';

/** Connector instance paired with its explicit client config lease. */
export interface ConnectorRuntimeHandle<TConnector extends Pick<AIAgentConnector, 'close'>> {
  /** Live connector instance. */
  readonly connector: TConnector;
  /** Lease whose lifetime exactly matches this connector. */
  readonly lease?: AdapterAuthLeaseHandle;
}

/** Inputs for rolling back partial agent initialization. */
export interface AgentInitializationRollbackOptions<TConnector extends Pick<AIAgentConnector, 'close'>> {
  /** Newly-created connector runtime. */
  readonly runtime: ConnectorRuntimeHandle<TConnector>;
  /** Handler cleanups registered before initialization failed. */
  readonly handlerCleanups: readonly (() => void)[];
  /** Failure that triggered rollback. */
  readonly primaryError: unknown;
  /** Agent identifier used in aggregate diagnostics. */
  readonly agentId: string;
}

/** Dependencies for creating one managed connector runtime. */
export interface CreateConnectorRuntimeOptions<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TConfig extends BaseAgentConnectorConfig<TBus> = BaseAgentConnectorConfig<TBus>,
> {
  /** Refs-only config emitted by the common adapter factory. */
  readonly config: BoundAdapterRuntimeConfig<TBus, TConfig>;
  /** Adapter connector constructor. */
  readonly connectorFactory: (config: ResolvedAdapterRuntimeConfig<TBus, TConfig>) => TConnector | Promise<TConnector>;
  /** Optional user-message callback attached only after auth preparation. */
  readonly onMessageSent?: (handle: MessageHandle) => void;
  /** Trusted host-local auth preparer; defaults to DirectChannel + client lease. */
  readonly prepareAuthRuntime?: AdapterAuthRuntimePreparer<TBus, TConfig>;
}

/**
 * Materialize normalized auth and create one connector with rollback ownership.
 * @param options - Refs-only config, connector factory, and optional callback
 * @returns Connector paired with the lease that must follow its lifecycle
 */
export async function createConnectorRuntime<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TConfig extends BaseAgentConnectorConfig<TBus>,
>(options: CreateConnectorRuntimeOptions<TBus, TConnector, TConfig>): Promise<ConnectorRuntimeHandle<TConnector>> {
  const prepared = await (options.prepareAuthRuntime ?? prepareAdapterAuthRuntime)(options.config);
  try {
    const connector = await options.connectorFactory({
      ...prepared.config,
      ...(options.onMessageSent !== undefined && { onMessageSent: options.onMessageSent }),
    });
    return { connector, ...(prepared.lease !== undefined && { lease: prepared.lease }) };
  } catch (error) {
    await releaseAfterFailure(
      prepared.lease,
      error,
      'Connector creation and client config lease rollback both failed.',
    );
    throw error;
  }
}

/**
 * Close a connector and always release its lease.
 *
 * Both failures remain observable as an AggregateError; a successful release
 * never hides a connector close failure, and a successful close never hides a
 * release failure.
 * @param runtime - Connector and explicit lease pair
 */
export async function closeConnectorRuntime<TConnector extends Pick<AIAgentConnector, 'close'>>(
  runtime: ConnectorRuntimeHandle<TConnector>,
): Promise<void> {
  let closeError: unknown;
  try {
    await runtime.connector.close();
  } catch (error) {
    closeError = error;
  }

  let releaseError: unknown;
  try {
    await runtime.lease?.release();
  } catch (error) {
    releaseError = error;
  }

  if (closeError !== undefined && releaseError !== undefined) {
    throw new AggregateError(
      [closeError, releaseError],
      'Connector close and client config lease release both failed.',
      { cause: closeError },
    );
  }
  if (closeError !== undefined) {
    throw closeError;
  }
  if (releaseError !== undefined) {
    throw releaseError;
  }
}

/**
 * Roll back partial handler setup and connector runtime ownership.
 * @param options - Connector runtime, registered handlers, and triggering failure
 * @returns Never; the triggering failure or aggregate rollback failure is rethrown
 */
export async function rollbackAgentInitialization<TConnector extends Pick<AIAgentConnector, 'close'>>(
  options: AgentInitializationRollbackOptions<TConnector>,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  for (const cleanup of options.handlerCleanups) {
    try {
      cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await closeConnectorRuntime(options.runtime);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [options.primaryError, ...cleanupErrors],
      `AIAgent ${options.agentId} initialization and rollback both failed.`,
      { cause: options.primaryError },
    );
  }
  throw options.primaryError;
}

/**
 * Roll back a created lease while preserving the triggering failure.
 * @param lease - Lease to release, when auth preparation created one
 * @param primaryError - Failure that triggered rollback
 * @param message - Aggregate diagnostic when rollback also fails
 */
async function releaseAfterFailure(
  lease: AdapterAuthLeaseHandle | undefined,
  primaryError: unknown,
  message: string,
): Promise<void> {
  if (lease === undefined) {
    return;
  }
  try {
    await lease.release();
  } catch (releaseError) {
    throw new AggregateError([primaryError, releaseError], message, { cause: primaryError });
  }
}
