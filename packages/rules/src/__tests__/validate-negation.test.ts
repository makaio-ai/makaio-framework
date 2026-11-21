import { type Condition, type FieldOperator, type JsonSchema } from '@makaio/contracts/shared';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../evaluator.js';
import { validateCondition } from '../validate.js';

/** Context schema with the optional fields `x`, `y` and `s` and the required field `id`. */
const context: JsonSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, s: { type: 'string' } },
  required: ['id'],
  additionalProperties: false,
};

/**
 * Context schema with a nested optional object: `p` is optional; inside it `k` is required and
 * `o` is optional. `list` is an optional array, whose elements are never required.
 */
const nestedContext: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    p: {
      type: 'object',
      properties: { k: { type: 'string' }, o: { type: 'number' } },
      required: ['k'],
      additionalProperties: false,
    },
    pq: { type: 'string' },
    list: { type: 'array', items: { type: 'string' } },
  },
  required: ['id'],
  additionalProperties: false,
};

/**
 * Finding codes the validator reports for a condition.
 * @param condition - Condition to check
 * @param schema - Context schema
 * @returns Finding codes in order
 */
function codes(condition: Condition, schema: JsonSchema = context): string[] {
  return validateCondition({ condition, context: schema }).map((finding) => finding.code);
}

/**
 * Whether the real evaluator matches the condition on a context.
 * @param condition - Condition to evaluate
 * @param sample - Context to evaluate on
 * @returns The match result
 * @throws Error when evaluation fails
 */
function matchesOn(condition: Condition, sample: object): boolean {
  const outcome = evaluate(condition, sample);
  if ('error' in outcome) throw new Error(outcome.error.message);
  return outcome.matched;
}

/**
 * Whether the real evaluator matches the condition on a context without the optional fields.
 * @param condition - Condition to evaluate
 * @returns The match result
 */
function matchesWithoutFields(condition: Condition): boolean {
  return matchesOn(condition, { id: 'a' });
}

/**
 * Assert that the validator reports `unguarded-negation` exactly when the evaluator matches
 * on a context without the optional fields. With `samples`, the evaluator is checked on each
 * sample (an absent ancestor, a present ancestor with an absent nested field) and has to
 * match on at least one of them for `expected` to be true; the validator then checks against
 * `schema`.
 * @param condition - Condition to check
 * @param expected - Whether the evaluator matches on absence
 * @param samples - Contexts to evaluate on; defaults to one without the optional fields
 * @param schema - Context schema the validator checks against
 */
function expectAgreement(
  condition: Condition,
  expected: boolean,
  samples: readonly object[] = [{ id: 'a' }],
  schema: JsonSchema = context,
): void {
  expect(samples.some((sample) => matchesOn(condition, sample))).toBe(expected);
  expect(codes(condition, schema).includes('unguarded-negation')).toBe(expected);
}

const xExists: Condition = { field: 'x', operator: { $exists: true } };

describe('validateCondition absence analysis', () => {
  it('reports nothing for $not over an $or that is false on absence', () => {
    expectAgreement(
      {
        $not: {
          $or: [
            { field: 'x', operator: { $eq: 5 } },
            { field: 'x', operator: { $ne: 6 } },
          ],
        },
      },
      false,
    );
  });

  it('reports nothing for $not over an $or with $exists: false', () => {
    expectAgreement(
      {
        $not: {
          $or: [
            { field: 's', operator: { $eq: 'a' } },
            { field: 's', operator: { $exists: false } },
          ],
        },
      },
      false,
    );
  });

  it('reports an $or that is true on absence', () => {
    expectAgreement(
      {
        $or: [
          { field: 'x', operator: { $ne: 1 } },
          { field: 'x', operator: { $eq: 2 } },
        ],
      },
      true,
    );
  });

  it('keeps the finding for $not over an $and', () => {
    expectAgreement(
      {
        $not: {
          $and: [
            { field: 'x', operator: { $eq: 1 } },
            { field: 'x', operator: { $eq: 2 } },
          ],
        },
      },
      true,
    );
  });

  it('is protected by a guard after the negation in the same $and', () => {
    expectAgreement({ $and: [{ field: 'x', operator: { $ne: 1 } }, xExists] }, false);
  });

  it('is not protected by a guard under a sibling $or', () => {
    expectAgreement({ $or: [xExists, { field: 'x', operator: { $ne: 1 } }] }, true);
  });

  it('treats a double $not as no negation', () => {
    expectAgreement({ $not: { $not: { field: 'x', operator: { $eq: 1 } } } }, false);
    expectAgreement({ $not: { $not: { field: 'x', operator: { $ne: 1 } } } }, true);
  });

  it('treats a condition on another field as able to match', () => {
    // Only `x` is absent in the analysis; `y` may hold a value that satisfies its condition.
    const condition: Condition = {
      $and: [
        { field: 'x', operator: { $ne: 1 } },
        { field: 'y', operator: { $eq: 1 } },
      ],
    };
    expect(codes(condition)).toContain('unguarded-negation');
  });

  const yExists: Condition = { field: 'y', operator: { $exists: true } };
  const xNe: Condition = { field: 'x', operator: { $ne: 1 } };
  const yNe: Condition = { field: 'y', operator: { $ne: 1 } };

  it('does not count a match through an unrelated $or branch', () => {
    expectAgreement({ $or: [{ $and: [xExists, xNe] }, { $and: [yExists, yNe] }] }, false);
  });

  it('does not report a guarded leaf when the other $or branch needs another field', () => {
    expectAgreement({ $or: [{ $and: [xExists, xNe] }, { field: 'y', operator: 2 }] }, false);
  });

  it('reports only the leaf whose own path can match with the field absent', () => {
    const condition: Condition = { $or: [xNe, { $and: [yExists, yNe] }] };
    expectAgreement(condition, true);
    expect(validateCondition({ condition, context }).map((finding) => finding.path)).toEqual(['$or[0].operator']);
  });
});

