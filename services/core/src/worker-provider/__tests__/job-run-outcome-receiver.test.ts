import { ConnectionLostError, NoHandlerError, TimeoutError } from '@makaio/bus-core';
import type { HostDatabase } from '@makaio/contracts';
import type { JobRunResult } from '@makaio/contracts/workflow';
import { CorePartyKind, getFullSubjectForSubjectDefinition } from '@makaio/core';
import { submitJobRunOutcomeWithAck } from '@makaio/runtime-node/workflow-worker';
import {
  resolveStorageConformanceConfig,
  useJournalHostFixture,
  useSuiteDatabaseContext,
} from '@makaio/storage-conformance';
import { createHostDatabase } from '@makaio/storage-drizzle';
import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  bookOutcomeRun,
  connectOutcomeWorker,
  ownerName,
  startOutcomeHost,
  subject,
  testProof,
} from './job-run-outcome-fixture.js';
import { migrateRedemptionOwner } from './redemption-owner-fixture.js';
import { requireWorkerRunSessionRetirement, WorkerRunSessionRetirementError } from '../worker-run-sessions.js';

const config = resolveStorageConformanceConfig();
if (config === null) throw new Error('MAKAIO_STORAGE_TEST_URL is required for PostgreSQL outcome acceptance tests');

const accepted = { decision: 'accepted' } as const;
const first = { version: 1 };
const conflict = { decision: 'refused', code: 'outcome-conflict', retryable: false };
const notOwn = { decision: 'refused', code: 'not-own-job-run', retryable: false };
const lost = { kind: 'no-result', outcome: 'lost', cause: 'provider-ended' } as const;

/**
 * Construct a canonical terminal result for a test booking.
 * @param jobRunId - Run named on the authenticated wire.
 * @returns Successful outcome containing a mutable draft used to check snapshotting.
 */
function completion(jobRunId: string) {
  return { jobRunId, workflowId: 'workflow', status: 'completed' as const, submission: { values: [1] } };
}

