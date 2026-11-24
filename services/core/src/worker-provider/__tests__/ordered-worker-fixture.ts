import { createBusInstance } from '@makaio/bus-core';
import type { HostDatabase, HostTransaction, JobRunId, ProviderAllocationRef, WorkerHandle } from '@makaio/contracts';
import {
  defineDialectSchema,
  defineDualTable,
  getTransactionQueryContext,
  resolveSchema,
} from '@makaio/storage-drizzle';
import { DeferredPromise } from '@makaio/utils';
import { eq, sql } from 'drizzle-orm';
import type { StorageDatabaseContext } from '@makaio/storage-conformance';
import { readAllocationScopeSetting } from '../allocation-scope-source.js';
import type { OrderedProvisionOutcome, OrderedWorkerProvider, SealedAllocationSet } from '../ordered-provider.js';
import { decideAllocationScope } from '../scope-decision.js';
import { confirmAllocationScope } from '../scope-confirmation.js';
import { WorkerProviderRegistry } from '../provider-registry.js';
import type { CommittedWorkerOrder, StartOrder, WorkerOrderSource, WorkerStartOptions } from '../start-order.js';

const entries = defineDualTable('ordered_worker_test_run', (c) => ({
  id: c.text('id').primaryKey(),
  digest: c.text('digest').notNull(),
  state: c.text('state').$type<CommittedWorkerOrder['state']>().notNull(),
}));
const tokens = defineDualTable('ordered_worker_test_token', (c) => ({
  run: c.text('run').primaryKey(),
  deadline: c.text('deadline').notNull(),
}));
const schema = defineDialectSchema(
  { entries: entries.sqlite, tokens: tokens.sqlite },
  { entries: entries.postgres, tokens: tokens.postgres },
);

export const call = createBusInstance().own('root');
export const kind = 'example.worker';
export const providerId = `${kind}:primary`;
export const fixtureToken = 'initial-token';
export const setting = readAllocationScopeSetting(
  new Map([['example', { kind: 'config', source: 'operator', config: { allocationScope: 'example-scope' } }]]),
  'example',
);
const confirmed = decideAllocationScope(setting, 'example-scope');
if (confirmed.kind !== 'bound') throw new Error('Missing test scope');
const allocationScope = confirmed.scope;

/**
 * Install the order source's own fixture tables. The worker tables come from the central migrations.
 * @param context - Real dialect-backed database under test.
 */
export async function installOrderFixture(context: StorageDatabaseContext): Promise<void> {
  await context.executor.run(
    sql`CREATE TABLE ordered_worker_test_run (id text PRIMARY KEY, digest text NOT NULL, state text NOT NULL)`,
  );
  await context.executor.run(
    sql`CREATE TABLE ordered_worker_test_token (run text PRIMARY KEY, deadline text NOT NULL)`,
  );
}

/**
 * Build a controllable provider with observable infrastructure state.
 * @param startValuesVisibility - Visibility promised by the provider.
 */
export function controllableProvider(
  startValuesVisibility: OrderedWorkerProvider['startValuesVisibility'] = 'allocation-only',
) {
  const exposed = new DeferredPromise<void>();
  const answer = new DeferredPromise<OrderedProvisionOutcome>();
  const allocations: ProviderAllocationRef[] = [];
  const terminated: ProviderAllocationRef[] = [];
  const sends: { deadline: string; signal: AbortSignal; hasToken: boolean }[] = [];
  let unique = false;
  let ending = true;
  let seal: SealedAllocationSet | undefined;
  const evidence = { source: providerId, summary: 'Fixture evidence', observedAt: new Date().toISOString() };
  const provider: OrderedWorkerProvider = {
    kind,
    id: providerId,
    allocationLifetime: 'provider-managed',
    startValuesVisibility,
    capabilities: {
      maxRuntimeMs: 1000,
      stepIsolation: 'machine',
      customCapabilities: [],
      materializationModes: ['local-directory'],
      supportsRecovery: true,
      persistentStorage: false,
    },
    async assureMaxRuntime() {
      return { boundary: 'platform', evidence };
    },
    async provision(_call, request, signal) {
      sends.push({ deadline: request.bootstrapDeadlineAt, signal, hasToken: request.oneTimeToken === fixtureToken });
      exposed.resolve();
      return answer.getPromise();
    },
    recovery: {
      async listAllocations(_call, request) {
        const observed = allocations.map((allocationRef) => ({
          allocationRef,
          jobRunId: request.jobRunId ?? '',
          state: 'running' as const,
        }));
        return { observations: observed, completeness: { kind: 'complete' } };
      },
      async attach(_call, dispatch) {
        return handleFor(dispatch.jobRunId);
      },
      async inspect(_call, _dispatch, allocationRef) {
        return { state: 'running', allocationRef };
      },
      async terminateAllocation(_call, _dispatch, ref) {
        terminated.push(ref);
        return { state: ending ? 'ending' : 'ended', evidence };
      },
      async proveUniqueLive(_call, _dispatch, allocationRef) {
        return unique ? { allocationRef, expiresAt: new Date(Date.now() + 60_000).toISOString() } : undefined;
      },
      async proveSealed() {
        return seal;
      },
    },
  };
  return {
    provider,
    exposed,
    answer,
    allocations,
    terminated,
    sends,
    evidence,
    proveUniqueness() {
      unique = true;
    },
    finishTermination() {
      ending = false;
      seal = { allocations: [...allocations], evidence };
    },
  };
}

