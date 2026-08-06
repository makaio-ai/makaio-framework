import { describe, expect, it } from 'vitest';
import {
  aggregateTeardownEvidence,
  TeardownEvidenceSchema,
  teardownWasObserved,
  type TeardownEvidence,
} from '../schemas/teardown.js';

describe('case 201: the aggregation rule is the weakest class', () => {
  it('reports `unknown` for any set containing `unknown`', () => {
    expect(aggregateTeardownEvidence(['exited', 'unknown'])).toBe('unknown');
    // Ordering must not matter: the rule is about the set, not about arrival.
    expect(aggregateTeardownEvidence(['unknown', 'exited'])).toBe('unknown');
    expect(aggregateTeardownEvidence(['unknown', 'detached'])).toBe('unknown');
  });

  it('reports `detached` for a set containing `detached` but no `unknown`', () => {
    expect(aggregateTeardownEvidence(['exited', 'detached'])).toBe('detached');
    expect(aggregateTeardownEvidence(['detached', 'closed', 'released'])).toBe('detached');
  });

  it('reports the weakest observed class for a set of observed classes', () => {
    expect(aggregateTeardownEvidence(['exited', 'closed'])).toBe('closed');
    expect(aggregateTeardownEvidence(['exited', 'released'])).toBe('released');
    expect(aggregateTeardownEvidence(['closed', 'released'])).toBe('released');
    expect(aggregateTeardownEvidence(['exited', 'exited'])).toBe('exited');
  });

  it('reports `released` for a set with no members at all', () => {
    // Asserted explicitly: "nothing to tear down" is the case every consumer hits
    // most often, and it is the one where a wrong default is invisible — a
    // `detached` or `unknown` default would make every removal of an
    // already-gone agent look uncertain.
    expect(aggregateTeardownEvidence([])).toBe('released');
  });

  it('never strengthens a class it was not given', () => {
    // The complement of the rule, over the whole enum: aggregating one class with
    // itself is that class, and aggregating any class with the weakest observed
    // one never produces something stronger than either input.
    for (const evidence of TeardownEvidenceSchema.options) {
      expect(aggregateTeardownEvidence([evidence])).toBe(evidence);
    }
  });
});

describe('the observed/unobserved boundary', () => {
  it('treats exactly the first three classes as observed', () => {
    const observed: TeardownEvidence[] = ['exited', 'closed', 'released'];
    const unobserved: TeardownEvidence[] = ['detached', 'unknown'];
    for (const evidence of observed) expect(teardownWasObserved(evidence)).toBe(true);
    for (const evidence of unobserved) expect(teardownWasObserved(evidence)).toBe(false);
  });

  it('covers every enum member, so a new class cannot be silently unclassified', () => {
    expect(TeardownEvidenceSchema.options).toEqual(['exited', 'closed', 'released', 'detached', 'unknown']);
  });
});
