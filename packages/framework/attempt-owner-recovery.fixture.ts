/** Consumer-owned modules: every framework import resolves from the installed tarball. */
export const RECOVERY_CONSUMER = String.raw`
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ExecutionAttemptAuthority, isProviderOperationResolved } from '@makaio/framework/workflow-engine';
import { DuplicateExecutionAttemptError } from '@makaio/framework/workflow-engine/execution-attempt-repository';
import {
  beginTestProvisioning, createInMemoryAttemptRepository, makeEvidence, makeTestInstruction,
} from '@makaio/framework/workflow-engine/testing';
import { createSqliteAttemptRepository } from '@makaio/framework/workflow-engine/testing/sqlite';
import { createDatabaseClient } from '@makaio/framework/storage/drizzle/client';

assert.throws(() => createRequire(import.meta.url).resolve('vitest'), { code: 'MODULE_NOT_FOUND' });
assert.equal(typeof DuplicateExecutionAttemptError, 'function');
const codec = {
  parse(input) {
    const value = typeof input === 'number' ? input : input?.counter;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected counter');
    return value;
  },
  serialize: (value) => JSON.stringify({ counter: value }, null, 2),
};
const request = { executionId: 'packed-owner', requestKey: 'initial', instruction: makeTestInstruction() };
const memory = new ExecutionAttemptAuthority(createInMemoryAttemptRepository(codec), { bootstrapTimeoutMs: 30_000 });
const memoryCreated = await memory.ensureAttempt(request);
assert.equal(memoryCreated.kind, 'created');
assert.equal((await memory.ensureAttempt(request)).kind, 'replayed');
const client = await createDatabaseClient({ url: 'file:./attempts.sqlite' });
try {
  const repository = await createSqliteAttemptRepository(client.db, codec);
  const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 30_000 });
  if (process.argv[2] === 'commit') {
    const created = await authority.ensureAttempt(request);
    assert.equal(created.kind, 'created');
    const identity = { executionId: request.executionId, executionAttemptId: created.attempt.executionAttemptId };
    const claim = await beginTestProvisioning(authority, identity.executionAttemptId, identity.executionId);
    const observedAt = new Date(Date.parse(claim.leaseExpiresAt) + 1).toISOString();
    assert.equal((await authority.readAttemptSettlement(identity)).kind, 'unsettled');
    const result = authority.canonicalizeOutcome(0);
    assert.equal((await authority.commitOutcome(identity.executionAttemptId, identity.executionId, result)).kind, 'accepted');
    const open = await authority.listOpenProviderOperations({ observedAt, limit: 1 });
    assert.equal(open.length, 1);
    assert.equal(open[0]?.attempt.executionAttemptId, identity.executionAttemptId);
    assert.equal(open[0]?.operation.completionEvidence, null);
    assert.deepEqual(
      await authority.completeProviderOperation({
        claim,
        evidence: makeEvidence({ summary: 'provider completed its durable operation' }),
      }),
      { kind: 'completed' },
    );
    assert.deepEqual(
      await authority.listOpenProviderOperations({ observedAt, limit: 1 }),
      [],
    );
    const early = await authority.ensureAttempt({ ...request, executionId: 'packed-early', requestKey: 'early-proof' });
    assert.equal(early.kind, 'created');
    const earlyIdentity = { executionId: 'packed-early', executionAttemptId: early.attempt.executionAttemptId };
    const earlyClaim = await beginTestProvisioning(authority, earlyIdentity.executionAttemptId, earlyIdentity.executionId);
    const earlyEvidence = makeEvidence({ summary: 'provider proof retained before attempt settlement' });
    assert.equal(authority.waitForOutcome(earlyIdentity.executionAttemptId), undefined);
    assert.deepEqual(await authority.completeProviderOperation({ claim: earlyClaim, evidence: earlyEvidence }), {
      kind: 'evidence-recorded',
    });
    assert.equal(isProviderOperationResolved(early.attempt, await authority.getProviderOperation(earlyIdentity.executionAttemptId)), false);
    assert.deepEqual(await authority.handoffProviderOperation({ claim: earlyClaim }), { kind: 'recorded' });
    // No owner convergence or Worker resubmission occurs before this process exits.
    await writeFile(
      'receipt.json',
      JSON.stringify({ identity, result, deadline: created.attempt.bootstrapDeadlineAt, observedAt, earlyIdentity, earlyEvidence }),
    );
    console.log(JSON.stringify({ committed: true }));
  } else {
    assert.equal(process.argv[2], 'recover');
    const receipt = JSON.parse(await readFile('receipt.json', 'utf8'));
    const restarted = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 1 });
    const replay = await restarted.ensureAttempt(request);
    assert.equal(replay.kind, 'replayed');
    assert.equal(replay.attempt.executionAttemptId, receipt.identity.executionAttemptId);
    assert.equal(replay.attempt.bootstrapDeadlineAt, receipt.deadline);
    const settlement = await restarted.readAttemptSettlement(receipt.identity);
    assert.equal(settlement.kind, 'outcome');
    assert.equal(settlement.isCurrentAttempt, true);
    assert.equal(settlement.result.text, receipt.result.text);
    assert.equal(settlement.result.outcome, 0);
    const open = await restarted.listOpenProviderOperations({ observedAt: receipt.observedAt, limit: 10 });
    assert.equal(open.length, 1);
    assert.equal(open[0].attempt.executionAttemptId, receipt.earlyIdentity.executionAttemptId);
    assert.deepEqual(open[0].operation.completionEvidence, receipt.earlyEvidence);
    assert.equal(restarted.waitForOutcome(receipt.earlyIdentity.executionAttemptId), undefined);
    assert.equal((await restarted.commitOutcome(
      receipt.earlyIdentity.executionAttemptId, receipt.earlyIdentity.executionId, restarted.canonicalizeOutcome(1),
    )).kind, 'accepted');
    const earlyAttempt = await restarted.getAttemptWithAllocation(receipt.earlyIdentity.executionAttemptId);
    const earlyOperation = await restarted.getProviderOperation(receipt.earlyIdentity.executionAttemptId);
    assert.equal(isProviderOperationResolved(earlyAttempt, earlyOperation), true);
    assert.deepEqual(await restarted.listOpenProviderOperations({ observedAt: receipt.observedAt, limit: 10 }), []);
    console.log(JSON.stringify({ replay: replay.kind, settlement: settlement.kind, result: settlement.result }));
  }
} finally {
  await client.close();
}
`;

