import { describe, expect, it } from 'vitest';
import { type FieldOperator } from '../index.js';
import { fieldMatches, matched } from './support.js';

type OrderKey = '$lt' | '$lte' | '$gt' | '$gte';

const ORDER_CASES: Array<{ key: OrderKey; hit: number; miss: number; equalHits: boolean }> = [
  { key: '$lt', hit: 4, miss: 6, equalHits: false },
  { key: '$lte', hit: 4, miss: 6, equalHits: true },
  { key: '$gt', hit: 6, miss: 4, equalHits: false },
  { key: '$gte', hit: 6, miss: 4, equalHits: true },
];

/**
 * Build an ordering operator.
 * @param key - Operator name
 * @param operand - Operand
 * @returns The operator object
 */
function order(key: OrderKey, operand: number | string): FieldOperator {
  switch (key) {
    case '$lt':
      return { $lt: operand };
    case '$lte':
      return { $lte: operand };
    case '$gt':
      return { $gt: operand };
    case '$gte':
      return { $gte: operand };
  }
}

describe.each(ORDER_CASES)('$key operator', ({ key, hit, miss, equalHits }) => {
  describe('number against number', () => {
    it('matches when the ordering holds', () => {
      expect(fieldMatches(order(key, 5), { x: hit })).toBe(true);
    });

    it('does not match when the ordering does not hold', () => {
      expect(fieldMatches(order(key, 5), { x: miss })).toBe(false);
    });

    it(`${equalHits ? 'matches' : 'does not match'} at equality`, () => {
      expect(fieldMatches(order(key, 5), { x: 5 })).toBe(equalHits);
    });

    it('compares negative and fractional numbers', () => {
      expect(fieldMatches(order(key, -1.5), { x: key === '$lt' || key === '$lte' ? -2 : -1 })).toBe(true);
    });

    it('does not match NaN or infinity', () => {
      expect(fieldMatches(order(key, 5), { x: Number.NaN })).toBe(false);
      expect(fieldMatches(order(key, 5), { x: key === '$lt' || key === '$lte' ? -Infinity : Infinity })).toBe(false);
    });
  });

  describe('missing field', () => {
    it('does not match when the field is absent', () => {
      expect(fieldMatches(order(key, 5), {})).toBe(false);
    });

    it('does not match when the field is undefined', () => {
      expect(fieldMatches(order(key, 5), { x: undefined })).toBe(false);
    });

    it('does not match when an intermediate path segment is absent', () => {
      expect(matched({ field: 'a.b', operator: order(key, 5) }, { a: {} })).toBe(false);
    });
  });

  describe('wrong type', () => {
    it.each([
      ['null', null],
      ['boolean', true],
      ['array', [4]],
      ['object', { n: 4 }],
    ])('does not match a %s', (_name, value) => {
      expect(fieldMatches(order(key, 5), { x: value })).toBe(false);
    });

    it('does not match a numeric string against a number operand', () => {
      expect(fieldMatches(order(key, 5), { x: String(hit) })).toBe(false);
    });

    it('does not match a number against a string operand', () => {
      expect(fieldMatches(order(key, '2024-01-01T00:00:00Z'), { x: hit })).toBe(false);
    });

    it('does not match a number against a date-time string, even at equality', () => {
      expect(fieldMatches(order(key, '2024-01-01T00:00:00Z'), { x: 5 })).toBe(false);
    });

    it('does not match a date-time string against a number operand', () => {
      expect(fieldMatches(order(key, 5), { x: '2024-01-01T00:00:00Z' })).toBe(false);
    });

    it('does not match two strings that are not date-times', () => {
      expect(fieldMatches(order(key, 'apple'), { x: 'banana' })).toBe(false);
      expect(fieldMatches(order(key, 'apple'), { x: 'apple' })).toBe(false);
    });

    it('does not match a date-time against a plain date', () => {
      expect(fieldMatches(order(key, '2024-01-01'), { x: '2024-01-01T00:00:00Z' })).toBe(false);
    });

    it('does not match a date-time without a zone offset', () => {
      expect(fieldMatches(order(key, '2024-01-01T00:00:00Z'), { x: '2024-01-01T00:00:00' })).toBe(false);
    });
  });
});

