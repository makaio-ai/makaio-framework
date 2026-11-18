/**
 * The retirement ledger and the observation it consumes (I33): an end that was
 * reported but not observed never counts as an observed exit.
 *
 * Both answer one question — was the end of a resource *observed* — and the
 * answer may only come from a promise that fulfils on an observation. These
 * cases pin the two halves of that contract: a ledger entry leaves only when the
 * end was observed, whenever that happens, and an end *report* (which also
 * fulfils when nobody saw the end) is refused as evidence by type.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTOR_EXIT_OBSERVATION_MS } from '../teardown-timing.js';
import { exitWasObserved, reportObservedExit } from '../teardown-observation.js';
import { GenerationRetirementLedger } from '../generation-retirement.js';

/** An end report in the shape a JSONL transport's `ended` fulfils with. */
interface EndReport {
  readonly cause: 'requested';
  readonly exit: { readonly kind: 'exited' } | { readonly kind: 'unobserved' };
}

/**
 * A promise the test fulfils or rejects, standing in for an owner's exit observation.
 * @returns The promise and its settlers.
 */
function observation(): PromiseWithResolvers<number | null> {
  return Promise.withResolvers<number | null>();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GenerationRetirementLedger', () => {
  it('retires a generation whose end is observed inside the budget', async () => {
    const ledger = new GenerationRetirementLedger('test process');
    const exit = observation();

    const retiring = ledger.retire(ledger.supersede(exit.promise));
    // Unproven from the moment it was superseded, not from the budget expiry.
    expect(ledger.unretiredDetail()).toContain('test process generation 1');
    exit.resolve(0);

    await expect(retiring).resolves.toBe(true);
    expect(ledger.unretiredDetail()).toBeUndefined();
  });

  it('keeps watching after the budget expired, so a late observed end lifts the cap', async () => {
    vi.useFakeTimers();
    const ledger = new GenerationRetirementLedger('test process');
    const exit = observation();

    const retiring = ledger.retire(ledger.supersede(exit.promise));
    await vi.advanceTimersByTimeAsync(CONNECTOR_EXIT_OBSERVATION_MS);

    await expect(retiring).resolves.toBe(false);
    expect(ledger.capReport({ evidence: 'exited' }).evidence).toBe('detached');

    exit.resolve(null);
    await vi.advanceTimersByTimeAsync(0);

    expect(ledger.unretiredDetail()).toBeUndefined();
    expect(ledger.capReport({ evidence: 'exited' })).toEqual({ evidence: 'exited' });
  });

  it('keeps watching an abandoned generation until its end is observed', async () => {
    const ledger = new GenerationRetirementLedger('test process');
    const exit = observation();

    ledger.abandon(ledger.supersede(exit.promise));
    expect(ledger.unretiredDetail()).toContain('generation 1');

    exit.resolve(0);
    await Promise.resolve();

    expect(ledger.unretiredDetail()).toBeUndefined();
  });

  it('never counts a rejected observation as an observed end', async () => {
    vi.useFakeTimers();
    const ledger = new GenerationRetirementLedger('test process');
    const exit = observation();

    const retiring = ledger.retire(ledger.supersede(exit.promise));
    exit.reject(new Error('watch failed'));

    await expect(retiring).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(CONNECTOR_EXIT_OBSERVATION_MS);
    expect(ledger.unretiredDetail()).toContain('generation 1');
  });

  it('keeps a generation that exposed no observation unproven', async () => {
    const ledger = new GenerationRetirementLedger('test process');

    await expect(ledger.retire(ledger.supersede(undefined))).resolves.toBe(false);

    expect(ledger.unretiredDetail()).toContain('generation 1');
  });

  it('refuses an end report as evidence, because it also fulfils for an unobserved end', () => {
    const ledger = new GenerationRetirementLedger('test process');
    const report: Promise<EndReport> = Promise.resolve({ cause: 'requested', exit: { kind: 'unobserved' } });
    const outcome: Promise<{ readonly kind: 'exited' } | { readonly kind: 'unobserved' }> = Promise.resolve({
      kind: 'unobserved',
    });

    // Compile-time contract: the validator fails if either line is accepted.
    // @ts-expect-error -- an end report is not an observation.
    ledger.supersede(report);
    // @ts-expect-error -- an outcome that may be `unobserved` is not an observation.
    void exitWasObserved(outcome);
    // @ts-expect-error -- the teardown report consumes observations only.
    void reportObservedExit({ exited: report, resource: 'the test process' });

    // An observation that can only describe an observed end is accepted.
    const observed: Promise<{ readonly kind: 'exited' } | { readonly kind: 'spawn-failed' }> = Promise.resolve({
      kind: 'exited',
    });
    expect(ledger.supersede(observed).generation).toBe(2);
  });
});

describe('reportObservedExit', () => {
  it('reports `exited` for an end observed inside the budget', async () => {
    await expect(reportObservedExit({ exited: Promise.resolve(0), resource: 'The test process' })).resolves.toEqual({
      evidence: 'exited',
    });
  });

  it('reports `detached`, naming the resource, when the end is not observed inside the budget', async () => {
    vi.useFakeTimers();
    const reporting = reportObservedExit({ exited: observation().promise, resource: 'The test process' });
    await vi.advanceTimersByTimeAsync(CONNECTOR_EXIT_OBSERVATION_MS);

    const report = await reporting;

    expect(report.evidence).toBe('detached');
    expect(report.detail).toContain('The test process');
  });
});