describe('validateCondition absence analysis of nested paths', () => {
  /** Ancestor absent, and ancestor present with the nested optional field absent. */
  const samples = [{ id: 'a' }, { id: 'a', p: { k: 'x' } }];
  const pExists: Condition = { field: 'p', operator: { $exists: true } };
  const kExists: Condition = { field: 'p.k', operator: { $exists: true } };
  const kNe: Condition = { field: 'p.k', operator: { $ne: 'x' } };
  const oNe: Condition = { field: 'p.o', operator: { $ne: 5 } };

  it('(a) is protected by a guard on the ancestor when the nested field is required', () => {
    expectAgreement({ $and: [pExists, kNe] }, false, samples, nestedContext);
  });

  it('(b) is not protected by a guard on the ancestor when the nested field is optional', () => {
    expectAgreement({ $and: [pExists, oNe] }, true, samples, nestedContext);
  });

  it('(c) is protected by a guard on the nested field itself', () => {
    expectAgreement({ $and: [kExists, kNe] }, false, samples, nestedContext);
    expectAgreement({ $and: [{ field: 'p.o', operator: { $exists: true } }, oNe] }, false, samples, nestedContext);
  });

  it('(d) is protected by a guard below the negated ancestor', () => {
    const condition: Condition = { $and: [kExists, { $not: { field: 'p', operator: { $empty: true } } }] };
    // Only the absent ancestor is sampled: with `p` present the negation matches for real.
    expectAgreement(condition, false, [{ id: 'a' }], nestedContext);
  });

  it('is not protected by a guard on a sibling path below the ancestor', () => {
    expectAgreement({ $and: [kExists, oNe] }, true, samples, nestedContext);
  });

  it('does not treat a path that only shares a name prefix as below the guard', () => {
    // `pq` starts with `p` but is not below it, so it guards nothing about `p.o`.
    const condition: Condition = { $and: [{ field: 'pq', operator: { $exists: true } }, oNe] };
    expectAgreement(condition, true, [...samples, { id: 'a', pq: 's', p: { k: 'x' } }], nestedContext);
  });

  it('treats an array element as an optional prefix', () => {
    const listNe: Condition = { field: 'list.0', operator: { $ne: 'a' } };
    const samplesWithList = [{ id: 'a' }, { id: 'a', list: [] }];
    expectAgreement(
      { $and: [{ field: 'list', operator: { $exists: true } }, listNe] },
      true,
      samplesWithList,
      nestedContext,
    );
    expectAgreement(
      { $and: [{ field: 'list.0', operator: { $exists: true } }, listNe] },
      false,
      samplesWithList,
      nestedContext,
    );
  });
});

describe('validateCondition and explicit absence tests', () => {
  it('never reports $exists: false on an optional field', () => {
    expect(codes({ field: 'x', operator: { $exists: false } })).toEqual([]);
  });

  it('never reports $not over $exists: true', () => {
    expect(codes({ $not: xExists })).toEqual([]);
  });

  it('still reports a $ne next to an explicit absence test', () => {
    expect(
      codes({
        $and: [
          { field: 'x', operator: { $exists: false } },
          { field: 'x', operator: { $ne: 1 } },
        ],
      }),
    ).toEqual(['unguarded-negation']);
  });
});

/** One sample per operator name; the type forces an entry for every operator of the language. */
type OperatorName<T> = T extends object ? keyof T & string : never;
const operatorSamples: Record<OperatorName<FieldOperator>, FieldOperator> = {
  $eq: { $eq: 1 },
  $ne: { $ne: 1 },
  $in: { $in: [1] },
  $nin: { $nin: [1] },
  $contains: { $contains: 1 },
  $containsPrefix: { $containsPrefix: 'a' },
  $exists: { $exists: true },
  $startsWith: { $startsWith: 'a' },
  $endsWith: { $endsWith: 'a' },
  $glob: { $glob: 'a*' },
  $lt: { $lt: 1 },
  $lte: { $lte: 1 },
  $gt: { $gt: 1 },
  $gte: { $gte: 1 },
  $empty: { $empty: true },
};

const operatorCases: [string, FieldOperator][] = [
  ...Object.entries(operatorSamples),
  ['$exists: false', { $exists: false }],
  ['$empty: false', { $empty: false }],
  ['bare scalar', 1],
];

describe('validateCondition and evaluate agree on absence', () => {
  it.each(operatorCases)('%s, plain and under $not', (_label, operator) => {
    // The validator also reports type mismatches for the string operators on the number
    // field `x`; only the absence finding is compared, against the real evaluator.
    const plain: Condition = { field: 'x', operator };
    const negated: Condition = { $not: plain };
    if (typeof operator === 'object' && operator !== null && '$exists' in operator) {
      // An explicit presence test is never an unguarded negation, though the evaluator matches it.
      expect(codes(plain)).not.toContain('unguarded-negation');
      expect(codes(negated)).not.toContain('unguarded-negation');
      return;
    }
    expectAgreement(plain, matchesWithoutFields(plain));
    expectAgreement(negated, matchesWithoutFields(negated));
  });
});