/** A proper Vitest consumer registers the complete callable contract against its reference store. */
export const CONFORMANCE_CONSUMER = String.raw`
import { runExecutionAttemptRepositoryContract } from '@makaio/framework/workflow-engine/testing/conformance';
import {
  createInMemoryAttemptRepository, makeTestInstruction, driveTestAttemptToAllocated,
} from '@makaio/framework/workflow-engine/testing';

runExecutionAttemptRepositoryContract({
  name: 'installed-memory',
  async create(codec) {
    const repository = createInMemoryAttemptRepository(codec);
    const update = (id, changes) => {
      const attempt = repository.attempts.get(id);
      if (!attempt) throw new Error('Missing fixture attempt');
      repository.attempts.set(id, { ...attempt, ...changes });
    };
    return {
      repository,
      peer: createInMemoryAttemptRepository(codec, repository),
      writeStoredOutcomeText: async (id, text) => { repository.committedOutcomes.set(id, text); },
      setClaimExpiry: async (id, claimExpiresAt) => { update(id, { claimExpiresAt }); },
      clearStoredBootstrapDeadline: async (id) => { update(id, { bootstrapDeadlineAt: null }); },
      seedRecoverableAttempts: async ({ executionId, entries }) => {
        for (const { executionAttemptId } of entries) {
          await repository.createAttempt({
            executionId, executionAttemptId, instruction: makeTestInstruction(), bootstrapTimeoutMs: 30_000,
          });
          await driveTestAttemptToAllocated(repository, executionAttemptId, executionId);
        }
        for (const { executionAttemptId, createdAt } of entries) {
          update(executionAttemptId, { createdAt, claimable: true, claimExpiresAt: null });
        }
      },
      dispose() {},
    };
  },
});
`;

