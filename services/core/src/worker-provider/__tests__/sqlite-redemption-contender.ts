import assert from 'node:assert/strict';
import { once } from 'node:events';
import { parentPort, workerData } from 'node:worker_threads';
import { createBusInstance } from '@makaio/bus-core';
import { callFromReceive } from '@makaio/bus-core/kernel-api';
import type { JobRunId, ProviderAllocationRef } from '@makaio/contracts';
import type { ConnectionExchangeAccepted, ConnectionExchangeRejected } from '@makaio/contracts/boundary';
import { createHostDatabase, getRawSqlExecutor } from '@makaio/storage-drizzle';
import { drizzle } from 'drizzle-orm/libsql';
import {
  AllocationObservationSignal,
  prepareWorkerRedemption,
  WorkerRedemptionError,
} from '../../internal/worker-provider-host-binding.js';
import { WorkerProviderRegistry } from '../provider-registry.js';
import { fixtureToken, processBoundProvider, setting } from './ordered-worker-fixture.js';
import { redemptionOwnerSource } from './redemption-owner-fixture.js';

export interface SqliteContenderInput {
  readonly databaseUrl: string;
  readonly jobRunId: JobRunId;
  readonly runtimeSecret: string;
  readonly processIncarnation: string;
  readonly deadline: number;
  readonly allocation: ProviderAllocationRef;
}

export type SqliteContenderMessage =
  | { readonly kind: 'prepared' }
  | { readonly kind: 'write-locked' }
  | { readonly kind: 'complete'; readonly result: ConnectionExchangeAccepted | ConnectionExchangeRejected };

/**
 * Compete on a separate SQLite connection and verify contention before retrying.
 * @param input - Booked test run and local fixture provider.
 */
async function contend(input: SqliteContenderInput): Promise<ConnectionExchangeAccepted | ConnectionExchangeRejected> {
  const port = parentPort;
  if (port === null) throw new Error('Expected contender thread');
  // The untuned native client reports a busy writer immediately. The host
  // facade still opens the real transaction for both commit attempts.
  const db = drizzle({ connection: { url: input.databaseUrl } });
  try {
    const database = createHostDatabase(db);
    const supervisionCall = createBusInstance().own('observer');
    const operationSignal = new AbortController().signal;
    const providers = new WorkerProviderRegistry();
    const proving = Promise.withResolvers<void>();
    const resumeProof = Promise.withResolvers<void>();
    let proofCalls = 0;
    const provider = {
      ...processBoundProvider(),
      async proveLocalLive() {
        if (++proofCalls === 2) {
          proving.resolve();
          await resumeProof.promise;
        }
        return { allocationRef: input.allocation, expiresAt: new Date(input.deadline).toISOString() };
      },
    };
    await providers.replace(
      supervisionCall,
      { owner: 'example', key: 'primary', managedScopeConfirmed: false, providers: [provider] },
      operationSignal,
    );
    const anonymous = callFromReceive(
      { transportName: 'worker-test', connectionId: 'contender' },
      undefined,
      undefined,
      () => {},
    );
    const host = {
      database,
      source: redemptionOwnerSource(getRawSqlExecutor(db), fixtureToken),
      supervisionCall,
      operationSignal,
      providers,
      allocationObservation: new AllocationObservationSignal(),
      scopeSetting: setting,
      processIncarnation: input.processIncarnation,
      handles: new Map(),
      connection: () => ({ busAuth: { kind: 'none' as const } }),
    };
    const prepare = () =>
      prepareWorkerRedemption(
        host,
        anonymous,
        { jobRunId: input.jobRunId, runtimeSecret: input.runtimeSecret, oneTimeToken: fixtureToken },
        { kind: 'allocation-only' },
        input.deadline,
      );
    const { commit } = await prepare();
    if (commit === undefined) throw new Error('Could not prepare the SQLite contender');
    const pending = prepare();
    await Promise.race([
      proving.promise,
      pending.then(() => {
        throw new Error('Contended preparation ended before the allocation proof');
      }),
    ]);
    port.postMessage({ kind: 'prepared' } satisfies SqliteContenderMessage);
    await once(port, 'message');

    let entered = false;
    const exchange = () =>
      database.transaction((tx) => {
        entered = true;
        return commit(anonymous, tx);
      });
    await assert.rejects(exchange, { code: 'SQLITE_BUSY' });
    assert.equal(entered, false, 'SQLite must reject the transaction before entering the exchange callback');
    // A failed BEGIN can leave an unfinished statement in the native driver.
    await db.$client.reconnect();
    const retryable = assert.rejects(pending, (error) => {
      assert.ok(error instanceof WorkerRedemptionError);
      assert.equal(error.code, 'retryable');
      assert.equal(error.message, 'Run redemption storage read failed');
      assert.equal(error.cause, undefined);
      return true;
    });
    resumeProof.resolve();
    await retryable;
    port.postMessage({ kind: 'write-locked' } satisfies SqliteContenderMessage);
    await once(port, 'message');
    await db.$client.reconnect();
    return await exchange();
  } finally {
    db.$client.close();
  }
}

try {
  const result = await contend(workerData as SqliteContenderInput);
  parentPort?.postMessage({ kind: 'complete', result } satisfies SqliteContenderMessage);
} finally {
  parentPort?.close();
}
