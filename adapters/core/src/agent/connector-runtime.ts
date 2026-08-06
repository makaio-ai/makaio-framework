import type { ScopedBus } from '@makaio/bus-core';
import type { ConnectorTeardownResult } from '@makaio/contracts';
import type { MessageHandle } from '../message-handle/index.js';
import type { AIAgentConnector } from '../connector/index.js';
import type { TeardownReport } from '../connector/teardown-report.js';
import { describeTeardownFailure } from '../connector/teardown-observation.js';
import { unknownTeardown } from '../connector/teardown-report.js';
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
  /** Sink for connector-owned provider-session rotations; see `BaseAgentConnectorConfig`. */
  readonly onAdapterSessionMoved?: () => Promise<void>;
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
      ...(options.onAdapterSessionMoved !== undefined && { onAdapterSessionMoved: options.onAdapterSessionMoved }),
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
 * Close a connector, always release its lease, and report what was observed.
 *
 * The lowest of the reporting layers, and the only one that converts. Two
 * conversions live here and nowhere else — and neither of them invents a class
 * for a connector that declined to declare one, because the contract no longer
 * lets a connector decline:
 *
 * - **A thrown close is `unknown`.** An implementation may fail without catching
 *   its own failure, so the caller — not the implementation — is where a throw
 *   becomes a class. The failure travels on so eviction can still rethrow it.
 * - **A failed lease release downgrades to `unknown`.** The lease is a resource
 *   *this* runtime held, so failing to give it back means this teardown is not
 *   provably complete, whatever the connector observed.
 *
 * Both failures stay observable in the aggregated `closeError`; neither hides the
 * other. This function no longer rejects — a teardown reports, and a caller that
 * has to interpret an exception to learn a class is a caller that will guess.
 * @param runtime - Connector and explicit lease pair
 * @returns The class this teardown may claim, with the failure that capped it
 */
export async function closeConnectorRuntime<TConnector extends Pick<AIAgentConnector, 'close'>>(
  runtime: ConnectorRuntimeHandle<TConnector>,
): Promise<TeardownReport> {
  // One discriminated outcome rather than a result and an error that a reader —
  // and the compiler — has to keep in step: the close either reported a class or
  // failed, and nothing else is representable.
  let close: { readonly reported: ConnectorTeardownResult } | { readonly failed: unknown };
  try {
    close = { reported: await runtime.connector.close() };
  } catch (error) {
    close = { failed: error };
  }

  let releaseError: unknown;
  try {
    await runtime.lease?.release();
  } catch (error) {
    releaseError = error;
  }

  if ('failed' in close) {
    if (releaseError !== undefined) {
      return unknownTeardown(
        'Connector close and client config lease release both failed.',
        new AggregateError(
          [close.failed, releaseError],
          'Connector close and client config lease release both failed.',
          { cause: close.failed },
        ),
      );
    }
    return unknownTeardown(`Connector close failed: ${describeTeardownFailure(close.failed)}`, close.failed);
  }
  if (releaseError !== undefined) {
    return unknownTeardown(
      `Client config lease release failed: ${describeTeardownFailure(releaseError)}`,
      releaseError,
    );
  }
  return close.reported;
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
  // The runtime close reports instead of throwing, so the rollback reads the
  // failure out of the report rather than catching it. A weak-but-not-failed
  // class is deliberately not aggregated: `detached` means the handle is gone
  // and there is nothing for the caller to compensate.
  const closeReport = await closeConnectorRuntime(options.runtime);
  if (closeReport.closeError !== undefined) {
    cleanupErrors.push(closeReport.closeError);
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
