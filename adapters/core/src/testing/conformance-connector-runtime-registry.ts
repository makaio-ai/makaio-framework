import type { ScopedBus } from '@makaio/bus-core';
import type { AIAgentConnector } from '../connector/index.js';
import type { BaseAgentConnectorConfig } from '../agent/types.js';
import {
  closeConnectorRuntime,
  createConnectorRuntime,
  type CreateConnectorRuntimeOptions,
} from '../agent/connector-runtime.js';
import type { TeardownReport } from '../connector/teardown-report.js';

/** Managed connector close operation retained by a conformance config. */
interface ManagedConnectorRuntime<TConnector extends AIAgentConnector> {
  /** Connector returned to the conformance harness. */
  readonly connector: TConnector;
  /**
   * Idempotent close that also releases the client config lease.
   *
   * Reports rather than rejecting, like the runtime close it wraps, so the
   * connector this replaces keeps the contract's own shape.
   */
  readonly close: () => Promise<TeardownReport>;
}

/**
 * Own every connector runtime created by one conformance test configuration.
 *
 * The registry routes connector creation through the same normalized auth,
 * binary, and client-config lease path as production. It replaces the public
 * connector `close()` method with an idempotent managed close, so a test that
 * closes its connector releases the lease immediately while `closeAll()` can
 * still clean up abandoned connectors at suite teardown.
 */
export class ConformanceConnectorRuntimeRegistry<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
> {
  private readonly runtimes = new Set<ManagedConnectorRuntime<TConnector>>();

  /**
   * Create a connector through the production runtime preparation seam.
   *
   * The conformance harness originates the test scenario, so preparation and the
   * managed close mint their own contexts on the connector's carrier
   * (`config.globalBus`) instead of requiring its consumers to supply one. This
   * module ships in the adapters entry point, so it must not depend on test-only
   * packages.
   * @param options - Bound config and adapter connector factory, without a call (minted here)
   * @returns Managed connector with lease-aware idempotent `close()`
   */
  public async create<TConfig extends BaseAgentConnectorConfig<TBus>>(
    options: Omit<CreateConnectorRuntimeOptions<TBus, TConnector, TConfig>, 'call'>,
  ): Promise<TConnector> {
    const carrier = options.config.globalBus;
    // ORIGIN: the conformance harness starts this connector runtime.
    const runtime = await createConnectorRuntime({ ...options, call: carrier.own('start') });
    const originalClose = runtime.connector.close.bind(runtime.connector);
    let closePromise: Promise<TeardownReport> | undefined;

    const managed: ManagedConnectorRuntime<TConnector> = {
      connector: runtime.connector,
      close: () => {
        // ORIGIN: managed teardown of a runtime this registry started.
        closePromise ??= closeConnectorRuntime(carrier.own('stop'), {
          connector: { close: originalClose },
          ...(runtime.lease !== undefined && { lease: runtime.lease }),
        }).finally(() => {
          this.runtimes.delete(managed);
        });
        return closePromise;
      },
    };

    Object.defineProperty(runtime.connector, 'close', {
      configurable: true,
      value: managed.close,
      writable: true,
    });
    this.runtimes.add(managed);
    return runtime.connector;
  }

  /**
   * Close every connector still owned by this configuration.
   *
   * The managed close reports instead of rejecting, so the failures are read out
   * of the reports; a suite teardown that swallowed them would hide exactly the
   * lease leak this registry exists to catch.
   * @throws The single close failure, or an AggregateError containing all failures
   */
  public async closeAll(): Promise<void> {
    const reports = await Promise.all([...this.runtimes].map(({ close }) => close()));
    const failures = reports
      .map((report) => report.closeError)
      .filter((error): error is unknown => error !== undefined);

    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Multiple conformance connector runtimes failed to close.');
    }
  }
}
