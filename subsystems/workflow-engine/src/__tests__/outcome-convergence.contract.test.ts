import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionAttemptAuthority } from '../execution-attempt-authority.js';
import { submitAttemptOutcome, type OutcomeConvergence, type OutcomeConvergenceInput } from '../outcome-convergence.js';
import {
  createInMemoryAttemptRepository,
  makeTestInstruction,
  type InMemoryAttemptRepository,
} from '../testing/index.js';
// A non-workflow outcome, so the suite proves the boundary is shape-agnostic.
// Any host that reuses the generic substrate can run this suite against its
// own outcome type by swapping the codec and the convergence fake.
import {
  boxedCounterCodec,
  counterCodec,
  invalidCounterOutcome,
  roundingCounterCodec,
  type BoxedCounterOutcome,
  type CounterOutcome,
} from '../testing/conformance/counter-outcome.js';
import { memberOrderCodec, type MemberOrderOutcome } from './member-order-outcome.js';
import { urlOutcomeCodec } from '../testing/conformance/url-outcome.js';

const EXECUTION_ID = 'owner-1';

/** Convergence that records every call and can be made to throw once. */
type ConvergenceFake<TOutcome> = OutcomeConvergence<TOutcome> & {
  readonly calls: OutcomeConvergenceInput<TOutcome>[];
  failNext: Error | undefined;
};

/**
 * Build a {@link ConvergenceFake}.
 * @typeParam TOutcome - Outcome type the boundary carries.
 */
function createConvergenceFake<TOutcome>(): ConvergenceFake<TOutcome> {
  const calls: OutcomeConvergenceInput<TOutcome>[] = [];
  return {
    calls,
    failNext: undefined,
    async converge(input) {
      calls.push(input);
      if (this.failNext !== undefined) {
        const error = this.failNext;
        this.failNext = undefined;
        throw error;
      }
    },
  };
}

/**
 * Observe whether a promise has settled without awaiting it.
 * @param promise - Promise under observation.
 * @returns `pending`, `resolved`, or `rejected` after one macrotask.
 */
