import { isLoopbackAddress, type ConnectionExchangeSetup } from '@makaio/bus-transport-websocket';
import type { HostDatabase } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import type { CoreBootOptions } from './boot-types.js';
import {
  createWorkerRunPromotion,
  createWorkerRunSessionVerifier,
  type WorkerRunSessionRetirementError,
} from '@makaio/services-core/internal/worker-provider-host-binding';
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
 * @param boot - Supported or test worker exchange policy, when enabled.
 * @param boundHost - Native listener address.
 * @returns The stable delegate with its boot-owned admission lifetime.
 */
export function prepareWorkerExchangeHost(
  boot: Pick<CoreBootOptions, 'singleHostWorkerExchange' | 'workerDispatch' | 'workerExchangeTest'>,
  boundHost: string,
) {
  const test = boot.workerExchangeTest;
  const options = boot.singleHostWorkerExchange ?? test;
  if (options === undefined) return undefined;
  if (test !== undefined && !isLoopbackAddress(boundHost)) {
    throw new Error('Worker exchange test mode requires a loopback listener');
  }
  const lifetime = new AbortController();
  const unavailable = AbortSignal.abort();
  let exchange: ConnectionExchangeSetup | undefined;
  let verifyRunSession: ConnectionExchangeSetup['verifyRunSession'];
  const policy = workerConnectionExchangePolicy(options);
  const setup: ConnectionExchangeSetup = {
    ...policy,
    availability() {
      if (exchange === undefined) return unavailable;
      const owner = test?.availability?.();
      return owner === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, owner]);
    },
    admit(frame, context) {
      lifetime.signal.throwIfAborted();
      return exchange?.admit(frame, context) ?? Promise.resolve(undefined);
    },
    verifyRunSession(session, signal) {
      return verifyRunSession?.(session, signal) ?? Promise.resolve(false);
    },
  };
  return {
    setup,
    open(dispatch: BoundWorkerDispatch | undefined, supervision: CallContext, hostDatabase: HostDatabase) {
      lifetime.signal.throwIfAborted();
      const source = boot.workerDispatch?.source;
      if (dispatch === undefined || source === undefined) {
        throw new Error(
          test === undefined
            ? 'Worker exchange requires an ordered dispatch host'
            : 'Worker exchange test mode requires an ordered dispatch host',
        );
      }
      verifyRunSession = createWorkerRunSessionVerifier(hostDatabase, source);
      exchange = dispatch.connectionExchange(supervision, {
        ...policy,
        verifyProof: options.verifyProof.bind(options),
        withRunPromotion:
          test === undefined
            ? createWorkerRunPromotion(hostDatabase, source)
            : test.withRunPromotion.bind(test, hostDatabase),
      });
    },
    close() {
      exchange = undefined;
      lifetime.abort();
    },
    disable(error: WorkerRunSessionRetirementError) {
      if (lifetime.signal.aborted) return;
      console.error('[boot] %s: %s', error.code, error.message);
      lifetime.abort(error);
    },
  };
}
