import { describe, expect, it } from 'vitest';
import {
  type Condition,
  ConditionErrorSchema,
  ConditionFindingSchema,
  ConditionOutcomeSchema,
  ConditionSchema,
  FieldConditionSchema,
  type FieldOperator,
  FieldOperatorSchema,
} from '../condition.js';

describe('FieldOperatorSchema', () => {
  const operatorForms: Array<[string, FieldOperator]> = [
    ['$eq', { $eq: 'open' }],
    ['$ne', { $ne: 3 }],
    ['$in', { $in: ['open', 2, true, null] }],
    ['$nin', { $nin: ['closed'] }],
    ['$contains', { $contains: 'urgent' }],
    ['$containsPrefix', { $containsPrefix: 'prio:' }],
    ['$exists', { $exists: false }],
    ['$startsWith', { $startsWith: 'INV-' }],
    ['$endsWith', { $endsWith: '.pdf' }],
    ['$glob', { $glob: 'orders/**' }],
    ['$lt', { $lt: 100 }],
    ['$lte', { $lte: '2026-01-01T00:00:00Z' }],
    ['$gt', { $gt: 0.5 }],
    ['$gte', { $gte: '2025-12-31T23:59:59+01:00' }],
    ['$empty', { $empty: true }],
  ];

  it.each(operatorForms)('accepts the %s operator form', (_name, operator) => {
    expect(FieldOperatorSchema.parse(operator)).toEqual(operator);
  });

  it.each<[string, FieldOperator]>([
    ['string', 'open'],
    ['number', 42],
    ['boolean', true],
    ['null', null],
  ])('accepts a bare %s scalar', (_name, operator) => {
    expect(FieldOperatorSchema.parse(operator)).toEqual(operator);
  });

  it('accepts $eq with an object operand', () => {
    const operator = { $eq: { state: 'open', lines: [1, 2] } };
    expect(FieldOperatorSchema.parse(operator)).toEqual(operator);
  });

  it('accepts $eq with an array operand', () => {
    const operator = { $eq: ['a', 1, null, { nested: true }] };
    expect(FieldOperatorSchema.parse(operator)).toEqual(operator);
  });

  it('rejects an operator object with two keys', () => {
    expect(FieldOperatorSchema.safeParse({ $eq: 'open', $ne: 'closed' }).success).toBe(false);
  });

  it('rejects an unknown operator', () => {
    expect(FieldOperatorSchema.safeParse({ $regex: '^open$' }).success).toBe(false);
  });

  it('rejects $lt with a boolean operand', () => {
    expect(FieldOperatorSchema.safeParse({ $lt: true }).success).toBe(false);
  });

  it('rejects $empty with a string operand', () => {
    expect(FieldOperatorSchema.safeParse({ $empty: 'yes' }).success).toBe(false);
  });

  it('rejects $in with an object element', () => {
    expect(FieldOperatorSchema.safeParse({ $in: ['open', { state: 'open' }] }).success).toBe(false);
  });

  it.each([
    ['bare NaN', Number.NaN],
    ['bare Infinity', Number.POSITIVE_INFINITY],
    ['$gt with -Infinity', { $gt: Number.NEGATIVE_INFINITY }],
    ['$in with NaN', { $in: [Number.NaN] }],
  ])('rejects a non-finite number (%s)', (_name, operator) => {
    expect(FieldOperatorSchema.safeParse(operator).success).toBe(false);
  });
});

describe('FieldConditionSchema', () => {
  it('rejects an empty field', () => {
    expect(FieldConditionSchema.safeParse({ field: '', operator: 'open' }).success).toBe(false);
  });
});

describe('ConditionSchema', () => {
  it('accepts nested $and, $or and $not', () => {
    const condition: Condition = {
      $and: [
        { field: 'order.state', operator: { $in: ['open', 'pending'] } },
        {
          $or: [
            { field: 'invoice.total', operator: { $gte: 100 } },
            { $not: { field: 'invoice.notes', operator: { $empty: true } } },
          ],
        },
      ],
    };
    expect(ConditionSchema.parse(condition)).toEqual(condition);
  });

  it('accepts an $expr condition', () => {
    const condition: Condition = { $expr: 'invoice.total > 100' };
    expect(ConditionSchema.parse(condition)).toEqual(condition);
  });

  it('rejects an empty $and', () => {
    expect(ConditionSchema.safeParse({ $and: [] }).success).toBe(false);
  });

  it('rejects an empty $or', () => {
    expect(ConditionSchema.safeParse({ $or: [] }).success).toBe(false);
  });

  it('rejects an empty field inside a compound condition', () => {
    expect(ConditionSchema.safeParse({ $not: { field: '', operator: 'open' } }).success).toBe(false);
  });
});

describe('ConditionOutcomeSchema', () => {
  it('accepts a matched outcome', () => {
    expect(ConditionOutcomeSchema.parse({ matched: false })).toEqual({ matched: false });
  });

  it('accepts an error outcome', () => {
    const outcome = { error: { path: '$and[1].$not.$expr', message: 'Unexpected token' } };
    expect(ConditionOutcomeSchema.parse(outcome)).toEqual(outcome);
  });

  it('rejects an object carrying both matched and error', () => {
    expect(ConditionOutcomeSchema.safeParse({ matched: true, error: { path: '', message: 'failed' } }).success).toBe(
      false,
    );
  });
});

describe('ConditionFindingSchema', () => {
  it.each(['error', 'warning'] as const)('accepts severity %s', (severity) => {
    const finding = { severity, code: 'unknown-path', path: '$or[0].operator', message: 'No such field' };
    expect(ConditionFindingSchema.parse(finding)).toEqual(finding);
  });

  it('rejects another severity', () => {
    expect(
      ConditionFindingSchema.safeParse({ severity: 'info', code: 'unknown-path', path: '', message: 'No such field' })
        .success,
    ).toBe(false);
  });
});

describe('ConditionErrorSchema', () => {
  it('accepts a path and a message', () => {
    const error = { path: '$and[1].$not.$expr', message: 'failed' };
    expect(ConditionErrorSchema.parse(error)).toEqual(error);
  });

  it('rejects extra keys and is the error shape of ConditionOutcomeSchema', () => {
    expect(ConditionErrorSchema.safeParse({ path: '', message: 'x', extra: 1 }).success).toBe(false);
    expect(ConditionOutcomeSchema.safeParse({ error: { path: '', message: 'x', extra: 1 } }).success).toBe(false);
  });
});