/** Positive and negative type witnesses against installed declarations, not source aliases. */
export const TYPES_CONSUMER = String.raw`
import { ExecutionAttemptAuthority, isProviderOperationResolved } from '@makaio/framework/workflow-engine';
import { captureWorkflowExecutionBusSecretCleanup } from '@makaio/framework/runtime-node';
import { captureHmacIdentitySecretCleanup } from '@makaio/framework/node/transports';
import type {
  AttemptSettlementRead, CompleteProviderOperationInput, EnsureExecutionAttemptInput,
  EnsureExecutionAttemptDecision, EnsureExecutionAttemptPersistenceInput,
  ListOpenProviderOperationsInput, OpenProviderOperationRecord,
  ProviderOperationCompletionDecision, ReadAttemptSettlementInput,
} from '@makaio/framework/workflow-engine';
import type { BoundedRecoveryEvidence } from '@makaio/framework/contracts/capabilities';
import type { ExecutionAttemptRepository, OutcomeCodec } from '@makaio/framework/workflow-engine/execution-attempt-repository';
import type { EnsureExecutionAttemptInput as RepositoryOwnerInput } from '@makaio/framework/workflow-engine/execution-attempt-repository';
import { createInMemoryAttemptRepository, makeTestInstruction } from '@makaio/framework/workflow-engine/testing';
import { createSqliteAttemptRepository } from '@makaio/framework/workflow-engine/testing/sqlite';
import { createDatabaseClient } from '@makaio/framework/storage/drizzle/client';
import type { ExecutionAttemptRepositoryContractFactory } from '@makaio/framework/workflow-engine/testing/conformance';

export type PublicFactory = ExecutionAttemptRepositoryContractFactory;
export const request: EnsureExecutionAttemptInput = {
  executionId: 'owner', requestKey: 'initial', instruction: makeTestInstruction(),
};
export const repositoryRequest: RepositoryOwnerInput = request;
export const persistence: EnsureExecutionAttemptPersistenceInput = {
  ...request, executionAttemptId: 'candidate', bootstrapTimeoutMs: 30_000,
};
export const recoverySelector: ListOpenProviderOperationsInput = {
  observedAt: '2026-09-08T12:00:00.000Z', limit: 1,
};
export const completionEvidence: BoundedRecoveryEvidence = {
  source: 'installed-consumer', summary: 'provider operation completed', observedAt: '2026-09-08T12:00:01.000Z',
};
export async function completeOpenOperation(
  authority: ExecutionAttemptAuthority<number>, input: CompleteProviderOperationInput,
): Promise<ProviderOperationCompletionDecision> {
  return authority.completeProviderOperation(input);
}
export async function listOpenOperations(
  authority: ExecutionAttemptAuthority<number>, input: ListOpenProviderOperationsInput,
): Promise<readonly OpenProviderOperationRecord[]> {
  return authority.listOpenProviderOperations(input);
}
export function operationIsResolved(record: OpenProviderOperationRecord): boolean {
  return isProviderOperationResolved(record.attempt, record.operation);
}
export function captureGenericBusSecretCleanup(identityId: string): (() => void) | undefined {
  return captureHmacIdentitySecretCleanup(identityId);
}
export function captureWorkflowBusSecretCleanup(
  executionAttemptId: string, executionId: string,
): (() => void) | undefined {
  return captureWorkflowExecutionBusSecretCleanup({ executionAttemptId, executionId });
}
export async function compose(codec: OutcomeCodec<number>) {
  const memory: ExecutionAttemptRepository<number> = createInMemoryAttemptRepository(codec);
  const client = await createDatabaseClient({ url: ':memory:' });
  try {
    const sqlite: ExecutionAttemptRepository<number> = await createSqliteAttemptRepository(client.db, codec);
    const authority = new ExecutionAttemptAuthority(sqlite, { bootstrapTimeoutMs: 30_000 });
    const created: EnsureExecutionAttemptDecision = await authority.ensureAttempt(request);
    const persisted: EnsureExecutionAttemptDecision = await memory.ensureAttempt(persistence);
    if (created.kind === 'conflict') return persisted;
    const identity: ReadAttemptSettlementInput = {
      executionId: request.executionId, executionAttemptId: created.attempt.executionAttemptId,
    };
    const result: AttemptSettlementRead<number> = await authority.readAttemptSettlement(identity);
    const stored: AttemptSettlementRead<number> = await sqlite.readAttemptSettlement(identity);
    if (result.kind === 'outcome') {
      const counter: number = result.result.outcome;
      // @ts-expect-error The installed generic outcome remains checked.
      const invalid: string = result.result.outcome;
      return { counter, stored };
    }
    return stored;
  } finally { await client.close(); }
}
// @ts-expect-error The owner request identity is mandatory.
export const missingKey: EnsureExecutionAttemptInput = { executionId: 'owner', instruction: makeTestInstruction() };
export function missingResult(read: AttemptSettlementRead<number>) {
  if (read.kind === 'unsettled') {
    const attempt = read.attempt;
    // @ts-expect-error A pending read must not fabricate a canonical outcome.
    const result = read.result;
    return { attempt, result };
  }
}
`;
