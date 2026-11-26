import type { HostDatabase, HostTransaction, JobRunId } from '@makaio/contracts';
import type { TransportRequestOrigin } from '@makaio/core';
import { onHostTransactionCommit } from '@makaio/storage-drizzle';
import type { WorkerOrderSource } from './start-order.js';
import { readLiveWorkerRunIdentity } from './verify-run-identity.js';

/** Identifies one verified acceptance, even when issuer keys are shared across runs. */
export interface WorkerRunSessionIdentity {
  readonly jobRunId: JobRunId;
  readonly revocationKey: string;
}

/** Private metadata of an accepted run, including the original expiry. */
interface LiveWorkerRunSession extends WorkerRunSessionIdentity {
  readonly expiresAt: string;
}

type RetireWorkerRunSession = (identity: WorkerRunSessionIdentity, reply?: TransportRequestOrigin) => void;

/** A committed retirement could not be enforced on the worker transport. */
export class WorkerRunSessionRetirementError extends Error {
  public readonly code = 'WORKER_RUN_SESSION_RETIREMENT_FAILED';

  public constructor() {
    super('Worker exchange disabled after a committed session retirement failed');
    this.name = 'WorkerRunSessionRetirementError';
  }
}

interface RetirementPolicy {
  retire?: RetireWorkerRunSession;
  disable(error: WorkerRunSessionRetirementError): void;
}

interface WorkerRunSessionRetirementBinding {
  /** Attach transport cleanup before opening worker admission. */
  bind(retire: RetireWorkerRunSession): void;
  /** Release the policy after the exchange closes. */
  release(): void;
}

const policies = new WeakMap<HostDatabase, RetirementPolicy>();

/**
 * Record retirement in the same transaction as the owner's terminal transition
 * or credential revocation. Boot invalidates the route and closes its socket
 * after commit. Rollback leaves the session active. Use the database supplied
 * by the runtime to the owner, so both operations share the same ordering.
 * Framework close schedules this automatically. An owner can use this to
 * disconnect immediately on a direct revocation. Without the notification,
 * the next protected message other than a heartbeat rechecks authoritative state.
 * @param tx - Transaction that changes the authoritative run.
 * @param identity - Revoked run and its opaque issuer key.
 * @param reply - Response route of the request committing the close, if present.
 */
export function retireWorkerRunSessionOnCommit(
  tx: HostTransaction,
  identity: WorkerRunSessionIdentity,
  reply?: TransportRequestOrigin,
): void {
  const { jobRunId, revocationKey } = identity;
  onHostTransactionCommit(
    tx,
    (database) => {
      const policy = policies.get(database);
      if (policy === undefined) return;
      if (policy.retire === undefined) throw new WorkerRunSessionRetirementError();
      policy.retire({ jobRunId, revocationKey }, reply);
    },
    (database) => {
      policies.get(database)?.disable(new WorkerRunSessionRetirementError());
    },
  );
}

/**
 * Require retirement for an enabled exchange, including before its receiver attaches.
 * @param database - Database shared by the owner and the boot dispatch.
 * @param disable - Disable exchange admission and routing on an enforcement fault.
 * @returns The policy to bind before opening admissions, and its shutdown release.
 */
export function requireWorkerRunSessionRetirement(
  database: HostDatabase,
  disable: RetirementPolicy['disable'],
): WorkerRunSessionRetirementBinding {
  const policy: RetirementPolicy = { disable };
  policies.set(database, policy);
  return {
    bind: (retire) => {
      policy.retire = retire;
    },
    release: () => void policies.delete(database),
  };
}

/**
 * Check the currently authorized acceptance without holding the lock across a handler.
 * @param database - Boot database for the protected exchange.
 * @param source - Source of the authoritative locked run.
 * @returns A verifier for messages from a live session.
 */
export function createWorkerRunSessionVerifier(database: HostDatabase, source: WorkerOrderSource) {
  return (session: LiveWorkerRunSession, signal: AbortSignal) =>
    database.transaction((tx) => matchesLiveWorkerRun(tx, source, session, signal), { signal });
}

/**
 * Compare the established acceptance with the current run and dispatch snapshot.
 * @param tx - Current host transaction.
 * @param source - Authoritative run source.
 * @param session - Previously accepted run metadata.
 * @param signal - Connection lifetime.
 * @returns Whether this acceptance is still live.
 */
async function matchesLiveWorkerRun(
  tx: HostTransaction,
  source: WorkerOrderSource,
  session: LiveWorkerRunSession,
  signal: AbortSignal,
): Promise<boolean> {
  const identity = await readLiveWorkerRunIdentity(tx, { source }, session.jobRunId, signal);
  return identity?.revocationKey === session.revocationKey && identity.expiresAt === session.expiresAt;
}

/**
 * Verify and publish using the same commit ordering as owner retirement.
 * @param database - Boot database used for terminal owner writes.
 * @param source - Source of the authoritative locked run.
 * @returns Promotion callback for the boot-owned exchange.
 */
export function createWorkerRunPromotion(database: HostDatabase, source: WorkerOrderSource) {
  return (session: LiveWorkerRunSession, signal: AbortSignal, publish: () => void) =>
    database.transaction(
      async (tx) => {
        if (await matchesLiveWorkerRun(tx, source, session, signal)) {
          onHostTransactionCommit(tx, () => {
            publish();
          });
        }
      },
      { signal },
    );
}