/**
 * Create the fixture provider's in-process control handle.
 * @param executionId - Run attached to this handle.
 */
export function handleFor(executionId: JobRunId): WorkerHandle {
  return { executionId, async cancel() {}, async terminate() {}, async release() {} };
}

/**
 * Build a process-bound provider without an active local registration.
 * @param provider - Provider whose provision operation and instance identity are reused.
 */
export function processBoundProvider(provider = controllableProvider().provider) {
  const { recovery: _recovery, ...common } = provider;
  return {
    ...common,
    allocationLifetime: 'provisioner-process-bound' as const,
    capabilities: { ...provider.capabilities, supportsRecovery: false },
    async proveLocalLive() {
      return undefined;
    },
  };
}

/**
 * Compose and initialize a start service against the real database and test provider.
 * @param database - Host transaction facade on the fixture database.
 * @param provider - Worker provider contributed by the extension.
 * @param jobRunId - Unique run for this test.
 */
export async function orderFixture(database: HostDatabase, provider: OrderedWorkerProvider, jobRunId: JobRunId) {
  const common = {
    jobRunId,
    workerProviderId: providerId,
    bootstrapDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const order: StartOrder =
    provider.allocationLifetime === 'provider-managed'
      ? { ...common, allocationLifetime: provider.allocationLifetime, allocationScope }
      : { ...common, allocationLifetime: provider.allocationLifetime };
  const tokensInMemory = new Map<JobRunId, string>();
  const source: WorkerOrderSource = {
    async lockOrder(tx, id): Promise<CommittedWorkerOrder | undefined> {
      const query = getTransactionQueryContext(tx);
      const table = resolveSchema(query, schema);
      const [row] = await query
        .update(table.entries)
        .set({ state: sql`${table.entries.state}` })
        .where(eq(table.entries.id, id))
        .returning();
      if (row === undefined) return undefined;
      const [token] = await query.select().from(table.tokens).where(eq(table.tokens.run, id));
      if (token === undefined) return undefined;
      return {
        owner: { kind: call.caller.kind, id: call.caller.id },
        orderDigest: row.digest,
        state: row.state,
        order: { ...order, bootstrapDeadlineAt: token.deadline },
        runtimeInputs: { workerManifest: { contributionRefs: [] } },
      };
    },
    hasStartToken(committed) {
      return tokensInMemory.has(committed.order.jobRunId);
    },
    readStartToken(committed) {
      return tokensInMemory.get(committed.order.jobRunId);
    },
  };
  await confirmAllocationScope(database, setting, allocationScope.value, call);
  const providers = new WorkerProviderRegistry();
  const operationSignal = new AbortController().signal;
  await providers.replace(
    call,
    { owner: 'example', key: 'primary', managedScopeConfirmed: true, providers: [provider] },
    operationSignal,
  );
  const host: WorkerStartOptions = {
    database,
    source,
    providers,
    scopeSetting: setting,
    operationSignal,
    processIncarnation: 'initial-incarnation',
    connection: () => ({ busAuth: { kind: 'none' } }),
  };
  return {
    order,
    host,
    async orderIn(tx: HostTransaction) {
      const query = getTransactionQueryContext(tx);
      const table = resolveSchema(query, schema);
      await query.insert(table.entries).values({ id: jobRunId, digest: 'digest', state: 'ordered' });
      await query.insert(table.tokens).values({ run: jobRunId, deadline: order.bootstrapDeadlineAt });
      tokensInMemory.set(jobRunId, fixtureToken);
    },
    async setState(tx: HostTransaction, state: CommittedWorkerOrder['state']) {
      const query = getTransactionQueryContext(tx);
      const table = resolveSchema(query, schema);
      await query.update(table.entries).set({ state }).where(eq(table.entries.id, jobRunId));
    },
    loseToken() {
      tokensInMemory.delete(jobRunId);
    },
  };
}
