import { isLoopbackAddress, type ConnectionExchangeSetup } from '@makaio/bus-transport-websocket';
import type { HostDatabase } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import type { BoundWorkerDispatch } from './worker-dispatch-host-binding.js';
import { workerConnectionExchangePolicy, type WorkerConnectionExchangeOptions } from './worker-connection-exchange.js';

/** Trusted owner policy for a local protected worker exchange test. */
export interface WorkerExchangeHostTestOptions extends Omit<WorkerConnectionExchangeOptions, 'withRunPromotion'> {
  /** Current owner availability, when a test also exercises storage listener recovery. */
  readonly availability?: () => AbortSignal;
  /**
   * Recheck and publish an admission under the same local turn used by owner retirement.
   * @param database - The dispatch host's current database.
   * @param args - Verified run, setup lifetime and synchronous publication callback.
   */
  withRunPromotion(
    database: HostDatabase,
    ...args: Parameters<WorkerConnectionExchangeOptions['withRunPromotion']>
  ): Promise<void>;
}

/**
 * Prepare a closed transport delegate before boot loads storage or rights.
 * @param options - Explicit worker exchange test policy, when enabled.
 * @param boundHost - Native listener address.
 * @returns The stable delegate with its boot-owned admission lifetime.
 */
export function prepareWorkerExchangeHostTestMode(
  options: WorkerExchangeHostTestOptions | undefined,
  boundHost: string,
) {
  if (options === undefined) return undefined;
  if (!isLoopbackAddress(boundHost)) {
    throw new Error('Worker exchange test mode requires a loopback listener');
  }
  const lifetime = new AbortController();
  const unavailable = AbortSignal.abort();
  let exchange: ConnectionExchangeSetup | undefined;
  const policy = workerConnectionExchangePolicy(options);
  const setup: ConnectionExchangeSetup = {
    ...policy,
    availability() {
      if (exchange === undefined) return unavailable;
      const owner = options.availability?.();
      return owner === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, owner]);
    },
    admit(frame, context) {
      lifetime.signal.throwIfAborted();
      return exchange?.admit(frame, context) ?? Promise.resolve(undefined);
    },
  };
  return {
    setup,
    open(dispatch: BoundWorkerDispatch | undefined, supervision: CallContext, hostDatabase: HostDatabase) {
      lifetime.signal.throwIfAborted();
      if (dispatch === undefined) throw new Error('Worker exchange test mode requires an ordered dispatch host');
      exchange = dispatch.connectionExchange(supervision, {
        ...policy,
        verifyProof: options.verifyProof.bind(options),
        withRunPromotion: options.withRunPromotion.bind(options, hostDatabase),
      });
    },
    close() {
      exchange = undefined;
      lifetime.abort();
    },
  };
}