describe('date-time against date-time', () => {
  const EARLIER = '2024-03-10T10:00:00Z';
  const LATER = '2024-03-10T11:00:00Z';

  it('$lt matches an earlier instant', () => {
    expect(fieldMatches({ $lt: LATER }, { x: EARLIER })).toBe(true);
    expect(fieldMatches({ $lt: EARLIER }, { x: LATER })).toBe(false);
  });

  it('$lte matches an earlier and an equal instant', () => {
    expect(fieldMatches({ $lte: LATER }, { x: EARLIER })).toBe(true);
    expect(fieldMatches({ $lte: EARLIER }, { x: EARLIER })).toBe(true);
    expect(fieldMatches({ $lte: EARLIER }, { x: LATER })).toBe(false);
  });

  it('$gt matches a later instant', () => {
    expect(fieldMatches({ $gt: EARLIER }, { x: LATER })).toBe(true);
    expect(fieldMatches({ $gt: EARLIER }, { x: EARLIER })).toBe(false);
  });

  it('$gte matches a later and an equal instant', () => {
    expect(fieldMatches({ $gte: EARLIER }, { x: LATER })).toBe(true);
    expect(fieldMatches({ $gte: EARLIER }, { x: EARLIER })).toBe(true);
    expect(fieldMatches({ $gte: LATER }, { x: EARLIER })).toBe(false);
  });

  it('compares instants across time zones', () => {
    // 12:00+02:00 is 10:00Z, so it is earlier than 10:30Z although "12" > "10" as text.
    expect(fieldMatches({ $lt: '2024-03-10T10:30:00Z' }, { x: '2024-03-10T12:00:00+02:00' })).toBe(true);
    expect(fieldMatches({ $gt: '2024-03-10T10:30:00Z' }, { x: '2024-03-10T12:00:00+02:00' })).toBe(false);
    // 08:00-05:00 is 13:00Z, so it is later than 12:00+00:00.
    expect(fieldMatches({ $gt: '2024-03-10T12:00:00+00:00' }, { x: '2024-03-10T08:00:00-05:00' })).toBe(true);
  });

  it('treats the same instant in different zones as equal', () => {
    const actual = '2024-03-10T12:00:00+02:00';
    const operand = '2024-03-10T10:00:00Z';
    expect(fieldMatches({ $lte: operand }, { x: actual })).toBe(true);
    expect(fieldMatches({ $gte: operand }, { x: actual })).toBe(true);
    expect(fieldMatches({ $lt: operand }, { x: actual })).toBe(false);
    expect(fieldMatches({ $gt: operand }, { x: actual })).toBe(false);
  });

  it('accepts fractional seconds and a lowercase separator and zone', () => {
    expect(fieldMatches({ $lt: '2024-03-10T10:00:00.500Z' }, { x: '2024-03-10T10:00:00.250Z' })).toBe(true);
    expect(fieldMatches({ $lt: '2024-03-10t10:00:01z' }, { x: '2024-03-10t10:00:00z' })).toBe(true);
  });

  describe('sub-millisecond precision', () => {
    it('orders instants that differ below the millisecond', () => {
      const earlier = '2026-01-01T00:00:00.0001Z';
      const later = '2026-01-01T00:00:00.0002Z';
      expect(fieldMatches({ $lt: later }, { x: earlier })).toBe(true);
      expect(fieldMatches({ $gt: later }, { x: earlier })).toBe(false);
      expect(fieldMatches({ $lte: later }, { x: earlier })).toBe(true);
      expect(fieldMatches({ $gte: later }, { x: earlier })).toBe(false);
      expect(fieldMatches({ $gt: earlier }, { x: later })).toBe(true);
      expect(fieldMatches({ $lt: earlier }, { x: later })).toBe(false);
      expect(fieldMatches({ $gte: earlier }, { x: later })).toBe(true);
      expect(fieldMatches({ $lte: earlier }, { x: later })).toBe(false);
    });

    it('treats a fraction and the same fraction with trailing zeros as equal', () => {
      const short = '2026-01-01T00:00:00.1Z';
      const long = '2026-01-01T00:00:00.1000000Z';
      expect(fieldMatches({ $lte: long }, { x: short })).toBe(true);
      expect(fieldMatches({ $gte: long }, { x: short })).toBe(true);
      expect(fieldMatches({ $lt: long }, { x: short })).toBe(false);
      expect(fieldMatches({ $gt: long }, { x: short })).toBe(false);
    });

    it('orders across the millisecond boundary', () => {
      expect(fieldMatches({ $lt: '2026-01-01T00:00:00.001Z' }, { x: '2026-01-01T00:00:00.0009999Z' })).toBe(true);
      expect(fieldMatches({ $gt: '2026-01-01T00:00:00.001Z' }, { x: '2026-01-01T00:00:00.0009999Z' })).toBe(false);
    });

    it('compares a nine-digit fraction with an offset against the same instant in Z', () => {
      const offset = '2026-01-01T02:00:00.123456789+02:00';
      const zulu = '2026-01-01T00:00:00.123456789Z';
      expect(fieldMatches({ $lte: zulu }, { x: offset })).toBe(true);
      expect(fieldMatches({ $gte: zulu }, { x: offset })).toBe(true);
      expect(fieldMatches({ $lt: zulu }, { x: offset })).toBe(false);
      expect(fieldMatches({ $gt: zulu }, { x: offset })).toBe(false);
      expect(fieldMatches({ $lt: '2026-01-01T00:00:00.123456790Z' }, { x: offset })).toBe(true);
    });
  });

  it('does not match when one side is not a date-time', () => {
    expect(fieldMatches({ $lt: LATER }, { x: 'not a date' })).toBe(false);
    expect(fieldMatches({ $lt: 'not a date' }, { x: EARLIER })).toBe(false);
  });

  it('does not match an impossible calendar value', () => {
    expect(fieldMatches({ $lt: LATER }, { x: '2024-13-45T10:00:00Z' })).toBe(false);
  });

  it.each([
    ['a day past the end of February', '2026-02-30T00:00:00Z'],
    ['February 29 in a common year', '2025-02-29T00:00:00Z'],
    ['April 31', '2024-04-31T00:00:00Z'],
    ['hour 24', '2024-03-10T24:00:00Z'],
    ['a leap second', '2024-03-10T10:00:60Z'],
    ['an offset minute above 59', '2024-03-10T10:00:00+01:60'],
  ])('does not match %s on either side', (_label, value) => {
    expect(fieldMatches({ $lt: '2030-01-01T00:00:00Z' }, { x: value })).toBe(false);
    expect(fieldMatches({ $gt: '2000-01-01T00:00:00Z' }, { x: value })).toBe(false);
    expect(fieldMatches({ $lt: value }, { x: '2000-01-01T00:00:00Z' })).toBe(false);
    expect(fieldMatches({ $gt: value }, { x: '2030-01-01T00:00:00Z' })).toBe(false);
  });

  it('still compares a real leap day and lower-case T and Z', () => {
    expect(fieldMatches({ $gt: '2024-02-28T00:00:00Z' }, { x: '2024-02-29T00:00:00Z' })).toBe(true);
    expect(fieldMatches({ $lt: '2024-03-01T00:00:00Z' }, { x: '2024-02-29T00:00:00Z' })).toBe(true);
    expect(fieldMatches({ $lt: LATER }, { x: '2024-03-10t10:00:00z' })).toBe(true);
  });
});

