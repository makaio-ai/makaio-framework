import { WorkerBootstrapDeadlineAtSchema, type HostTransaction, type JobRunId } from '@makaio/contracts';
import { isInProcessCaller, type CallContext } from '@makaio/core';
import { isMintedCallContext } from '@makaio/bus-core';
import { canonicalStringify } from '@makaio/utils';
import { readBinding } from './allocation-scope-store.js';
import { decideAllocationScope } from './scope-decision.js';
import { insertDispatch, readDispatch, type DispatchClaim } from './dispatch-store.js';
import type { DispatchBinding, OrderedProvisionRequest, OrderedWorkerProvider } from '@makaio/contracts/extension';
import type { CommittedWorkerOrder, StartOrder, StartWorkerResult, WorkerStartOptions } from './start-order.js';

type Refusal = Extract<StartWorkerResult, { kind: 'refused' }>;

/** The configured owner cannot support the redemption capability of its booking. */
export class WorkerOrderConfigurationError extends Error {
  public constructor() {
    super('An atomic worker order source must implement readRedemptionCredentials');
    this.name = 'WorkerOrderConfigurationError';
  }
}

export type StartDecision =
  | Refusal
  | { kind: 'observe'; claim: DispatchClaim; order: CommittedWorkerOrder }
  | {
      kind: 'dispatch';
      provider: OrderedWorkerProvider;
      claim: DispatchClaim;
      material: Omit<OrderedProvisionRequest, 'connection'>;
    };

/**
 * Check an absolute deadline against the host wall clock, which also bounds the
 * caller's wait. The committed order remains the source of the bootstrap deadline.
 * @param deadline - Deadline supplied by the host or by an evidence verifier.
 * @returns Whether the declared deadline is valid and still open.
 */
export function hasOpenDeadline(deadline: string): boolean {
  return WorkerBootstrapDeadlineAtSchema.safeParse(deadline).success && Date.parse(deadline) > Date.now();
}

/**
 * Check whether the installation can start or terminate managed allocations.
 * @param tx - Current host transaction.
 * @param host - Installation configuration.
 * @param order - Managed dispatch binding under consideration.
 * @returns Whether operator configuration matches the confirmed scope.
 */
export async function isScopeApproved(
  tx: HostTransaction,
  host: WorkerStartOptions,
  order: Pick<Extract<DispatchBinding, { allocationLifetime: 'provider-managed' }>, 'allocationScope'>,
): Promise<boolean> {
  const confirmed = await readBinding(tx);
  const scope = decideAllocationScope(host.scopeSetting, confirmed?.allocationScope);
  return scope.kind === 'bound' && scope.scope.value === order.allocationScope.value;
}

/**
 * Match the real in-process caller to the committed order owner.
 * @param call - Candidate caller context.
 * @param order - Committed order.
 * @returns Whether the authenticated caller owns this order.
 */
export function ownsOrder(call: CallContext, order: CommittedWorkerOrder): boolean {
  return (
    isMintedCallContext(call) &&
    isInProcessCaller(call) &&
    call.caller.kind === order.owner.kind &&
    call.caller.id === order.owner.id
  );
}

/**
 * Match a stored claim to its host order without storing the token deadline twice.
 * @param claim - Durable dispatch state.
 * @param committed - Current authoritative order.
 * @returns Whether the claim and the host binding agree.
 */
export function matchesClaim(claim: DispatchClaim, committed: CommittedWorkerOrder): boolean {
  const { order } = committed;
  const { binding } = claim;
  return (
    claim.orderDigest === committed.orderDigest &&
    binding.jobRunId === order.jobRunId &&
    binding.providerId === order.workerProviderId &&
    binding.allocationLifetime === order.allocationLifetime &&
    (binding.allocationLifetime !== 'provider-managed' ||
      binding.allocationScope.value === order.allocationScope?.value)
  );
}

/**
 * Read a run under the host lock and validate the claim binding.
 * Supervision can finish existing dispatches without a credential reader.
 * @param tx - Live host transaction.
 * @param host - Authoritative source of the booked run.
 * @param jobRunId - Run to lock.
 * @param signal - Optional lifetime of a connection exchange using this lock.
 * @returns The locked order and matching claim, if present.
 */
