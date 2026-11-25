import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { ProviderAllocationRef, WorkerHandle } from '@makaio/contracts';
import type { KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel';
import type { MakaioRuntime } from '../boot-types.js';
import { ExplicitDescriptorDiscovery } from '../extension-discovery.js';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import type {
  CommittedWorkerOrder,
  OrderedWorkerProvider,
  StartOrder,
  WorkerOrderSource,
} from '@makaio/services-core/worker-provider';
import {
  defineDialectSchema,
  defineDualTable,
  getRawSqlExecutor,
  getTransactionQueryContext,
  resolveSchema,
} from '@makaio/storage-drizzle';
import { eq, sql } from 'drizzle-orm';

export const name = 'worker-dispatch-probe';
const kind = `${name}.child`;
const key = 'primary';
const providerId = `${kind}:${key}`;
const table = defineDualTable('dispatch_boot_order', (c) => ({
  id: c.text('id').primaryKey(),
  deadline: c.text('deadline').notNull(),
  state: c.text('state').$type<CommittedWorkerOrder['state']>().notNull(),
}));
const schema = defineDialectSchema({ orders: table.sqlite }, { orders: table.postgres });

export const source: WorkerOrderSource = {
  async lockOrder(tx, id) {
    const q = getTransactionQueryContext(tx);
    const { orders } = resolveSchema(q, schema);
    const [row] = await q
      .update(orders)
      .set({ state: sql`${orders.state}` })
      .where(eq(orders.id, id))
      .returning();
    if (row === undefined) return undefined;
    return {
      order: {
        jobRunId: id,
        workerProviderId: providerId,
        allocationLifetime: 'provisioner-process-bound',
        bootstrapDeadlineAt: row.deadline,
      },
      orderDigest: id,
      owner: { kind: 'makaio.extension', id: name },
      state: row.state,
      runtimeInputs: { workerManifest: { contributionRefs: [] } },
    };
  },
  hasStartToken: () => true,
  readStartToken: () => 'fixture-token',
};

/**
 * Allocate and control real children, publishing trusted local proof on spawn.
 * @param onCleanup - Registers the fallback that stops any remaining children.
 * @returns The provider and its independently observable process state.
 */
export function childProvider(onCleanup: (cleanup: () => Promise<void>) => void) {
  const children = new Map<string, { ref: ProviderAllocationRef; handle: WorkerHandle; deadline: string }>();
  const firstChild = Promise.withResolvers<void>();
  const firstReply = Promise.withResolvers<void>();
  let launches = 0;
  let stops = 0;
  onCleanup(async () => {
    firstReply.resolve();
    await Promise.all([...children.values()].map(({ handle }) => handle.terminate()));
  });
  const provider: OrderedWorkerProvider = {
    kind,
    id: providerId,
    allocationLifetime: 'provisioner-process-bound',
    startValuesVisibility: 'allocation-only',
    capabilities: {
      maxRuntimeMs: 60_000,
      customCapabilities: [],
      materializationModes: ['local-directory'],
      supportsRecovery: false,
      persistentStorage: false,
      stepIsolation: 'machine',
    },
    async assureMaxRuntime() {
      return {
        boundary: 'provider-process',
        evidence: { source: 'child', summary: 'Child deadline', observedAt: new Date().toISOString() },
      };
    },
    async provision(_call, request) {
      const { jobRunId } = request.binding;
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
      launches++;
      const exited = new Promise<void>((resolve) => {
        child.once('close', () => {
          children.delete(jobRunId);
          resolve();
        });
      });
      await once(child, 'spawn');
      const ref = { version: 1, providerId, providerData: { pid: child.pid ?? 0 } } as const;
      const handle: WorkerHandle = {
        executionId: jobRunId,
        async cancel() {
          child.kill();
        },
        async terminate() {
          stops++;
          child.kill();
          await exited;
        },
        async release() {},
      };
      children.set(jobRunId, { ref, handle, deadline: request.bootstrapDeadlineAt });
      firstChild.resolve();
      await firstReply.promise;
      return { kind: 'allocated', allocationRef: ref, handle };
    },
    async proveLocalLive(_call, binding) {
      const child = children.get(binding.jobRunId);
      return child === undefined ? undefined : { allocationRef: child.ref, expiresAt: child.deadline };
    },
  };
  return {
    provider,
    children,
    firstChild: firstChild.promise,
    releaseReply: firstReply.resolve,
    launches: () => launches,
    stops: () => stops,
  };
}

/**
 * Use the shared SQL order transaction to insert or close the test order.
 * @param ctx - Extension with the host database.
 * @param order - Committed public order binding.
 * @param state - Initial or updated state of this order.
 */
export async function writeOrder(
  ctx: KernelExtensionContext,
  order: StartOrder,
  state: CommittedWorkerOrder['state'] = 'ordered',
) {
  await ctx.database.transaction(async (tx) => {
    const q = getTransactionQueryContext(tx);
    const { orders } = resolveSchema(q, schema);
    await q
      .insert(orders)
      .values({ id: order.jobRunId, deadline: order.bootstrapDeadlineAt, state })
      .onConflictDoUpdate({ target: orders.id, set: { state } });
  });
}

/**
 * Create a fresh committed order binding for a probe.
 * @returns The order for the fixture provider.
 */
export function probeOrder(): StartOrder {
  return {
    jobRunId: crypto.randomUUID(),
    workerProviderId: providerId,
    bootstrapDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    allocationLifetime: 'provisioner-process-bound',
  };
}

/**
 * Read a fresh host-created context for the active extension.
 * @param runtime - Booted host.
 * @returns The extension context.
 */
export function activeContext(runtime: MakaioRuntime): KernelExtensionContext {
  let ctx: KernelExtensionContext | undefined;
  runtime.coordinator.forExtension(name, (_name, _pkg, context) => {
    ctx = context;
  });
  if (ctx === undefined) throw new Error('Dispatch probe did not activate');
  return ctx;
}

/**
 * Install the committed order table beside the dispatch tables.
 * @param url - Isolated database connection target.
 */
export async function installBootOrderTable(url: string): Promise<void> {
  const database = await createDatabaseClient({ url });
  try {
    await getRawSqlExecutor(database.db).run(sql`CREATE TABLE dispatch_boot_order (
      id text PRIMARY KEY, deadline text NOT NULL, state text NOT NULL
    )`);
  } finally {
    await database.close();
  }
}

/**
 * Discover the same contributing extension in either runtime.
 * @param home - Extension directory for this boot.
 * @param provider - Factory evaluated anew at every activation.
 * @param create - Service factory used to observe the context supplied at startup.
 * @returns Discovery source with the executable provider contribution.
 */
export function dispatchProbeDiscovery(
  home: string,
  provider: () => OrderedWorkerProvider,
  create: KernelMakaioExtension['create'],
): ExplicitDescriptorDiscovery {
  const extension: KernelMakaioExtension = {
    name,
    displayName: 'Dispatch probe',
    version: '1.0.0',
    critical: true,
    create,
    workerProviders: {
      createProviders: () => ({ key, managedScopeConfirmed: false, providers: [provider()] }),
    },
  };
  return new ExplicitDescriptorDiscovery([
    {
      descriptor: {
        name,
        displayName: extension.displayName,
        version: extension.version,
        makaio: { framework: '>=1.0.0' },
        entrypoints: { server: true },
      },
      extensionPath: home,
      source: 'local',
      preloadedModule: { default: extension },
    },
  ]);
}
