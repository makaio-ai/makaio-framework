import type { HostDatabase, JobRunCapability } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import type { ServerTransport } from '@makaio/bus-transport-websocket';
import {
  getDatabaseSignals,
  markTransactionRollbackOnly,
  markTransactionWakeTopic,
  type MakaioDatabase,
} from '@makaio/storage-drizzle';
import { readRedemptionOwnerEndings, readRedemptionOwnerRow } from './redemption-owner-fixture.js';
import { RUN_ID, type ExchangeMessage, type ExchangeWakeScope } from './worker-exchange-process-types.js';

type Report = (message: ExchangeMessage) => void;

interface ExchangeReadiness {
  availability(): AbortSignal;
  deny(): void;
  allow(): void;
}

/** @returns An initially gated worker exchange generation for the listener fixture. */
function createExchangeReadiness(): ExchangeReadiness {
  let generation = new AbortController();
  generation.abort();
  return {
    availability: () => generation.signal,
    deny: () => generation.abort(),
    allow() {
      if (generation.signal.aborted) generation = new AbortController();
    },
  };
}

/**
 * Subscribe a separate host to the test's real PostgreSQL commit notifications.
 * @param scope - Case-owned topics shared over IPC at startup.
 * @param database - Host transaction facade for reading committed state.
 * @param db - The receiving host's own PostgreSQL connection.
 * @param transport - The receiving host's shared WebSocket routes.
 * @param report - Supervisor milestone callback.
 * @param readiness - Optional gated worker exchange generation.
 * @param beforeReconcile - Supervisor barrier after the first recovered authority read.
 * @returns Unsubscribe once the listener is ready.
 */
async function attachSubscriber(
  scope: ExchangeWakeScope,
  database: HostDatabase,
  db: MakaioDatabase,
  transport: ServerTransport,
  report: Report,
  readiness: ExchangeReadiness | undefined,
  beforeReconcile: () => Promise<void>,
): Promise<() => void> {
  const signals = getDatabaseSignals(db);
  if (signals.kind !== 'database-notify') throw new Error('Expected PostgreSQL commit notifications');
  if (signals.onDisconnect === undefined) throw new Error('Expected PostgreSQL listener loss notifications');
  let listenerEpoch = 0;
  let terminalWakes = 0;
  const unsubscribeDisconnect = signals.onDisconnect(() => {
    listenerEpoch += 1;
    readiness?.deny();
    report({ kind: 'remote-listener-disconnected' });
  });
  const readTerminal = () =>
    database.transaction(async (tx) => ({
      row: await readRedemptionOwnerRow(tx, RUN_ID),
      facts: await readRedemptionOwnerEndings(tx, RUN_ID),
    }));
  const invalidateTerminal = ({ row, facts }: Awaited<ReturnType<typeof readTerminal>>): void => {
    const key = row?.stored?.accepted.revocationKey;
    if (row?.state !== 'closed' || !row.revoked || facts.length !== 1) {
      throw new Error('Expected a committed closed run and journal fact');
    }
    if (key !== undefined) transport.invalidateExchangeSessions(key);
  };
  const reconcile = async (epoch: number, afterReconnect: boolean): Promise<void> => {
    let pause = afterReconnect;
    while (epoch === listenerEpoch) {
      const observedWakes = terminalWakes;
      const result = await readTerminal();
      if (pause) {
        pause = false;
        await beforeReconcile();
      }
      if (epoch !== listenerEpoch) {
        if (afterReconnect) report({ kind: 'remote-resync-superseded' });
        return;
      }
      if (observedWakes !== terminalWakes) continue;
      if (result.row === undefined) throw new Error('Missing run owner during listener reconciliation');
      if (result.row.state === 'closed') invalidateTerminal(result);
      else if (result.facts.length !== 0) throw new Error('Unexpected terminal fact for an open run');
      readiness?.allow();
      if (afterReconnect) report({ kind: 'remote-resync-reconciled', facts: result.facts.length, terminalWakes });
      return;
    }
  };
  const unsubscribeSignals = signals.subscribe((signal) => {
    if (signal.kind === 'resynced') {
      if (readiness !== undefined) {
        void reconcile(listenerEpoch, true).catch(() => report({ kind: 'failed', stage: 'remote resync' }));
      }
      return;
    }
    if (signal.topic === scope.fence) {
      void readTerminal()
        .then(({ row, facts }) =>
          report({
            kind: 'remote-rollback-fence',
            terminalWakes,
            closed: row?.state === 'closed',
            revoked: row?.revoked === true,
            facts: facts.length,
          }),
        )
        .catch(() => report({ kind: 'failed', stage: 'remote rollback fence' }));
    }
    if (signal.topic === scope.terminal) {
      terminalWakes += 1;
      // A recovery read racing this notification repeats before opening the gate.
      if (readiness?.availability().aborted !== true) {
        void readTerminal()
          .then(invalidateTerminal)
          .then(() => report({ kind: 'remote-terminal-fact', facts: 1 }))
          .catch(() => report({ kind: 'failed', stage: 'remote terminal fact' }));
      }
    }
  });
  const unsubscribe = () => {
    listenerEpoch += 1;
    readiness?.deny();
    unsubscribeSignals();
    unsubscribeDisconnect();
  };
  try {
    const epoch = listenerEpoch;
    await signals.ready();
    if (readiness !== undefined) await reconcile(epoch, false);
    return unsubscribe;
  } catch (error) {
    unsubscribe();
    throw error;
  }
}