export async function lockDispatch(
  tx: HostTransaction,
  host: Pick<WorkerStartOptions, 'source'>,
  jobRunId: JobRunId,
  signal?: AbortSignal,
): Promise<{ order: CommittedWorkerOrder; claim: DispatchClaim } | undefined> {
  signal?.throwIfAborted();
  const order = await host.source.lockOrder(tx, jobRunId, signal);
  signal?.throwIfAborted();
  const claim = await readDispatch(tx, jobRunId);
  signal?.throwIfAborted();
  return order !== undefined && claim !== undefined && matchesClaim(claim, order) ? { order, claim } : undefined;
}

/**
 * Check first-start preconditions under the run lock, then atomically insert the claim.
 * @param tx - Live host transaction holding the run lock.
 * @param host - Composed host dependencies.
 * @param committed - Authorized immutable order.
 * @returns The winning claim, an existing claim, or a refusal.
 */
async function claimFirstStart(
  tx: HostTransaction,
  host: WorkerStartOptions,
  committed: CommittedWorkerOrder,
): Promise<StartDecision> {
  const { order, orderDigest, runtimeInputs, preserveWorkspace, continues } = committed;
  if (committed.state !== 'ordered') return { kind: 'refused', reason: 'run-closed' };
  if (!hasOpenDeadline(order.bootstrapDeadlineAt)) return { kind: 'refused', reason: 'bootstrap-expired' };
  if (committed.redemption !== undefined && typeof host.source.readRedemptionCredentials !== 'function') {
    throw new WorkerOrderConfigurationError();
  }
  const provider = host.providers.selectForProvisioning(order.workerProviderId);
  if (provider === undefined || provider.allocationLifetime !== order.allocationLifetime) {
    return { kind: 'refused', reason: 'provider-unavailable' };
  }
  if (order.allocationLifetime === 'provider-managed' && !(await isScopeApproved(tx, host, order))) {
    return { kind: 'refused', reason: 'allocation-scope-blocked' };
  }
  if (!host.source.hasStartToken(committed)) return { kind: 'refused', reason: 'start-material-unavailable' };
  const common = { jobRunId: order.jobRunId, providerId: provider.id, provisioningStartedAt: new Date().toISOString() };
  const binding: DispatchBinding =
    order.allocationLifetime === 'provider-managed'
      ? { ...common, allocationLifetime: order.allocationLifetime, allocationScope: order.allocationScope }
      : { ...common, allocationLifetime: order.allocationLifetime, processIncarnation: host.processIncarnation };
  const claim = await insertDispatch(tx, { jobRunId: order.jobRunId, orderDigest, binding });
  if (claim === undefined) {
    const winner = await readDispatch(tx, order.jobRunId);
    return winner !== undefined && matchesClaim(winner, committed)
      ? { kind: 'observe', claim: winner, order: committed }
      : { kind: 'refused', reason: 'binding-mismatch' };
  }
  const oneTimeToken = host.source.readStartToken(committed);
  if (oneTimeToken === undefined || oneTimeToken.length === 0)
    throw new Error('Start material disappeared during claim');
  const material = {
    binding,
    bootstrapDeadlineAt: order.bootstrapDeadlineAt,
    runtimeInputs: structuredClone(runtimeInputs),
    preserveWorkspace,
    continues: structuredClone(continues),
    oneTimeToken,
  };
  return { kind: 'dispatch', provider, claim, material };
}

/**
 * Authenticate and acquire or re-enter the durable dispatch.
 * @param host - Composed host dependencies.
 * @param call - Internal caller.
 * @param order - Public binding from committed admission.
 * @returns The committed start decision.
 */
export async function decideStart(
  host: WorkerStartOptions,
  call: CallContext,
  order: StartOrder,
): Promise<StartDecision> {
  if (!isMintedCallContext(call) || !isInProcessCaller(call)) return { kind: 'refused', reason: 'binding-mismatch' };
  return host.database.transaction(async (tx) => {
    const committed = await host.source.lockOrder(tx, order.jobRunId);
    if (committed === undefined) return { kind: 'refused', reason: 'not-committed' };
    if (!ownsOrder(call, committed) || canonicalStringify(committed.order) !== canonicalStringify(order)) {
      return { kind: 'refused', reason: 'binding-mismatch' };
    }
    const claim = await readDispatch(tx, order.jobRunId);
    if (claim === undefined) return claimFirstStart(tx, host, committed);
    return matchesClaim(claim, committed)
      ? { kind: 'observe', claim, order: committed }
      : { kind: 'refused', reason: 'binding-mismatch' };
  });
}
