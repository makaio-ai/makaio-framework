import { expectTypeOf, it } from 'vitest';
import type {
  DispatchBinding,
  ExtensionWorkerProvidersContribution,
  OrderedProvisionOutcome,
  OrderedProvisionRequest,
  OrderedWorkerProvider as RootOrderedWorkerProvider,
  OrderedWorkerRecovery,
  SealedAllocationSet,
  UniqueLiveAllocation,
  WorkerProviderContribution,
} from '@makaio/contracts';
import type { OrderedWorkerProvider } from '@makaio/contracts/extension';

type ProcessBoundProvider = Extract<OrderedWorkerProvider, { allocationLifetime: 'provisioner-process-bound' }>;

it('requires local live proof on a process-bound provider', () => {
  expectTypeOf<Omit<ProcessBoundProvider, 'proveLocalLive'>>().not.toExtend<OrderedWorkerProvider>();
});

it('exposes the ordered worker provider contract from the contracts root', () => {
  type Batch = Awaited<ReturnType<ExtensionWorkerProvidersContribution['createProviders']>>;
  type ManagedProvider = Extract<RootOrderedWorkerProvider, { allocationLifetime: 'provider-managed' }>;

  expectTypeOf<Batch>().toEqualTypeOf<WorkerProviderContribution>();
  expectTypeOf<Batch['providers'][number]>().toEqualTypeOf<RootOrderedWorkerProvider>();
  expectTypeOf<RootOrderedWorkerProvider>().toEqualTypeOf<OrderedWorkerProvider>();
  expectTypeOf<Parameters<ManagedProvider['provision']>[1]>().toEqualTypeOf<OrderedProvisionRequest>();
  expectTypeOf<Awaited<ReturnType<ManagedProvider['provision']>>>().toEqualTypeOf<OrderedProvisionOutcome>();
  expectTypeOf<OrderedProvisionRequest['binding']>().toEqualTypeOf<DispatchBinding>();
  expectTypeOf<ManagedProvider['recovery']>().toEqualTypeOf<OrderedWorkerRecovery>();
  expectTypeOf<Awaited<ReturnType<NonNullable<OrderedWorkerRecovery['proveUniqueLive']>>>>().toEqualTypeOf<
    UniqueLiveAllocation | undefined
  >();
  expectTypeOf<Awaited<ReturnType<NonNullable<OrderedWorkerRecovery['proveSealed']>>>>().toEqualTypeOf<
    SealedAllocationSet | undefined
  >();
});