/**
 * Bind the two fixture roles to the existing owner close and database signal seams.
 * @param scope - Process role and case-owned topics.
 * @param db - Current process's isolated database handle.
 * @param database - Current process's host transaction facade.
 * @param ownerCall - In-process owner authority for the test order.
 * @param capability - Journal-bound close capability from the fixture owner process.
 * @param beforeReconcile - Supervisor barrier after a replacement listener reads authority.
 * @param runTurn - Serialize the writer's local promotion and committed retirement.
 * @returns Optional worker gate and setup for the listening transport.
 */
export function bindTwoHostWake(
  scope: ExchangeWakeScope,
  db: MakaioDatabase,
  database: HostDatabase,
  ownerCall: CallContext,
  capability: JobRunCapability | undefined,
  beforeReconcile: () => Promise<void>,
  runTurn: (work: () => Promise<void>) => Promise<void>,
) {
  if (scope.role === 'listener') {
    const readiness = scope.listenerTag === undefined ? undefined : createExchangeReadiness();
    return {
      availability: readiness?.availability,
      attach: (transport: ServerTransport, report: Report) =>
        attachSubscriber(scope, database, db, transport, report, readiness, beforeReconcile),
    };
  }
  const attach = async (transport: ServerTransport, report: Report): Promise<() => void> => {
    if (capability === undefined) throw new Error('Missing journal-bound owner');
    const closeRun = async (rollback: boolean): Promise<void> => {
      const interruption = new Error('Test terminal transaction rollback');
      try {
        const key = await database.transaction(async (tx) => {
          await capability.close(ownerCall, {
            tx,
            jobRunId: RUN_ID,
            ending: { kind: 'no-result', outcome: 'lost', cause: 'owner-closed' },
          });
          markTransactionWakeTopic(tx, scope.terminal);
          if (rollback) markTransactionRollbackOnly(tx, interruption);
          return (await readRedemptionOwnerRow(tx, RUN_ID))?.stored?.accepted.revocationKey;
        });
        if (key !== undefined) transport.invalidateExchangeSessions(key);
      } catch (error) {
        if (error !== interruption) throw error;
        await database.transaction(async (tx) => markTransactionWakeTopic(tx, scope.fence));
        return;
      }
      if (rollback) throw new Error('Terminal transaction unexpectedly committed');
      report({ kind: 'run-closed' });
    };
    const command = (message: unknown): void => {
      if (message !== 'close-run' && message !== 'rollback-run') return;
      void runTurn(() => closeRun(message === 'rollback-run')).catch(() =>
        report({ kind: 'failed', stage: 'remote owner closure' }),
      );
    };
    process.on('message', command);
    return () => void process.off('message', command);
  };
  return { availability: undefined, attach };
}
