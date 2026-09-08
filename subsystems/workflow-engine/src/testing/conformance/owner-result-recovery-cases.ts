import { describe, expect, it } from 'vitest';
import type { OutcomeCodec } from '../../execution-attempt-repository.js';
import {
  makeTestInstruction,
  makeBeginProvisioningInput,
  makeTestAllocationRef,
  makeEvidence,
} from '../attempt-fixtures.js';
import { nextIds, TEST_BOOTSTRAP_TIMEOUT_MS } from './attempt-helpers.js';
import { useHarness } from './harness.js';
import type { ExecutionAttemptRepositoryContractFactory, ExecutionAttemptRepositoryContractHarness } from './types.js';

/** Non-workflow mutable payload used to expose accidental sharing across reads. */
interface ValuesOutcome {
  values: number[];
}

/** Minimal non-workflow codec returning newly decoded mutable values. */
const valuesCodec: OutcomeCodec<ValuesOutcome> = {
  parse(input) {
    if (typeof input !== 'object' || input === null || !('values' in input) || !Array.isArray(input.values)) {
      throw new Error('Expected an outcome containing values');
    }
    const values: number[] = [];
    for (const value of input.values) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected finite outcome values');
      values.push(value);
    }
    return { values };
  },
  serialize: (outcome) => JSON.stringify(outcome),
};

type GetHarness = () => ExecutionAttemptRepositoryContractHarness<ValuesOutcome>;

/**
 * Register targeted settlement recovery using a non-workflow owner codec.
 * @param factory - Real persistence realization exercised by the public suite.
 */
export function registerOwnerResultRecoveryCases(factory: ExecutionAttemptRepositoryContractFactory): void {
  describe(`execution attempt owner settlement recovery (${factory.name})`, () => {
    const getHarness = useHarness(factory, valuesCodec);
    registerSettlementStates(getHarness);
    registerCanonicalRecovery(getHarness);
  });
}

/**
 * Register coherent owner-scoped reads for each supported settlement state.
 * @param getHarness - Current suite's initialized realization.
 */
function registerSettlementStates(getHarness: GetHarness): void {
  it('distinguishes absent, wrong-owner, pending, current settled, and historical settled attempts', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    expect(await repository.readAttemptSettlement(ids)).toEqual({ kind: 'not-found' });
    const input = {
      ...ids,
      requestKey: 'initial',
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    };
    const created = await repository.ensureAttempt(input);
    if (created.kind !== 'created') throw new Error('Expected new attempt');
    expect(await peer.readAttemptSettlement({ ...ids, executionId: `${ids.executionId}-wrong` })).toEqual({
      kind: 'not-found',
    });
    expect(await peer.readAttemptSettlement(ids)).toEqual({
      kind: 'unsettled',
      attempt: created.attempt,
      isCurrentAttempt: true,
    });
    const result = repository.canonicalizeOutcome({ values: [1, 2] });
    expect(await repository.commitOutcome({ ...ids, result })).toMatchObject({ kind: 'accepted' });
    expect(await peer.readAttemptSettlement(ids)).toMatchObject({
      kind: 'outcome',
      isCurrentAttempt: true,
      result,
      attempt: { status: 'settled', settlementKind: 'outcome' },
    });
    await peer.ensureAttempt({
      ...input,
      requestKey: 'successor',
      executionAttemptId: `${ids.executionAttemptId}-successor`,
    });
    expect(await repository.readAttemptSettlement(ids)).toMatchObject({
      kind: 'outcome',
      isCurrentAttempt: false,
      result,
    });
    expect(await repository.readAttemptSettlement({ ...ids, executionId: `${ids.executionId}-wrong` })).toEqual({
      kind: 'not-found',
    });
  });

  it('recovers abandonment without inventing an owner outcome', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await repository.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    expect(await repository.abandonPendingAttempt(ids.executionAttemptId, ids.executionId)).toMatchObject({
      kind: 'abandoned',
    });
    const read = await peer.readAttemptSettlement(ids);
    expect(read).toMatchObject({
      kind: 'settled-without-outcome',
      isCurrentAttempt: true,
      attempt: { status: 'settled', settlementKind: 'abandoned' },
    });
    expect(read).not.toHaveProperty('result');
  });

  it('recovers confirmed infrastructure failure without inventing an owner outcome', async () => {
    const { repository, peer } = getHarness();
    const ids = nextIds();
    await repository.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    const provisioning = await repository.beginProvisioning(
      makeBeginProvisioningInput(ids.executionAttemptId, ids.executionId),
    );
    if (provisioning.kind !== 'started') throw new Error('Expected provisioning claim');
    const claim = provisioning.claim;
    expect(await repository.recordAllocation({ claim, allocationRef: makeTestAllocationRef() })).toEqual({
      kind: 'recorded',
    });
    expect(await peer.recordAllocationTerminated({ claim, evidence: makeEvidence() })).toEqual({ kind: 'recorded' });
    expect(await repository.recordInfrastructureFailure({ claim, executionId: ids.executionId })).toEqual({
      kind: 'recorded',
    });
    const read = await peer.readAttemptSettlement(ids);
    expect(read).toMatchObject({
      kind: 'settled-without-outcome',
      isCurrentAttempt: true,
      attempt: { status: 'settled', settlementKind: 'infrastructure-failure' },
    });
    expect(read).not.toHaveProperty('result');
  });
}

