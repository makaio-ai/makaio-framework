import type { ProviderAllocationRef } from '@makaio/contracts';
import { resolveStorageConformanceConfig, useSuiteDatabaseContext } from '@makaio/storage-conformance';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DispatchCandidateReadError,
  WorkerOrderConfigurationError,
  createWorkerDispatch,
} from '../../internal/worker-provider-host-binding.js';
import { insertDispatch, readDispatch } from '../dispatch-store.js';
import {
  call,
  controllableProvider,
  fixtureToken,
  handleFor,
  orderFixture,
  processBoundProvider,
  providerId,
} from './ordered-worker-fixture.js';
import { bookRedemptionOwner, migrateRedemptionOwner } from './redemption-owner-fixture.js';

const config = resolveStorageConformanceConfig();
if (config === null) throw new Error('MAKAIO_STORAGE_TEST_URL is required for PostgreSQL dispatch tests');
const reference: ProviderAllocationRef = { version: 1, providerId, providerData: { allocation: 'example' } };

describe(`worker dispatch storage (${config.dialect})`, () => {
  const getContext = useSuiteDatabaseContext(config);
  beforeAll(async () => migrateRedemptionOwner(getContext()));

  it('rejects an untyped host missing its observation signal at composition', async () => {
    const database = createHostDatabase(getContext().db);
    const provider = processBoundProvider();
    const { host } = await orderFixture(database, provider, 'missing-observation-signal');
    Reflect.deleteProperty(host, 'allocationObservation');

    expect(() => createWorkerDispatch(host)).toThrow('Worker dispatch requires a shared AllocationObservationSignal');
  });

  it('rejects an untyped atomic owner at its first booking before writing a dispatch', async () => {
    const { db, executor } = getContext();
    const database = createHostDatabase(db);
    const worker = controllableProvider();
    const provider = processBoundProvider(worker.provider);
    const { host, order } = await orderFixture(database, provider, 'missing-credential-reader');
    worker.answer.resolve({ kind: 'allocated', allocationRef: reference, handle: handleFor(order.jobRunId) });
    const owner = await bookRedemptionOwner(
      database,
      order,
      { kind: call.caller.kind, id: call.caller.id },
      fixtureToken,
      false,
    );
    const source = owner.sourceFor(executor);
    Reflect.deleteProperty(source, 'readRedemptionCredentials');
    const dispatch = createWorkerDispatch({ ...host, source });

    const start = dispatch.startOrderedWorker(call, order, host.operationSignal);
    await expect(start).rejects.toBeInstanceOf(WorkerOrderConfigurationError);
    await expect(start).rejects.toThrow('An atomic worker order source must implement readRedemptionCredentials');
    await expect(database.transaction((tx) => readDispatch(tx, order.jobRunId))).resolves.toBeUndefined();
  });

  /**
   * Write directly to the JSON column to exercise the real dispatch reader.
   * @param jobRunId - Isolated dispatch row for this case.
   * @param json - Exact persisted column content.
   */
  async function writeCandidates(jobRunId: string, json: string) {
    const { db, executor, dialect } = getContext();
    const database = createHostDatabase(db);
    await database.transaction((tx) =>
      insertDispatch(tx, {
        jobRunId,
        orderDigest: 'digest',
        binding: {
          jobRunId,
          providerId,
          provisioningStartedAt: new Date().toISOString(),
          allocationLifetime: 'provisioner-process-bound',
          processIncarnation: 'test',
        },
      }),
    );
    const candidates = dialect === 'postgres' ? sql`cast(${json} as jsonb)` : sql`${json}`;
    await executor.run(sql`UPDATE worker_dispatch SET candidates = ${candidates} WHERE job_run_id = ${jobRunId}`);
    return database;
  }

  it.each([
    ['array', [reference]],
    ['envelope without sender provenance', { references: [reference], shutdownEnded: [reference] }],
  ] as const)('preserves candidates in a legacy %s', async (label, payload) => {
    const database = await writeCandidates(label, JSON.stringify(payload));
    const claim = await database.transaction((tx) => readDispatch(tx, label));
    expect(claim).toMatchObject({ candidates: [reference] });
    expect(claim).not.toHaveProperty('senderReference');
  });

  it.each([
    ['missing references', JSON.stringify({ senderReference: reference })],
    ['invalid sender reference', JSON.stringify({ references: [reference], senderReference: 'invalid' })],
    ...(config.dialect === 'sqlite' ? [['invalid JSON syntax', '{']] : []),
  ])('rejects unreadable candidate data (%s)', async (label, json) => {
    const database = await writeCandidates(label, json);
    const read = database.transaction((tx) => readDispatch(tx, label));
    await expect(read).rejects.toBeInstanceOf(DispatchCandidateReadError);
    await expect(read).rejects.toThrow('Stored worker dispatch candidates are invalid');
    await expect(read).rejects.not.toHaveProperty('cause');
  });
});