describe('$empty operator', () => {
  const EMPTY_VALUES: Array<[string, unknown]> = [
    ['empty string', ''],
    ['empty array', []],
    ['empty object', {}],
    ['null', null],
  ];
  const NON_EMPTY_VALUES: Array<[string, unknown]> = [
    ['zero', 0],
    ['false', false],
    ['non-empty string', 'a'],
    ['whitespace string', ' '],
    ['non-empty array', [0]],
    ['array holding an empty array', [[]]],
    ['non-empty object', { a: undefined }],
    ['non-zero number', 1],
    ['true', true],
  ];

  describe.each(EMPTY_VALUES)('%s', (_name, value) => {
    it('matches $empty: true', () => {
      expect(fieldMatches({ $empty: true }, { x: value })).toBe(true);
    });

    it('does not match $empty: false', () => {
      expect(fieldMatches({ $empty: false }, { x: value })).toBe(false);
    });
  });

  describe.each(NON_EMPTY_VALUES)('%s', (_name, value) => {
    it('does not match $empty: true', () => {
      expect(fieldMatches({ $empty: true }, { x: value })).toBe(false);
    });

    it('matches $empty: false', () => {
      expect(fieldMatches({ $empty: false }, { x: value })).toBe(true);
    });
  });

  describe('missing field', () => {
    it('does not match $empty: true when the field is absent', () => {
      expect(fieldMatches({ $empty: true }, {})).toBe(false);
    });

    it('does not match $empty: false when the field is absent', () => {
      expect(fieldMatches({ $empty: false }, {})).toBe(false);
    });

    it('treats an explicit undefined like an absent field', () => {
      expect(fieldMatches({ $empty: true }, { x: undefined })).toBe(false);
      expect(fieldMatches({ $empty: false }, { x: undefined })).toBe(false);
    });

    it('treats an unreachable nested path like an absent field', () => {
      expect(matched({ field: 'a.b', operator: { $empty: true } }, { a: 'text' })).toBe(false);
      expect(matched({ field: 'a.b', operator: { $empty: false } }, { a: 'text' })).toBe(false);
    });
  });

  it('is the negation partner of itself only for present values', () => {
    const condition = { $not: { field: 'x', operator: { $empty: true } } } as const;
    expect(matched(condition, { x: 'a' })).toBe(true);
    // Absent is neither empty nor non-empty, so `$not` of `$empty: true` matches it.
    expect(matched(condition, {})).toBe(true);
  });
});