async function settlementOf(promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  promise.then(
    () => {
      state = 'resolved';
    },
    () => {
      state = 'rejected';
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return state;
}

describe('submitAttemptOutcome (generic contract)', () => {
  let repository: InMemoryAttemptRepository<CounterOutcome>;
  let authority: ExecutionAttemptAuthority<CounterOutcome>;
  let convergence: ConvergenceFake<CounterOutcome>;

  beforeEach(() => {
    repository = createInMemoryAttemptRepository(counterCodec);
    authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 60_000 });
    convergence = createConvergenceFake<CounterOutcome>();
  });

  it('commits before converging and settles the waiter only after convergence resolves', async () => {
    const attempt = await authority.createAttempt(EXECUTION_ID, makeTestInstruction());
    const waiter = authority.waitForOutcome(attempt.executionAttemptId);
    expect(waiter).toBeDefined();
    // The durable fact, read the way a store is read: the committed text.
    let committedWhenConverging: string | undefined;
    convergence.converge = async (input) => {
      convergence.calls.push(input);
      committedWhenConverging = repository.committedOutcomes.get(attempt.executionAttemptId);
    };

    const decision = await submitAttemptOutcome(
      { authority, convergence },
      { executionId: EXECUTION_ID, executionAttemptId: attempt.executionAttemptId, outcome: 1 },
    );

    expect(decision).toBe('accepted');
    expect(committedWhenConverging).toBe('{"counter":1}');
    expect(convergence.calls).toEqual([
      {
        executionId: EXECUTION_ID,
        executionAttemptId: attempt.executionAttemptId,
        outcome: 1,
        decision: 'accepted',
      },
    ]);
    await expect(waiter).resolves.toBe(1);
  });

  it('runs pre-commit validation before the durable commit and commits nothing when it throws', async () => {
    const attempt = await authority.createAttempt(EXECUTION_ID, makeTestInstruction());
    const validation = { validate: vi.fn(async () => Promise.reject(new Error('owner rejected'))) };

    await expect(
      submitAttemptOutcome(
        { authority, convergence, validation },
        { executionId: EXECUTION_ID, executionAttemptId: attempt.executionAttemptId, outcome: 1 },
      ),
    ).rejects.toThrow('owner rejected');

    expect(validation.validate).toHaveBeenCalledWith(EXECUTION_ID, 1);
    expect(repository.committedOutcomes.has(attempt.executionAttemptId)).toBe(false);
    expect(convergence.calls).toHaveLength(0);
  });

  it('leaves the outcome committed and the waiter pending when convergence throws', async () => {
    const attempt = await authority.createAttempt(EXECUTION_ID, makeTestInstruction());
    const waiter = authority.waitForOutcome(attempt.executionAttemptId) as Promise<CounterOutcome>;
    convergence.failNext = new Error('owner state unavailable');

    await expect(
      submitAttemptOutcome(
        { authority, convergence },
        { executionId: EXECUTION_ID, executionAttemptId: attempt.executionAttemptId, outcome: 2 },
      ),
    ).rejects.toThrow('owner state unavailable');

    expect(repository.committedOutcomes.get(attempt.executionAttemptId)).toBe('{"counter":2}');
    expect(await settlementOf(waiter)).toBe('pending');
  });

  // Boxed outcome, and only here: this is the one case that asserts *which*
  // copy of the outcome convergence receives. With a bare number `toBe` would
  // compare two equal values and pass no matter which copy was handed over, so
  // the case runs on its own repository, whose committed outcome is decoded
  // out of the stored text and never the object the submitter held.
  //
  // The witness is the decision, not the repository's state: every read of a
  // committed outcome is a fresh decode, so there is no stored instance to
  // compare against. What the boundary owes is that convergence and the
  // waiter receive exactly the object `commitOutcome` reported.
  it('re-converges an identical retry as duplicate with the committed outcome and then settles the waiter', async () => {
    const boxedRepository = createInMemoryAttemptRepository(boxedCounterCodec);
    const boxedAuthority = new ExecutionAttemptAuthority(boxedRepository, { bootstrapTimeoutMs: 60_000 });
    const boxedConvergence = createConvergenceFake<BoxedCounterOutcome>();
    const attempt = await boxedAuthority.createAttempt(EXECUTION_ID, makeTestInstruction());
    const waiter = boxedAuthority.waitForOutcome(attempt.executionAttemptId) as Promise<BoxedCounterOutcome>;
    boxedConvergence.failNext = new Error('first convergence failed');
    await submitAttemptOutcome(
      { authority: boxedAuthority, convergence: boxedConvergence },
      { executionId: EXECUTION_ID, executionAttemptId: attempt.executionAttemptId, outcome: { counter: 3 } },
    ).catch(() => undefined);

    const commitOutcome = vi.spyOn(boxedAuthority, 'commitOutcome');
    const resubmitted: BoxedCounterOutcome = { counter: 3 };
    const decision = await submitAttemptOutcome(
      { authority: boxedAuthority, convergence: boxedConvergence },
      { executionId: EXECUTION_ID, executionAttemptId: attempt.executionAttemptId, outcome: resubmitted },
    );

    expect(decision).toBe('duplicate');
    expect(boxedConvergence.calls.map((call) => call.decision)).toEqual(['accepted', 'duplicate']);
    const reported = await commitOutcome.mock.results[0]?.value;
    expect(reported).toEqual({ kind: 'duplicate', outcome: { counter: 3 }, text: '{"counter":3}' });
    const committed = reported?.kind === 'duplicate' ? reported.outcome : undefined;
    expect(boxedConvergence.calls[1]?.outcome).toBe(committed);
    expect(boxedConvergence.calls[1]?.outcome).not.toBe(resubmitted);
    // The waiter is not that same object: it is settled from the durable
    // text, after convergence has had the decision's outcome in its hands.
    const settled = await waiter;
    expect(settled).toEqual({ counter: 3 });
    expect(settled).not.toBe(committed);
    expect(settled).not.toBe(resubmitted);
    expect(boxedRepository.committedOutcomes.get(attempt.executionAttemptId)).toBe('{"counter":3}');
  });

  // The counterpart of the case above, and the reason
  // `OutcomePreCommitValidation` owes a retry-stable verdict: validation runs
  // ahead of the commit on the retry too, so a validator that read state its
  // own convergence had already moved would strand the waiter it is trying to
  // settle. An input-only validator lets the documented recovery path work.
  it('re-runs an input-only validation on the retry of a committed outcome and settles the waiter', async () => {
    const attempt = await authority.createAttempt(EXECUTION_ID, makeTestInstruction());
    const waiter = authority.waitForOutcome(attempt.executionAttemptId) as Promise<CounterOutcome>;
    // Owner state the convergence moves forward before it fails, exactly the
    // shape of state a validator must not consult.
    let ownerCompleted = false;
    convergence.converge = async (input) => {
      convergence.calls.push(input);
      const alreadyCompleted = ownerCompleted;
      ownerCompleted = true;
      if (!alreadyCompleted) throw new Error('notification publish failed');
    };
    const validation = {
      validate: vi.fn(async (_executionId: string, outcome: CounterOutcome) => {
        if (outcome !== 7) throw new Error('owner rejected');
      }),
    };
    const submission = { executionId: EXECUTION_ID, executionAttemptId: attempt.executionAttemptId, outcome: 7 };

    await expect(submitAttemptOutcome({ authority, convergence, validation }, submission)).rejects.toThrow(
      'notification publish failed',
    );
    expect(ownerCompleted).toBe(true);

    const decision = await submitAttemptOutcome({ authority, convergence, validation }, submission);

    expect(decision).toBe('duplicate');
    expect(validation.validate).toHaveBeenCalledTimes(2);
    expect(convergence.calls.map((call) => call.decision)).toEqual(['accepted', 'duplicate']);
    await expect(waiter).resolves.toBe(7);
  });

  // The submitter keeps a handle on a mutable outcome and changes it while an
  // await is pending. Rendering the submission once — and carrying that one
  // rendering into the commit — is what makes the committed outcome
  // necessarily the validated one: nothing after the first line reads the
  // caller's object again.
  it('commits the rendering it validated even when the submitted object changes during validation', async () => {
    const boxedRepository = createInMemoryAttemptRepository(boxedCounterCodec);
    const boxedAuthority = new ExecutionAttemptAuthority(boxedRepository, { bootstrapTimeoutMs: 60_000 });
    const boxedConvergence = createConvergenceFake<BoxedCounterOutcome>();
    const attempt = await boxedAuthority.createAttempt(EXECUTION_ID, makeTestInstruction());
    const waiter = boxedAuthority.waitForOutcome(attempt.executionAttemptId) as Promise<BoxedCounterOutcome>;
    // Declared mutable here and only here: the boundary's outcome type is
    // `readonly`, and this case is about a caller that ignores that.
    const submitted: { counter: number } = { counter: 3 };
    const validated: BoxedCounterOutcome[] = [];
    const validation = {
      validate: async (_executionId: string, outcome: BoxedCounterOutcome) => {
        validated.push(outcome);
        // Yields to the microtask queue, which is where a real validator that
        // reads owner state suspends — and where the submitter gets its turn.
        await Promise.resolve();
        submitted.counter = 99;
      },
    };

    const decision = await submitAttemptOutcome(
      { authority: boxedAuthority, convergence: boxedConvergence, validation },
      { executionId: EXECUTION_ID, executionAttemptId: attempt.executionAttemptId, outcome: submitted },
    );

    expect(decision).toBe('accepted');
    // The mutation took, so the assertions below cannot pass vacuously.
    expect(submitted.counter).toBe(99);
    expect(validated).toEqual([{ counter: 3 }]);
    expect(boxedRepository.committedOutcomes.get(attempt.executionAttemptId)).toBe('{"counter":3}');
    expect(boxedConvergence.calls.map((call) => call.outcome)).toEqual([{ counter: 3 }]);
    await expect(waiter).resolves.toEqual({ counter: 3 });
  });

  it('returns conflict without converging when a different outcome was already committed', async () => {
    const attempt = await authority.createAttempt(EXECUTION_ID, makeTestInstruction());
    const waiter = authority.waitForOutcome(attempt.executionAttemptId) as Promise<CounterOutcome>;
    await submitAttemptOutcome(
      { authority, convergence },
      { executionId: EXECUTION_ID, executionAttemptId: attempt.executionAttemptId, outcome: 4 },
    );
    await waiter;

    const decision = await submitAttemptOutcome(
      { authority, convergence },
      { executionId: EXECUTION_ID, executionAttemptId: attempt.executionAttemptId, outcome: 5 },
    );

    expect(decision).toBe('conflict');
    expect(convergence.calls).toHaveLength(1);
  });

  it('returns fenced without converging and observes the waiter already rejected by commitOutcome', async () => {
    const first = await authority.createAttempt(EXECUTION_ID, makeTestInstruction());
    const firstWaiter = authority.waitForOutcome(first.executionAttemptId) as Promise<CounterOutcome>;
    void firstWaiter.catch(() => undefined);
    await authority.createAttempt(EXECUTION_ID, makeTestInstruction());
    const settleOutcome = vi.spyOn(authority, 'settleOutcome');

    const decision = await submitAttemptOutcome(
      { authority, convergence },
      { executionId: EXECUTION_ID, executionAttemptId: first.executionAttemptId, outcome: 6 },
    );

    expect(decision).toBe('fenced');
    expect(convergence.calls).toHaveLength(0);
    expect(await settlementOf(firstWaiter)).toBe('rejected');
    // The rejection came from `commitOutcome`, which is the only path that may
    // settle a waiter no convergence step will ever reach.
    expect(settleOutcome).not.toHaveBeenCalled();
  });

  // A codec that normalizes while serializing makes the submitted value and
  // the committed one two different things, and only one of them is the value
  // the owner lives with. Validating the other would let an outcome the owner
  // exists to reject become the immutable committed answer.
  it('validates the canonical outcome the attempt will hold, not the submitted copy', async () => {
    const normalizing = createInMemoryAttemptRepository(roundingCounterCodec);
    const normalizingAuthority = new ExecutionAttemptAuthority(normalizing, { bootstrapTimeoutMs: 60_000 });
    const attempt = await normalizingAuthority.createAttempt(EXECUTION_ID, makeTestInstruction());
    const validation = { validate: vi.fn(async () => undefined) };

    const decision = await submitAttemptOutcome(
      { authority: normalizingAuthority, convergence, validation },
      { executionId: EXECUTION_ID, executionAttemptId: attempt.executionAttemptId, outcome: 1.2 },
    );

    expect(decision).toBe('accepted');
    // `1`, the truncation the codec persists — not the `1.2` the worker sent.
    expect(validation.validate).toHaveBeenCalledWith(EXECUTION_ID, 1);
    // And the value convergence receives is the one the repository stored, so
    // validation, commitment, and convergence all saw the same outcome.
    expect(normalizing.committedOutcomes.get(attempt.executionAttemptId)).toBe('{"counter":1}');
    expect(convergence.calls.map((call) => call.outcome)).toEqual([1]);
  });

  // A mutable outcome passes through the owner's hands twice before anything
  // reports it: the validation holds it before the commit, convergence after.
  // Both cases below use `URL`, whose state a freeze cannot even reach, so
  // what protects the committed value is the rule that it is decoded from the
  // stored text rather than carried along as one shared object.
  it('reports an accepted outcome decoded from the stored text, not the object validation mutated', async () => {
    const urlRepository = createInMemoryAttemptRepository(urlOutcomeCodec);
    const urlAuthority = new ExecutionAttemptAuthority(urlRepository, { bootstrapTimeoutMs: 60_000 });
    const urlConvergence = createConvergenceFake<URL>();
    const attempt = await urlAuthority.createAttempt(EXECUTION_ID, makeTestInstruction());
    const waiter = urlAuthority.waitForOutcome(attempt.executionAttemptId) as Promise<URL>;
    const validated: URL[] = [];
    const validation = {
      validate: async (_executionId: string, outcome: URL) => {
        validated.push(outcome);
        outcome.pathname = '/mutated';
      },
    };

    const decision = await submitAttemptOutcome(
      { authority: urlAuthority, convergence: urlConvergence, validation },
      {
        executionId: EXECUTION_ID,
        executionAttemptId: attempt.executionAttemptId,
        outcome: new URL('https://outcome.test/a'),
      },
    );

    expect(decision).toBe('accepted');
    // The mutation took, so the assertions below cannot pass vacuously.
    expect(validated[0]?.href).toBe('https://outcome.test/mutated');
    expect(urlRepository.committedOutcomes.get(attempt.executionAttemptId)).toBe('"https://outcome.test/a"');
    expect(urlConvergence.calls.map((call) => call.outcome.href)).toEqual(['https://outcome.test/a']);
    await expect(waiter.then((settled) => settled.href)).resolves.toBe('https://outcome.test/a');
  });

  it('settles the waiter from the durable text even when convergence mutates the committed outcome', async () => {
    const urlRepository = createInMemoryAttemptRepository(urlOutcomeCodec);
    const urlAuthority = new ExecutionAttemptAuthority(urlRepository, { bootstrapTimeoutMs: 60_000 });
    const urlConvergence = createConvergenceFake<URL>();
    const attempt = await urlAuthority.createAttempt(EXECUTION_ID, makeTestInstruction());
    const waiter = urlAuthority.waitForOutcome(attempt.executionAttemptId) as Promise<URL>;
    const converged: URL[] = [];
    urlConvergence.converge = async (input) => {
      converged.push(input.outcome);
      input.outcome.pathname = '/mutated';
    };

    const decision = await submitAttemptOutcome(
      { authority: urlAuthority, convergence: urlConvergence },
      {
        executionId: EXECUTION_ID,
        executionAttemptId: attempt.executionAttemptId,
        outcome: new URL('https://outcome.test/a'),
      },
    );

    expect(decision).toBe('accepted');
    // The mutation took, so the assertions below cannot pass vacuously.
    expect(converged[0]?.href).toBe('https://outcome.test/mutated');
    const settled = await waiter;
    expect(settled.href).toBe('https://outcome.test/a');
    expect(settled).not.toBe(converged[0]);
    expect(urlRepository.committedOutcomes.get(attempt.executionAttemptId)).toBe('"https://outcome.test/a"');
  });

  // Two texts can be the same outcome without being the same text:
  // `sameDurableOutcome` ignores member order, so a worker that re-renders its
  // answer with the members in another order gets `duplicate`. Only one of the
  // two texts is the one the attempt holds, and that is the one every value
  // the boundary hands out must be decoded from — the decision's text, not the
  // retry's own rendering.
  it('settles a duplicate waiter from the committed text, not from the retry rendering', async () => {
    const orderRepository = createInMemoryAttemptRepository(memberOrderCodec);
    const orderAuthority = new ExecutionAttemptAuthority(orderRepository, { bootstrapTimeoutMs: 60_000 });
    const orderConvergence = createConvergenceFake<MemberOrderOutcome>();
    const attempt = await orderAuthority.createAttempt(EXECUTION_ID, makeTestInstruction());
    const waiter = orderAuthority.waitForOutcome(attempt.executionAttemptId) as Promise<MemberOrderOutcome>;
    // The first submission commits, then convergence fails, so the worker
    // retries — the documented recovery path, and the only way a `duplicate`
    // ever reaches waiter settlement.
    orderConvergence.failNext = new Error('first convergence failed');
    await submitAttemptOutcome(
      { authority: orderAuthority, convergence: orderConvergence },
      { executionId: EXECUTION_ID, executionAttemptId: attempt.executionAttemptId, outcome: { a: 1, b: 2 } },
    ).catch(() => undefined);
    expect(orderRepository.committedOutcomes.get(attempt.executionAttemptId)).toBe('{"a":1,"b":2}');

    const decision = await submitAttemptOutcome(
      { authority: orderAuthority, convergence: orderConvergence },
      { executionId: EXECUTION_ID, executionAttemptId: attempt.executionAttemptId, outcome: { b: 2, a: 1 } },
    );

    expect(decision).toBe('duplicate');
    // The retry rendered its own text, and the attempt kept the first one.
    expect(orderRepository.committedOutcomes.get(attempt.executionAttemptId)).toBe('{"a":1,"b":2}');
    // Convergence receives the stored outcome...
    expect(Object.keys(orderConvergence.calls[1]?.outcome ?? {})).toEqual(['a', 'b']);
    // ...and so does the runner waiting on the attempt.
    expect(Object.keys(await waiter)).toEqual(['a', 'b']);
  });

  it('rejects an outcome the codec refuses before any durable decision', async () => {
    const attempt = await authority.createAttempt(EXECUTION_ID, makeTestInstruction());

    await expect(
      submitAttemptOutcome(
        { authority, convergence },
        {
          executionId: EXECUTION_ID,
          executionAttemptId: attempt.executionAttemptId,
          outcome: invalidCounterOutcome(),
        },
      ),
    ).rejects.toThrow('CounterOutcome requires a numeric counter');

    expect(repository.committedOutcomes.has(attempt.executionAttemptId)).toBe(false);
    expect(convergence.calls).toHaveLength(0);
  });
});