describe(`ordered outcome receiver (${config.dialect})`, () => {
  const storage = useSuiteDatabaseContext(config);
  const { constructContext } = useJournalHostFixture(storage);
  let database: HostDatabase;
  beforeAll(async () => {
    database = createHostDatabase(storage().db);
    await migrateRedemptionOwner(storage());
  });

  /**
   * Boot a receiver with the suite's persistent storage.
   * @param behavior - Reply calculation and optional transaction barriers.
   * @returns Active receiver and contribution.
   */
  function start(behavior?: Parameters<typeof startOutcomeHost>[3]) {
    return startOutcomeHost(storage(), database, constructContext, behavior);
  }

  it('reports missing session retirement on an enabled host after the outcome commits', async () => {
    const host = await start();
    const id = 'missing-session-retirement';
    const booking = await bookOutcomeRun(host, database, id);
    const worker = await connectOutcomeWorker(host.port, testProof(id));
    const availability = new AbortController();
    const retirement = requireWorkerRunSessionRetirement(database, (error) => availability.abort(error));
    onTestFinished(retirement.release);

    await worker.submit(completion(id));
    expect(availability.signal.reason).toBeInstanceOf(WorkerRunSessionRetirementError);
    expect(availability.signal.reason).toMatchObject({ code: 'WORKER_RUN_SESSION_RETIREMENT_FAILED' });
    await expect(booking.read()).resolves.toMatchObject({ state: 'closed', effects: 1 });
  });

  it.each([false, true])('serializes simultaneous submissions (different=%s)', async (different) => {
    const id = `race-${different}`;
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const winner = await start({
      async handle(_input, commit) {
        firstEntered.resolve();
        await release.promise;
        await commit();
        return accepted;
      },
    });
    const sibling = config.dialect === 'postgres' ? await storage().createSiblingClient({ poolMax: 1 }) : undefined;
    if (sibling !== undefined) onTestFinished(() => sibling.close());
    const rival = await startOutcomeHost(
      sibling ?? storage(),
      sibling === undefined ? database : createHostDatabase(sibling.db),
      constructContext,
      {
        async handle(_input, commit) {
          secondEntered.resolve();
          await release.promise;
          await commit();
          return accepted;
        },
      },
    );
    const booking = await bookOutcomeRun(winner, database, id);
    const proof = testProof(id);
    const worker = await connectOutcomeWorker(winner.port, proof);
    const other = await connectOutcomeWorker(rival.port, proof);
    const result = completion(id);
    const changed = different ? { ...result, submission: { values: [2] } } : result;
    const left = worker.submit(result);
    const right = other.submit(changed);
    try {
      await Promise.race([Promise.all([firstEntered.promise, secondEntered.promise]), left, right]);
    } finally {
      release.resolve();
    }
    const responses = await Promise.all([left, right]);
    expect(responses).toContainEqual({ decision: 'accepted', answer: first });
    expect(responses).toContainEqual(different ? conflict : { decision: 'duplicate', answer: first });
    const row = await booking.read();
    expect(row).toMatchObject({ state: 'closed', effects: 1, receipt: { answer: first } });
    await expect(booking.journal()).resolves.toEqual([{ jobRunId: id, ending: row?.ending }]);
    await expect(worker.submit(row?.receipt?.result ?? result)).resolves.toEqual({
      decision: 'duplicate',
      answer: first,
    });
  });

  it('checks ingress and exact ownership before any acceptance', async () => {
    const host = await start({ owner: `${ownerName}.other` });
    const id = 'intake-ownership';
    const booking = await bookOutcomeRun(host, database, id);
    const result = completion(id);
    expect(() => host.bus.on(subject, () => {})).toThrow('already has a handler');
    const foreign = await connectOutcomeWorker(host.port, testProof('foreign'));
    const nonRun = await connectOutcomeWorker(host.port, testProof('non-run', CorePartyKind.e2ePeer));
    const worker = await connectOutcomeWorker(host.port, testProof(id));
    const before = host.reads();
    await expect(foreign.submit(result)).resolves.toEqual(notOwn);
    await expect(nonRun.submit(completion('non-run'))).resolves.toEqual(notOwn);
    await expect(host.bus.request(host.bus.own('root'), subject, { result })).resolves.toEqual(notOwn);
    expect(host.reads()).toBe(before);
    await expect(foreign.submit(completion('foreign'))).resolves.toMatchObject({ code: 'run-unknown' });
    await expect(worker.submit(result)).resolves.toMatchObject({ code: 'owner-unavailable', retryable: true });
    const [otherOwner] = host.activations;
    if (otherOwner === undefined) throw new Error('Expected a contributed owner');
    await expect(
      database.transaction((tx) => otherOwner.close(otherOwner.call, { tx, jobRunId: id, ending: lost })),
    ).rejects.toMatchObject({ code: 'not-acceptance-owner' });
    expect(host.attempts).toHaveLength(0);
    await expect(booking.read()).resolves.toMatchObject({ effects: 0, receipt: null, state: 'redeemed' });
  });

  it('refuses a malformed authenticated request before reading storage', async () => {
    const host = await start();
    const id = 'malformed-outcome';
    const worker = await connectOutcomeWorker(host.port, testProof(id), false);
    const before = host.reads();
    await expect(worker.submit({ ...completion(id), workflowId: '' })).resolves.toEqual({
      decision: 'refused',
      code: 'outcome-invalid',
      retryable: false,
    });
    expect(host.reads()).toBe(before);
  });

  it('reports an unavailable owner when a redeemed order has no outcome adapter', async () => {
    const host = await start({ redemptionOnly: true });
    const id = 'redemption-without-outcome-adapter';
    const booking = await bookOutcomeRun(host, database, id);
    const worker = await connectOutcomeWorker(host.port, testProof(id));

    await expect(worker.submit(completion(id))).resolves.toEqual({
      decision: 'refused',
      code: 'owner-unavailable',
      retryable: true,
    });
    expect(host.attempts).toHaveLength(0);
    await expect(booking.read()).resolves.toMatchObject({ state: 'redeemed', effects: 0, receipt: null });
  });

  it('rolls back owner refusal, transient failure and an unknown fault before accepting', async () => {
    let attempt = 0;
    const refusal = new Error('owner policy');
    const transient = new Error('temporary owner contention');
    const unknown = new Error('unexpected owner fault');
    const host = await start({
      async handle(_input, commit) {
        const fault = [refusal, unknown, transient][attempt++];
        try {
          await commit(async () => {
            if (fault !== undefined) throw fault;
          });
        } catch (error) {
          if (error === refusal) return { decision: 'refused', code: 'policy', retryable: false };
          if (error === transient) return { decision: 'refused', code: 'contention', retryable: true };
          throw error;
        }
        return accepted;
      },
    });
    const id = 'rollback-and-retry';
    const booking = await bookOutcomeRun(host, database, id);
    const worker = await connectOutcomeWorker(host.port, testProof(id));
    const result = completion(id);
    await expect(worker.submit(result)).resolves.toMatchObject({
      decision: 'refused',
      code: 'policy',
      owner: ownerName,
    });
    await expect(worker.submit(result)).rejects.toThrow('unexpected owner fault');
    await expect(booking.read()).resolves.toMatchObject({ state: 'redeemed', effects: 0, receipt: null });
    await expect(booking.journal()).resolves.toEqual([]);
    await expect(
      submitJobRunOutcomeWithAck(worker.call, worker.bus, { result }, { retry: { maxRetries: 1, baseDelayMs: 1 } }),
    ).resolves.toEqual({ decision: 'accepted', answer: first });
    await expect(booking.read()).resolves.toMatchObject({ state: 'closed', effects: 1 });
  });

  it('faults when the owner claims it accepted without committing the close', async () => {
    const host = await start({ handle: async () => accepted });
    const id = 'missing-commit';
    const booking = await bookOutcomeRun(host, database, id);
    const worker = await connectOutcomeWorker(host.port, testProof(id));
    await expect(worker.submit(completion(id))).rejects.toThrow('Outcome owner accepted without committing the close');
    await expect(booking.read()).resolves.toMatchObject({ state: 'redeemed', effects: 0, receipt: null });
    await expect(booking.journal()).resolves.toEqual([]);
  });

  it.each(['refuses', 'throws'] as const)('uses the committed answer when the owner %s after closing', async (exit) => {
    const host = await start({
      async handle(_input, commit) {
        await commit();
        if (exit === 'throws') throw new Error('post-commit owner fault');
        return { decision: 'refused', code: 'policy', retryable: false };
      },
    });
    const id = `committed-owner-${exit}`;
    const booking = await bookOutcomeRun(host, database, id);
    const worker = await connectOutcomeWorker(host.port, testProof(id));
    const result = completion(id);
    await expect(worker.submit(result)).resolves.toEqual({ decision: 'accepted', answer: first });
    await expect(worker.submit(result)).resolves.toEqual({ decision: 'duplicate', answer: first });
    await expect(booking.read()).resolves.toMatchObject({
      state: 'closed',
      effects: 1,
      receipt: { result, answer: first },
    });
    await expect(booking.journal()).resolves.toEqual([{ jobRunId: id, ending: { kind: 'result', result } }]);
    expect(host.attempts).toHaveLength(1);
  });

  it('returns the first committed answer after host restart and refuses a revoked replay', async () => {
    const committed = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<void>();
    const host = await start({
      async handle(_input, commit) {
        await commit();
        committed.resolve();
        await reply.promise;
        return accepted;
      },
    });
    const id = 'restart-replay';
    const booking = await bookOutcomeRun(host, database, id);
    const proof = testProof(id);
    const worker = await connectOutcomeWorker(host.port, proof);
    const result = completion(id);
    const lostReply = worker.submit(result);
    const disconnected = expect(lostReply).rejects.toThrow(ConnectionLostError);
    try {
      await Promise.race([committed.promise, lostReply]);
      await host.stop();
      await disconnected;
    } finally {
      reply.resolve();
    }
    const restarted = await start({ answer: { version: 2 } });
    const reconnected = await connectOutcomeWorker(restarted.port, proof);
    await expect(reconnected.submit(result)).resolves.toEqual({ decision: 'duplicate', answer: first });
    await booking.revoke();
    await expect(reconnected.submit(result)).resolves.toEqual(notOwn);
    expect(restarted.attempts).toHaveLength(0);
    await expect(booking.read()).resolves.toMatchObject({
      state: 'closed',
      effects: 1,
      revoked: true,
      receipt: { result, answer: first },
    });
    await expect(booking.journal()).resolves.toHaveLength(1);
  });

  it('fences a result at commit and rolls back even when the owner caught a failed close', async () => {
    let time = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
    onTestFinished(() => clock.mockRestore());
    const end = time + 5_000;
    const id = 'result-commit-deadline';
    const host = await start({
      async handle(_input, commit) {
        await commit(async () => {
          time = end;
        });
        return accepted;
      },
    });
    const booking = await bookOutcomeRun(host, database, id, { expiresAt: end });
    const worker = await connectOutcomeWorker(host.port, testProof(id));
    await expect(worker.submit(completion(id))).resolves.toMatchObject({ code: 'run-not-running' });
    await expect(booking.read()).resolves.toMatchObject({ state: 'redeemed', effects: 0, receipt: null });
    const [owner] = host.activations;
    if (owner === undefined) throw new Error('Expected the active owner');
    await host.coordinator.applyExtensionTransition(ownerName, false);
    await expect(
      database.transaction(async (tx) => {
        await expect(owner.close(owner.call, { tx, jobRunId: id, ending: lost })).rejects.toMatchObject({
          code: 'engine-not-active',
        });
      }),
    ).rejects.toMatchObject({ code: 'engine-not-active' });
    await expect(booking.journal()).resolves.toEqual([]);
  });

  it('applies the cancellation window to new results', async () => {
    let time = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
    onTestFinished(() => clock.mockRestore());
    const host = await start();
    const [owner] = host.activations;
    if (owner === undefined) throw new Error('Expected an active owner');
    const id = 'timely-cancellation';
    const booking = await bookOutcomeRun(host, database, id);
    const worker = await connectOutcomeWorker(host.port, testProof(id));
    await database.transaction(booking.withJournal(owner.call).cancelIn);
    await expect(worker.submit(completion(id))).resolves.toMatchObject({ code: 'run-not-running' });
    expect(host.attempts).toHaveLength(0);
    const cancelled = { ...completion(id), status: 'cancelled' } as const;
    await expect(worker.submit(cancelled)).resolves.toEqual({ decision: 'accepted', answer: first });
    await expect(booking.read()).resolves.toMatchObject({ state: 'closed', receipt: { result: cancelled } });

    const lateId = 'after-result-window';
    const expiresAt = time + 5_000;
    const late = await bookOutcomeRun(host, database, lateId, { expiresAt });
    const latePeer = await connectOutcomeWorker(host.port, testProof(lateId));
    time = expiresAt;
    await expect(latePeer.submit(completion(lateId))).resolves.toMatchObject({ decision: 'refused' });
    await expect(late.read()).resolves.toMatchObject({ state: 'redeemed', effects: 0, receipt: null });
    await expect(late.journal()).resolves.toEqual([]);
  });

  it('refuses ordered and no-result closed runs and preserves the single terminal fact', async () => {
    const host = await start();
    const id = 'no-result-before-outcome';
    const booking = await bookOutcomeRun(host, database, id, { redeemed: false });
    const worker = await connectOutcomeWorker(host.port, testProof(id));
    const [owner] = host.activations;
    if (owner === undefined) throw new Error('Expected the active owner');
    await expect(worker.submit(completion(id))).resolves.toMatchObject({ decision: 'refused' });
    await database.transaction((tx) => owner.close(owner.call, { tx, jobRunId: id, ending: lost }));
    await expect(worker.submit(completion(id))).resolves.toMatchObject({ decision: 'refused' });
    expect(host.attempts).toHaveLength(0);
    await expect(booking.read()).resolves.toMatchObject({ state: 'closed', effects: 0, receipt: null });
    await expect(booking.journal()).resolves.toEqual([{ jobRunId: id, ending: lost }]);
  });

  it.each(['result', 'no-result'] as const)('keeps only the winning %s terminal write', async (winner) => {
    const id = `winner-${winner}`;
    const blocked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const host = await start({
      async handle(_input, commit) {
        if (winner === 'no-result') {
          blocked.resolve();
          await release.promise;
          await commit();
        } else {
          await commit(async () => {
            blocked.resolve();
            await release.promise;
          });
        }
        return accepted;
      },
    });
    const booking = await bookOutcomeRun(host, database, id);
    const peer = await connectOutcomeWorker(host.port, testProof(id));
    const [owner] = host.activations;
    if (owner === undefined) throw new Error('Expected the active owner');
    const close = () => database.transaction((tx) => owner.close(owner.call, { tx, jobRunId: id, ending: lost }));
    const result = completion(id);
    const submitting = peer.submit(result);
    let losingClose: Promise<void> | undefined;
    try {
      await Promise.race([blocked.promise, submitting]);
      if (winner === 'no-result') {
        await close();
      } else {
        losingClose = expect(close()).rejects.toMatchObject({ code: 'run-not-running' });
      }
    } finally {
      release.resolve();
    }
    if (winner === 'result') {
      await expect(submitting).resolves.toEqual({ decision: 'accepted', answer: first });
      await losingClose;
    } else {
      await expect(submitting).resolves.toMatchObject({ decision: 'refused' });
    }
    const ending = winner === 'result' ? { kind: 'result', result } : lost;
    await expect(booking.journal()).resolves.toEqual([{ jobRunId: id, ending }]);
    await expect(booking.read()).resolves.toMatchObject({
      state: 'closed',
      effects: winner === 'result' ? 1 : 0,
      receipt: winner === 'result' ? { result, answer: first } : null,
    });
  });

  it('rolls back a prepared close on owner withdrawal and allows a new host to accept', async () => {
    const prepared = Promise.withResolvers<void>();
    const unwind = Promise.withResolvers<void>();
    const id = 'withdraw-while-prepared';
    const host = await start({
      async handle(_input, commit) {
        await commit(async () => {
          prepared.resolve();
          await unwind.promise;
        });
        return accepted;
      },
    });
    const booking = await bookOutcomeRun(host, database, id);
    const proof = testProof(id);
    const peer = await connectOutcomeWorker(host.port, proof);
    const result = completion(id);
    const pending = peer.submit(result);
    try {
      await Promise.race([prepared.promise, pending]);
      await host.coordinator.applyExtensionTransition(ownerName, false);
    } finally {
      unwind.resolve();
    }
    await expect(pending).resolves.toMatchObject({ code: 'owner-unavailable', retryable: true });
    await expect(booking.read()).resolves.toMatchObject({ state: 'redeemed', effects: 0, receipt: null });
    await expect(peer.submit(result)).resolves.toMatchObject({ code: 'owner-unavailable', retryable: true });
    await host.stop();
    const next = await start({ answer: { version: 2 } });
    const other = await connectOutcomeWorker(next.port, proof);
    await expect(other.submit(result)).resolves.toEqual({ decision: 'accepted', answer: { version: 2 } });
    await expect(booking.journal()).resolves.toHaveLength(1);
  });

  it.each([false, true])('reconnects after losing a committed reply (proof revoked=%s)', async (revoked) => {
    let interrupt = () => {};
    const id = `retry-disconnected-result-${revoked}`;
    const host = await start({
      keepProof: !revoked,
      async handle(_input, commit) {
        await commit();
        interrupt();
        return accepted;
      },
    });
    interrupt = host.dropConnections;
    const booking = await bookOutcomeRun(host, database, id);
    const worker = await connectOutcomeWorker(host.port, testProof(id));
    let reconnects = 0;
    const result = completion(id);
    const delivery = submitJobRunOutcomeWithAck(
      worker.call,
      worker.bus,
      { result },
      {
        reconnect: () => {
          reconnects++;
          return worker.bus.reconnect();
        },
        retry: { maxRetries: 2, baseDelayMs: 1 },
      },
    );
    if (revoked) {
      await expect(delivery).rejects.toMatchObject({
        reason: 'receipt-unconfirmed',
        message: 'Job run outcome submitted, receipt unconfirmed',
        refusal: notOwn,
      });
    } else {
      await expect(delivery).resolves.toEqual({ decision: 'duplicate', answer: first });
    }
    expect(reconnects).toBe(1);
    await expect(booking.read()).resolves.toMatchObject({
      state: 'closed',
      effects: 1,
      revoked,
      receipt: { result, answer: first },
    });
    expect(host.attempts).toHaveLength(1);
  });

  it('keeps an in-time commit when the delivery deadline expires', async () => {
    const committed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const id = 'late-delivery';
    const host = await start({
      async handle(_input, commit) {
        await commit();
        committed.resolve();
        await release.promise;
        return accepted;
      },
    });
    const booking = await bookOutcomeRun(host, database, id);
    const worker = await connectOutcomeWorker(host.port, testProof(id));
    const result = completion(id);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const reply = worker.bus.request(worker.call, subject, { result }, { timeout: 200 });
    const timedOut = expect(reply).rejects.toThrow(TimeoutError);
    try {
      await Promise.race([committed.promise, reply]);
      await vi.advanceTimersByTimeAsync(201);
      await timedOut;
    } finally {
      vi.useRealTimers();
      release.resolve();
    }
    await expect(worker.submit(result)).resolves.toEqual({ decision: 'duplicate', answer: first });
    await expect(booking.journal()).resolves.toHaveLength(1);
  });

  it('freezes the retry snapshot and stops immediately on conflict', async () => {
    const id = 'snapshot-retry';
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let count = 0;
    const host = await start({
      async handle(_input, commit) {
        if (count++ === 0) {
          entered.resolve();
          await release.promise;
          return { decision: 'refused', code: 'try-later', retryable: true };
        }
        await commit();
        return accepted;
      },
    });
    const booking = await bookOutcomeRun(host, database, id);
    const worker = await connectOutcomeWorker(host.port, testProof(id));
    const mutable = completion(id);
    const sending = submitJobRunOutcomeWithAck(
      worker.call,
      worker.bus,
      { result: mutable },
      { retry: { baseDelayMs: 1 } },
    );
    try {
      await Promise.race([entered.promise, sending]);
      mutable.submission.values.push(2);
    } finally {
      release.resolve();
    }
    await expect(sending).resolves.toEqual({ decision: 'accepted', answer: first });
    const changed: JobRunResult = mutable;
    await expect(submitJobRunOutcomeWithAck(worker.call, worker.bus, { result: changed })).rejects.toMatchObject({
      message: 'Job run outcome refused: outcome-conflict',
      reason: 'authority-rejected',
      refusal: conflict,
    });
    expect(host.attempts.map(({ result }) => result)).toEqual([completion(id), completion(id)]);
    await expect(booking.read()).resolves.toMatchObject({ effects: 1, receipt: { result: completion(id) } });
  });

  it('retries a missing receiver until the new host advertises it', async () => {
    const id = 'receiver-startup';
    const host = await start({ deferReceiverRegistration: true });
    const booking = await bookOutcomeRun(host, database, id);
    const worker = await connectOutcomeWorker(host.port, testProof(id));
    const result = completion(id);
    const fullSubject = getFullSubjectForSubjectDefinition(subject);
    const advertised = Promise.withResolvers<void>();
    onTestFinished(
      worker.transport.onReceive(async (message) => {
        if (message.type === 'subscribe' && fullSubject in message.subjects) advertised.resolve();
      }),
    );
    await expect(worker.submit(result)).rejects.toBeInstanceOf(NoHandlerError);
    const delivery = submitJobRunOutcomeWithAck(
      worker.call,
      worker.bus,
      { result },
      {
        reconnect: async () => {
          host.registerOutcomeReceiver();
          await advertised.promise;
        },
        retry: { maxRetries: 1, baseDelayMs: 1 },
      },
    );
    await expect(delivery).resolves.toEqual({ decision: 'accepted', answer: first });
    expect(host.attempts).toHaveLength(1);
    await expect(booking.read()).resolves.toMatchObject({ effects: 1, receipt: { result, answer: first } });
  });
});