/**
 * Register exact-text recovery, independent decode and corrupt-evidence checks.
 * @param getHarness - Current suite's initialized realization.
 */
function registerCanonicalRecovery(getHarness: GetHarness): void {
  it('returns exact stored text and independent decoded outcomes and instruction snapshots on every read', async () => {
    const harness = getHarness();
    const ids = nextIds();
    const instruction = makeTestInstruction({
      workload: { kind: 'values', version: '1', input: { value: 'original' } },
    });
    await harness.repository.createAttempt({ ...ids, instruction, bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS });
    expect(
      await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome({ values: [1, 2] }),
      }),
    ).toMatchObject({ kind: 'accepted' });
    // Different whitespace represents the same valid outcome but is not the
    // codec's serialization: targeted recovery must return the committed bytes.
    const text = '\n { "values" : [1, 2] } \n';
    await harness.writeStoredOutcomeText(ids.executionAttemptId, text);
    const first = await harness.repository.readAttemptSettlement(ids);
    const second = await harness.peer.readAttemptSettlement(ids);
    if (first.kind !== 'outcome' || second.kind !== 'outcome') throw new Error('Expected canonical outcomes');
    expect(first.result.text).toBe(text);
    expect(second.result.text).toBe(text);
    expect(first.result.outcome).toEqual({ values: [1, 2] });
    expect(first.result.outcome).not.toBe(second.result.outcome);
    expect(first.result.outcome.values).not.toBe(second.result.outcome.values);
    first.result.outcome.values.push(999);
    first.attempt.instruction.workload.input = { value: 'changed' };
    expect(second.result.outcome).toEqual({ values: [1, 2] });
    expect(await harness.repository.readAttemptSettlement(ids)).toMatchObject({
      kind: 'outcome',
      result: { text, outcome: { values: [1, 2] } },
      attempt: { instruction },
    });
  });

  it.each([
    '{',
    '{"values":["invalid"]}',
  ])('rejects corrupt canonical outcome text instead of hiding it: %s', async (text) => {
    const harness = getHarness();
    const ids = nextIds();
    await harness.repository.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    expect(
      await harness.repository.commitOutcome({
        ...ids,
        result: harness.repository.canonicalizeOutcome({ values: [1] }),
      }),
    ).toMatchObject({ kind: 'accepted' });
    await harness.writeStoredOutcomeText(ids.executionAttemptId, text);
    await expect(harness.repository.readAttemptSettlement(ids)).rejects.toThrow();
    await expect(harness.peer.readAttemptSettlement(ids)).rejects.toThrow();
  });

  it('rejects outcome text on an unsettled attempt instead of treating it as pending', async () => {
    const harness = getHarness();
    const ids = nextIds();
    await harness.repository.createAttempt({
      ...ids,
      instruction: makeTestInstruction(),
      bootstrapTimeoutMs: TEST_BOOTSTRAP_TIMEOUT_MS,
    });
    await harness.writeStoredOutcomeText(ids.executionAttemptId, '{"values":[1]}');
    await expect(harness.repository.readAttemptSettlement(ids)).rejects.toThrow();
    await expect(harness.peer.readAttemptSettlement(ids)).rejects.toThrow();
  });
}
