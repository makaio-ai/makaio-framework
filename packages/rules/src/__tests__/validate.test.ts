import { type Condition, type FieldOperator, type JsonSchema, zodSchemaToJsonRecord } from '@makaio/contracts/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertValidCondition, ConditionValidationError, validateCondition } from '../validate.js';

const orderSchema: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    state: { type: 'string' },
    total: { type: 'number' },
    tags: { type: 'array', items: { type: 'string' } },
    note: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    customer: {
      type: 'object',
      properties: { name: { type: 'string' }, tier: { type: 'string' } },
      required: ['name'],
    },
  },
  required: ['id', 'state', 'total', 'tags', 'createdAt', 'customer'],
  additionalProperties: false,
};

/**
 * Build a context schema from top-level fields; every field is required.
 * @param properties - Schemas of the top-level fields
 * @param additionalProperties - Treatment of top-level fields not listed
 * @returns Context schema
 */
function ctx(properties: Record<string, JsonSchema>, additionalProperties = false): JsonSchema {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties };
}

/**
 * Check a condition against a context with the `order` field.
 * @param condition - Condition to check
 * @param additionalProperties - Whether top-level fields other than `order` are admitted
 * @returns Findings
 */
function check(condition: Condition, additionalProperties = false) {
  return validateCondition({ condition, context: ctx({ order: orderSchema }, additionalProperties) });
}

/**
 * Codes of the findings, in order.
 * @param condition - Condition to check
 * @returns Finding codes
 */
function codes(condition: Condition): string[] {
  return check(condition).map((finding) => finding.code);
}

describe('validateCondition', () => {
  describe('clean conditions', () => {
    it('returns no findings for a fitting field condition', () => {
      expect(check({ field: 'order.state', operator: 'open' })).toEqual([]);
    });

    it('returns no findings for a required field under $ne without a guard', () => {
      expect(check({ field: 'order.state', operator: { $ne: 'closed' } })).toEqual([]);
    });

    it('returns no findings for a required nested field under $nin', () => {
      expect(check({ field: 'order.customer.name', operator: { $nin: ['a'] } })).toEqual([]);
    });

    it('returns no findings for a required field under $exists: false', () => {
      expect(check({ field: 'order.id', operator: { $exists: false } })).toEqual([]);
    });
  });

  describe('unknown-root', () => {
    it('reports a field whose first segment is not in the context properties', () => {
      expect(check({ field: 'invoice.total', operator: 1 })).toEqual([
        expect.objectContaining({ severity: 'error', code: 'unknown-root', path: 'field' }),
      ]);
    });

    it('names the known roots in the message', () => {
      const [finding] = check({ field: 'invoice.total', operator: 1 });
      expect(finding?.message).toContain('invoice');
      expect(finding?.message).toContain('order');
    });

    it('does not report a known root', () => {
      expect(codes({ field: 'order.total', operator: 1 })).not.toContain('unknown-root');
    });

    it('treats an inherited property name as an unknown root', () => {
      expect(codes({ field: 'constructor.name', operator: 'x' })).toEqual(['unknown-root']);
    });

    it('reports the finding path inside nested conditions', () => {
      const findings = check({ $and: [{ field: 'order.id', operator: 'a' }, { $not: { field: 'x.y', operator: 1 } }] });
      expect(findings.map((finding) => finding.path)).toEqual(['$and[1].$not.field']);
    });
  });

  describe('additionalProperties: true at top level', () => {
    it('gives no finding for an unknown root under $eq', () => {
      expect(check({ field: 'invoice.total', operator: 1 }, true)).toEqual([]);
    });

    it('gives no finding for an unknown root under any type-bound operator', () => {
      expect(check({ field: 'invoice.tags', operator: { $contains: 'a' } }, true)).toEqual([]);
      expect(check({ field: 'invoice.total', operator: { $lt: 3 } }, true)).toEqual([]);
    });

    it('treats the unknown root as optional: $ne needs a guard', () => {
      expect(check({ field: 'invoice.total', operator: { $ne: 1 } }, true).map((f) => f.code)).toEqual([
        'unguarded-negation',
      ]);
    });

    it('accepts the guarded form', () => {
      expect(
        check(
          {
            $and: [
              { field: 'invoice.total', operator: { $exists: true } },
              { field: 'invoice.total', operator: { $ne: 1 } },
            ],
          },
          true,
        ),
      ).toEqual([]);
    });

    it('still checks known roots', () => {
      expect(check({ field: 'order.nope', operator: 1 }, true).map((f) => f.code)).toEqual(['unknown-path']);
    });

    it('reports unknown roots when additionalProperties is false', () => {
      expect(check({ field: 'invoice.total', operator: 1 }, false).map((f) => f.code)).toEqual(['unknown-root']);
    });
  });

  describe('top-level fields of the context schema', () => {
    const optionalCtx = (extra: Partial<JsonSchema> = {}): JsonSchema => ({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['b'],
      additionalProperties: false,
      ...extra,
    });
    const run = (condition: Condition, context: JsonSchema) => validateCondition({ condition, context });

    it('reports $ne on an optional top-level field without a guard', () => {
      expect(run({ field: 'a', operator: { $ne: 'x' } }, optionalCtx()).map((f) => f.code)).toEqual([
        'unguarded-negation',
      ]);
    });

    it('accepts $ne on an optional top-level field after an $exists: true guard', () => {
      expect(
        run(
          {
            $and: [
              { field: 'a', operator: { $exists: true } },
              { field: 'a', operator: { $ne: 'x' } },
            ],
          },
          optionalCtx(),
        ),
      ).toEqual([]);
    });

    it('accepts $ne on a top-level field listed in required', () => {
      expect(run({ field: 'b', operator: { $ne: 'x' } }, optionalCtx())).toEqual([]);
    });

    it('admits an unknown first segment as optional under additionalProperties: true', () => {
      const context = optionalCtx({ additionalProperties: true });
      expect(run({ field: 'zzz.deep', operator: 1 }, context)).toEqual([]);
      expect(run({ field: 'zzz', operator: { $ne: 1 } }, context).map((f) => f.code)).toEqual(['unguarded-negation']);
      expect(
        run(
          {
            $and: [
              { field: 'zzz', operator: { $exists: true } },
              { field: 'zzz', operator: { $ne: 1 } },
            ],
          },
          context,
        ),
      ).toEqual([]);
    });

    it('rejects an unknown first segment under additionalProperties: false', () => {
      expect(run({ field: 'zzz', operator: 1 }, optionalCtx())).toEqual([
        expect.objectContaining({ severity: 'error', code: 'unknown-root', path: 'field' }),
      ]);
    });

    it('rejects an unknown first segment when properties are listed and additionalProperties is missing', () => {
      const context: JsonSchema = { type: 'object', properties: { a: { type: 'string' } } };
      expect(run({ field: 'zzz', operator: 1 }, context).map((f) => f.code)).toEqual(['unknown-root']);
    });

    it('admits any first segment when the context has no properties', () => {
      expect(run({ field: 'zzz.deep', operator: 1 }, { type: 'object' })).toEqual([]);
      expect(run({ field: 'zzz', operator: { $ne: 1 } }, {}).map((f) => f.code)).toEqual(['unguarded-negation']);
    });

    it('checks the type of an additionalProperties schema', () => {
      const context: JsonSchema = { type: 'object', additionalProperties: { type: 'number' } };
      expect(run({ field: 'zzz', operator: 'x' }, context).map((f) => f.code)).toEqual(['type-mismatch']);
    });

    it('reads the context schema through $ref', () => {
      const context: JsonSchema = {
        $ref: '#/$defs/Ctx',
        $defs: {
          Ctx: {
            type: 'object',
            properties: { a: { type: 'string' }, b: { type: 'number' } },
            required: ['b'],
            additionalProperties: false,
          },
        },
      };
      expect(run({ field: 'b', operator: { $ne: 1 } }, context)).toEqual([]);
      expect(run({ field: 'a', operator: { $ne: 'x' } }, context).map((f) => f.code)).toEqual(['unguarded-negation']);
      expect(run({ field: 'b', operator: 'x' }, context).map((f) => f.code)).toEqual(['type-mismatch']);
      expect(run({ field: 'zzz', operator: 1 }, context).map((f) => f.code)).toEqual(['unknown-root']);
    });

    it('reads the context schema through allOf', () => {
      const context: JsonSchema = {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } } },
          { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
        ],
      };
      expect(run({ field: 'b', operator: { $ne: 1 } }, context)).toEqual([]);
      expect(run({ field: 'a', operator: { $ne: 'x' } }, context).map((f) => f.code)).toEqual(['unguarded-negation']);
      expect(run({ field: 'zzz', operator: 1 }, context).map((f) => f.code)).toEqual(['unknown-root']);
    });
  });

  describe('unknown-path', () => {
    it('reports a path a closed schema does not list', () => {
      expect(check({ field: 'order.nope', operator: 1 })).toEqual([
        expect.objectContaining({ severity: 'error', code: 'unknown-path', path: 'field' }),
      ]);
    });

    it('reports a misspelled nested path', () => {
      expect(codes({ field: 'order.customer.nmae', operator: 'a' })).toEqual(['unknown-path']);
    });

    it('reports a path below a scalar', () => {
      expect(codes({ field: 'order.state.length', operator: 1 })).toEqual(['unknown-path']);
    });

    it('does not report a listed path', () => {
      expect(codes({ field: 'order.customer.name', operator: 'a' })).toEqual([]);
    });

    it('reports a path that lists properties without additionalProperties', () => {
      const findings = validateCondition({
        condition: { field: 'o.b', operator: 1 },
        context: ctx({ o: { type: 'object', properties: { a: { type: 'string' } } } }),
      });
      expect(findings.map((f) => f.code)).toEqual(['unknown-path']);
    });

    it('accepts an array index segment', () => {
      expect(codes({ field: 'order.tags.0', operator: 'a' })).toEqual([]);
    });

    it('does not resolve an index into the items of a prefixItems tuple', () => {
      const tuple: JsonSchema = { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } };
      const findings = validateCondition({
        condition: { field: 'o.list.0', operator: 'a' },
        context: ctx({ o: { type: 'object', properties: { list: tuple }, required: ['list'] } }),
      });
      expect(findings).toEqual([]);
    });
  });

  describe('open schemas', () => {
    it.each([
      ['an empty schema', {}],
      ['an object schema without properties', { type: 'object' }],
      [
        'additionalProperties: true',
        { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
      ],
    ] as const)('gives no finding for any path under %s', (_label, schema) => {
      const findings = validateCondition({
        condition: { field: 'o.deep.er.path', operator: { $eq: 1 } },
        context: ctx({ o: schema }),
      });
      expect(findings).toEqual([]);
    });

    it('skips the type check when the type is unknown', () => {
      const findings = validateCondition({
        condition: { field: 'o.x', operator: { $contains: 'a' } },
        context: ctx({ o: {} }),
      });
      expect(findings).toEqual([]);
    });

    it('treats a path in an open schema as optional', () => {
      const findings = validateCondition({
        condition: { field: 'o.x', operator: { $ne: 1 } },
        context: ctx({ o: {} }),
      });
      expect(findings.map((f) => f.code)).toEqual(['unguarded-negation']);
    });
  });

  describe('open schemas and guards on an ancestor', () => {
    const negation: Condition = { field: 'o.x', operator: { $ne: 1 } };

    it('(e) keeps the finding when the guard is on the required ancestor of an open path', () => {
      const findings = validateCondition({
        condition: { $and: [{ field: 'o', operator: { $exists: true } }, negation] },
        context: ctx({ o: {} }),
      });
      expect(findings.map((f) => f.code)).toEqual(['unguarded-negation']);
    });

    it('keeps the finding when a top-level guard stands for an unlisted root', () => {
      const findings = check(
        {
          $and: [
            { field: 'invoice', operator: { $exists: true } },
            { field: 'invoice.total', operator: { $ne: 1 } },
          ],
        },
        true,
      );
      expect(findings.map((f) => f.code)).toEqual(['unguarded-negation']);
    });

    it('is cleared by a guard on the path itself', () => {
      const findings = validateCondition({
        condition: { $and: [{ field: 'o.x', operator: { $exists: true } }, negation] },
        context: ctx({ o: {} }),
      });
      expect(findings).toEqual([]);
    });
  });

  describe('open schema that requires an unlisted property', () => {
    const open: JsonSchema = { type: 'object', required: ['tenant'], additionalProperties: true };
    const noProperties: JsonSchema = { type: 'object', required: ['tenant'] };

    it.each([
      ['additionalProperties: true', open],
      ['no properties', noProperties],
    ])('%s: the required property needs no guard, what lies below it does', (_label, schema) => {
      const context = ctx({ payload: schema });
      const negate = (field: string): Condition => ({ field, operator: { $ne: 'x' } });
      const found = (condition: Condition) => validateCondition({ condition, context }).map((f) => f.code);

      expect(found(negate('payload.tenant'))).toEqual([]);
      expect(found(negate('payload.tenant.id'))).toEqual(['unguarded-negation']);
      expect(
        found({
          $and: [{ field: 'payload.tenant.id', operator: { $exists: true } }, negate('payload.tenant.id')],
        }),
      ).toEqual([]);
    });

    it('anyOf: an open key required by every branch needs no guard', () => {
      const context = ctx({ x: { anyOf: [open, { type: 'object', required: ['tenant'] }] } });
      expect(validateCondition({ condition: { field: 'x.tenant', operator: { $ne: 'v' } }, context })).toEqual([]);
    });

    it('anyOf: an open key required by only one branch is still reported', () => {
      const context = ctx({ x: { anyOf: [open, { type: 'object', additionalProperties: true }] } });
      expect(
        validateCondition({ condition: { field: 'x.tenant', operator: { $ne: 'v' } }, context }).map((f) => f.code),
      ).toEqual(['unguarded-negation']);
    });
  });

  describe('type-mismatch', () => {
    it('reports $eq with an operand of another type, and accepts a matching one', () => {
      expect(check({ field: 'order.total', operator: 'ten' }).map((f) => f.code)).toEqual(['type-mismatch']);
      expect(check({ field: 'order.total', operator: { $eq: 10 } })).toEqual([]);
    });

    it('reports the operator path', () => {
      const [finding] = check({ field: 'order.total', operator: { $eq: 'x' } });
      expect(finding?.path).toBe('operator');
    });

    it('checks $ne by operand type', () => {
      expect(codes({ field: 'order.state', operator: { $ne: 5 } })).toEqual(['type-mismatch']);
      expect(codes({ field: 'order.state', operator: { $ne: 'a' } })).toEqual([]);
    });

    it('checks every entry of $in and names the entry', () => {
      expect(codes({ field: 'order.state', operator: { $in: ['a', 'b'] } })).toEqual([]);
      const [finding] = check({ field: 'order.state', operator: { $in: ['a', 2] } });
      expect(finding?.code).toBe('type-mismatch');
      expect(finding?.message).toContain('entry 1');
    });

    it('checks every entry of $nin', () => {
      expect(codes({ field: 'order.state', operator: { $nin: [1] } })).toEqual(['type-mismatch']);
      expect(codes({ field: 'order.state', operator: { $nin: ['a'] } })).toEqual([]);
    });

    it('requires an array for $contains and $containsPrefix', () => {
      expect(codes({ field: 'order.state', operator: { $contains: 'a' } })).toEqual(['type-mismatch']);
      expect(codes({ field: 'order.state', operator: { $containsPrefix: 'a' } })).toEqual(['type-mismatch']);
      expect(codes({ field: 'order.tags', operator: { $contains: 'a' } })).toEqual([]);
      expect(codes({ field: 'order.tags', operator: { $containsPrefix: 'a' } })).toEqual([]);
    });

    describe('item types of $contains and $containsPrefix', () => {
      /**
       * Check a containment operator on a field `list` with the given schema.
       * @param list - Schema of the array field
       * @param operator - Containment operator
       * @returns Finding codes
       */
      function itemCodes(list: JsonSchema, operator: FieldOperator): string[] {
        return validateCondition({
          condition: { field: 'o.list', operator },
          context: ctx({ o: { type: 'object', properties: { list }, required: ['list'] } }),
        }).map((finding) => finding.code);
      }

      it('reports an operand the items cannot have', () => {
        expect(codes({ field: 'order.tags', operator: { $contains: 1 } })).toEqual(['type-mismatch']);
        expect(itemCodes({ type: 'array', items: { type: 'number' } }, { $contains: 'x' })).toEqual(['type-mismatch']);
      });

      it('reports $containsPrefix on items that are not strings', () => {
        expect(itemCodes({ type: 'array', items: { type: 'number' } }, { $containsPrefix: 'a' })).toEqual([
          'type-mismatch',
        ]);
      });

      it('accepts operands the items can have', () => {
        expect(itemCodes({ type: 'array', items: { type: 'number' } }, { $contains: 1 })).toEqual([]);
        expect(itemCodes({ type: 'array', items: { type: ['string', 'null'] } }, { $contains: null })).toEqual([]);
        expect(
          itemCodes({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } }, { $contains: 1 }),
        ).toEqual([]);
      });

      it.each([
        ['no items', { type: 'array' }],
        ['items: true', { type: 'array', items: true }],
        ['items: {}', { type: 'array', items: {} }],
        ['draft-07 tuple items', { type: 'array', items: [{ type: 'string' }] }],
        ['items: false', { type: 'array', items: false }],
        ['prefixItems', { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'number' } }],
        ['an unconstrained anyOf branch', { type: 'array', items: { anyOf: [{ type: 'string' }, {}] } }],
      ] as const)('gives no finding when the item types are unknown: %s', (_label, list) => {
        expect(itemCodes(list, { $contains: 1 })).toEqual([]);
        expect(itemCodes(list, { $containsPrefix: 'a' })).toEqual([]);
      });
    });

    it('requires a string for $startsWith, $endsWith and $glob', () => {
      for (const operator of [{ $startsWith: 'a' }, { $endsWith: 'a' }, { $glob: 'a*' }]) {
        expect(codes({ field: 'order.total', operator })).toEqual(['type-mismatch']);
        expect(codes({ field: 'order.state', operator })).toEqual([]);
      }
    });

    it('accepts $lt, $lte, $gt, $gte with a number on a number field', () => {
      for (const operator of [{ $lt: 1 }, { $lte: 1 }, { $gt: 1 }, { $gte: 1 }]) {
        expect(codes({ field: 'order.total', operator })).toEqual([]);
      }
    });

    it('reports $lt, $lte, $gt, $gte on a plain string field and with a number operand on a date-time', () => {
      for (const operator of [{ $lt: '2026-01-01T00:00:00Z' }, { $lte: 1 }, { $gt: 1 }, { $gte: 1 }]) {
        expect(codes({ field: 'order.state', operator })).toEqual(['type-mismatch']);
      }
      expect(codes({ field: 'order.createdAt', operator: { $gt: 1 } })).toEqual(['type-mismatch']);
    });

    it('accepts a string operand on a date-time field', () => {
      expect(codes({ field: 'order.createdAt', operator: { $gte: '2026-01-01T00:00:00Z' } })).toEqual([]);
    });

    it('accepts a nine-digit fraction on a date-time field', () => {
      expect(codes({ field: 'order.createdAt', operator: { $gte: '2026-01-01T00:00:00.123456789+02:00' } })).toEqual(
        [],
      );
    });

    it('reports a string operand that is not an RFC 3339 date-time on a date-time field', () => {
      for (const operand of ['not a date', '2026-02-30T00:00:00Z', '2026-01-01']) {
        const findings = check({ field: 'order.createdAt', operator: { $gte: operand } });
        expect(findings.map((finding) => finding.code)).toEqual(['type-mismatch']);
        expect(findings[0]?.message).toContain('not an RFC 3339 date-time');
      }
    });

    it('reports a string operand against a number field', () => {
      expect(codes({ field: 'order.total', operator: { $lt: '5' } })).toEqual(['type-mismatch']);
    });

    it('accepts $empty on strings, arrays and objects, and reports it on a number', () => {
      expect(codes({ field: 'order.state', operator: { $empty: true } })).toEqual([]);
      expect(codes({ field: 'order.tags', operator: { $empty: false } })).toEqual([]);
      expect(codes({ field: 'order.customer', operator: { $empty: true } })).toEqual([]);
      expect(codes({ field: 'order.total', operator: { $empty: true } })).toEqual(['type-mismatch']);
    });

    it('reports $empty: false on a number and names $exists: true as the replacement', () => {
      expect(codes({ field: 'order.total', operator: { $empty: false } })).toEqual(['type-mismatch']);
      expect(check({ field: 'order.total', operator: { $empty: false } })[0]?.message).toContain('{ $exists: true }');
    });

    it('never reports $exists', () => {
      expect(codes({ field: 'order.total', operator: { $exists: true } })).toEqual([]);
    });

    it('is not reported together with the unknown path', () => {
      expect(codes({ field: 'order.nope', operator: { $contains: 'a' } })).toEqual(['unknown-path']);
    });
  });

  describe('unguarded-negation', () => {
    const noteExists: Condition = { field: 'order.note', operator: { $exists: true } };

    it.each<[string, FieldOperator]>([
      ['$ne', { $ne: 'a' }],
      ['$nin', { $nin: ['a'] }],
    ])('reports %s on an optional field', (_label, operator) => {
      expect(check({ field: 'order.note', operator })).toEqual([
        expect.objectContaining({ severity: 'error', code: 'unguarded-negation', path: 'operator' }),
      ]);
    });

    it('never reports an explicit $exists test on an optional field', () => {
      expect(codes({ field: 'order.note', operator: { $exists: false } })).toEqual([]);
      expect(codes({ $not: noteExists })).toEqual([]);
    });

    it('reports $ne on an optional nested field of a required parent', () => {
      expect(codes({ field: 'order.customer.tier', operator: { $ne: 'gold' } })).toEqual(['unguarded-negation']);
    });

    it('does not report a positive operator on an optional field', () => {
      expect(codes({ field: 'order.note', operator: 'a' })).toEqual([]);
      expect(codes({ field: 'order.note', operator: { $in: ['a'] } })).toEqual([]);
      expect(codes({ field: 'order.note', operator: { $exists: true } })).toEqual([]);
    });

    it('is satisfied by a $exists: true guard before it in the same $and', () => {
      expect(codes({ $and: [noteExists, { field: 'order.note', operator: { $ne: 'a' } }] })).toEqual([]);
    });

    it('is satisfied by a $exists: true guard after it, because $and never short-circuits', () => {
      expect(codes({ $and: [{ field: 'order.note', operator: { $ne: 'a' } }, noteExists] })).toEqual([]);
    });

    it('is not satisfied by a guard on another field', () => {
      expect(
        codes({
          $and: [
            { field: 'order.customer.tier', operator: { $exists: true } },
            { field: 'order.note', operator: { $ne: 'a' } },
          ],
        }),
      ).toEqual(['unguarded-negation']);
    });

    it('is not satisfied by a guard inside an $or', () => {
      expect(codes({ $or: [noteExists, { field: 'order.note', operator: { $ne: 'a' } }] })).toEqual([
        'unguarded-negation',
      ]);
    });

    it('is satisfied by a guard in an enclosing $and when the negation is nested deeper', () => {
      expect(
        codes({
          $and: [
            noteExists,
            {
              $or: [
                { field: 'order.note', operator: { $ne: 'a' } },
                { field: 'order.id', operator: 'x' },
              ],
            },
          ],
        }),
      ).toEqual([]);
    });

    it('is satisfied by a guard in a nested $and of the same conjunction', () => {
      expect(
        codes({
          $and: [{ $and: [noteExists] }, { field: 'order.note', operator: { $ne: 'a' } }],
        }),
      ).toEqual([]);
    });

    it('reports a positive operator under $not on an optional field', () => {
      expect(codes({ $not: { field: 'order.note', operator: 'a' } })).toEqual(['unguarded-negation']);
    });

    it('is satisfied by a guard before a $not on the same field', () => {
      expect(codes({ $and: [noteExists, { $not: { field: 'order.note', operator: 'a' } }] })).toEqual([]);
    });

    it('does not report a required field under $not', () => {
      expect(codes({ $not: { field: 'order.state', operator: 'a' } })).toEqual([]);
    });

    it('treats a double $not as positive', () => {
      expect(codes({ $not: { $not: { field: 'order.note', operator: 'a' } } })).toEqual([]);
      expect(codes({ $not: { $not: { field: 'order.note', operator: { $ne: 'a' } } } })).toEqual([
        'unguarded-negation',
      ]);
    });

    it('does not let a guard under $not protect', () => {
      expect(
        codes({
          $and: [
            { $not: { field: 'order.note', operator: { $exists: true } } },
            { field: 'order.note', operator: { $ne: 'a' } },
          ],
        }),
      ).toEqual(['unguarded-negation']);
    });
  });

  describe('$expr', () => {
    it('gives exactly one expression-unchecked warning for a valid expression', () => {
      expect(check({ $expr: 'order.total > 5' })).toEqual([
        {
          severity: 'warning',
          code: 'expression-unchecked',
          path: '$expr',
          message: expect.any(String),
        },
      ]);
    });

    it('gives expression-syntax for an expression that does not compile', () => {
      const findings = check({ $expr: '(' });
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: 'error', code: 'expression-syntax', path: '$expr' });
      expect(findings[0]?.message.length).toBeGreaterThan(0);
    });

    it('gives expression-syntax for an empty expression', () => {
      expect(codes({ $expr: '' })).toEqual(['expression-syntax']);
    });

    it('reports the path inside compounds', () => {
      expect(check({ $and: [{ field: 'order.id', operator: 'a' }, { $not: { $expr: '(' } }] })[0]?.path).toBe(
        '$and[1].$not.$expr',
      );
      expect(check({ $or: [{ $expr: 'order.total > 1' }] })[0]?.path).toBe('$or[0].$expr');
    });

    it('collects findings of all children in tree order', () => {
      expect(
        codes({ $and: [{ $expr: '(' }, { field: 'order.nope', operator: 1 }, { $expr: 'order.total > 1' }] }),
      ).toEqual(['expression-syntax', 'unknown-path', 'expression-unchecked']);
    });
  });

  describe('schema combinators', () => {
    it('anyOf: knows a path that any branch lists', () => {
      const schema: JsonSchema = {
        anyOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
          { type: 'object', properties: { b: { type: 'number' } }, required: ['b'], additionalProperties: false },
        ],
      };
      expect(validateCondition({ condition: { field: 'x.a', operator: 'v' }, context: ctx({ x: schema }) })).toEqual(
        [],
      );
      expect(validateCondition({ condition: { field: 'x.b', operator: 1 }, context: ctx({ x: schema }) })).toEqual([]);
      expect(
        validateCondition({ condition: { field: 'x.c', operator: 1 }, context: ctx({ x: schema }) }).map((f) => f.code),
      ).toEqual(['unknown-path']);
    });

    it('anyOf: a field required by only one branch is optional', () => {
      const schema: JsonSchema = {
        anyOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
          { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
        ],
      };
      expect(
        validateCondition({ condition: { field: 'x.a', operator: { $ne: 'v' } }, context: ctx({ x: schema }) }).map(
          (f) => f.code,
        ),
      ).toEqual(['unguarded-negation']);
    });

    it('anyOf: a field required by every branch needs no guard', () => {
      const branch: JsonSchema = {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      };
      expect(
        validateCondition({
          condition: { field: 'x.a', operator: { $ne: 'v' } },
          context: ctx({ x: { anyOf: [branch, branch] } }),
        }),
      ).toEqual([]);
    });

    it('anyOf: the field type is the union of the branch types', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { v: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
        required: ['v'],
        additionalProperties: false,
      };
      expect(validateCondition({ condition: { field: 'x.v', operator: 1 }, context: ctx({ x: schema }) })).toEqual([]);
      expect(validateCondition({ condition: { field: 'x.v', operator: 'a' }, context: ctx({ x: schema }) })).toEqual(
        [],
      );
      expect(
        validateCondition({ condition: { field: 'x.v', operator: true }, context: ctx({ x: schema }) }).map(
          (f) => f.code,
        ),
      ).toEqual(['type-mismatch']);
    });

    it('allOf: merges the properties of its branches', () => {
      const schema: JsonSchema = {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
          { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
        ],
      };
      expect(validateCondition({ condition: { field: 'x.a', operator: 'v' }, context: ctx({ x: schema }) })).toEqual(
        [],
      );
      expect(
        validateCondition({ condition: { field: 'x.b', operator: { $lt: 3 } }, context: ctx({ x: schema }) }),
      ).toEqual([]);
      expect(
        validateCondition({ condition: { field: 'x.a', operator: { $ne: 'v' } }, context: ctx({ x: schema }) }),
      ).toEqual([]);
      expect(
        validateCondition({ condition: { field: 'x.c', operator: 1 }, context: ctx({ x: schema }) }).map((f) => f.code),
      ).toEqual(['unknown-path']);
    });

    it('allOf: a field required by any branch is required', () => {
      const schema: JsonSchema = {
        allOf: [
          { type: 'object', properties: { a: { type: 'string' } } },
          { type: 'object', required: ['a'] },
        ],
      };
      expect(
        validateCondition({ condition: { field: 'x.a', operator: { $ne: 'v' } }, context: ctx({ x: schema }) }),
      ).toEqual([]);
    });

    it('$ref: follows a local reference into $defs', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { item: { $ref: '#/$defs/Item' } },
        required: ['item'],
        additionalProperties: false,
      };
      // Local references resolve against the context schema, so the definitions live at its root.
      const context: JsonSchema = {
        ...ctx({ x: schema }),
        $defs: {
          Item: {
            type: 'object',
            properties: { qty: { type: 'number' } },
            required: ['qty'],
            additionalProperties: false,
          },
        },
      };
      expect(validateCondition({ condition: { field: 'x.item.qty', operator: { $gt: 1 } }, context })).toEqual([]);
      expect(
        validateCondition({ condition: { field: 'x.item.qty', operator: 'a' }, context }).map((f) => f.code),
      ).toEqual(['type-mismatch']);
      expect(
        validateCondition({ condition: { field: 'x.item.nope', operator: 1 }, context }).map((f) => f.code),
      ).toEqual(['unknown-path']);
    });

    it('$ref: follows a reference to a leaf type', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: { when: { $ref: '#/definitions/Stamp' } },
        required: ['when'],
        additionalProperties: false,
      };
      const context: JsonSchema = {
        ...ctx({ x: schema }),
        definitions: { Stamp: { type: 'string', format: 'date-time' } },
      };
      expect(
        validateCondition({
          condition: { field: 'x.when', operator: { $gt: '2026-01-01T00:00:00Z' } },
          context,
        }),
      ).toEqual([]);
      expect(
        validateCondition({ condition: { field: 'x.when', operator: { $gt: 1 } }, context }).map((f) => f.code),
      ).toEqual(['type-mismatch']);
    });

    it('$ref: terminates on a self-referencing schema', () => {
      const context: JsonSchema = {
        ...ctx({ x: { $ref: '#/$defs/Node' } }),
        $defs: {
          Node: {
            type: 'object',
            properties: { value: { type: 'number' }, next: { $ref: '#/$defs/Node' } },
            additionalProperties: false,
          },
        },
      };
      expect(validateCondition({ condition: { field: 'x.next.next.value', operator: { $lt: 1 } }, context })).toEqual(
        [],
      );
      expect(
        validateCondition({ condition: { field: 'x.next.nope', operator: 1 }, context }).map((f) => f.code),
      ).toEqual(['unknown-path']);
    });

    it('$ref: an unresolvable reference leaves the path open', () => {
      const schema: JsonSchema = { type: 'object', properties: { a: { $ref: 'https://example.com/a.json' } } };
      expect(validateCondition({ condition: { field: 'x.a.b.c', operator: 1 }, context: ctx({ x: schema }) })).toEqual(
        [],
      );
    });
  });

  describe('schema from zodSchemaToJsonRecord', () => {
    const jsonRoot = zodSchemaToJsonRecord(
      z.object({
        id: z.string(),
        amount: z.number(),
        label: z.string().optional(),
        lines: z.array(z.object({ sku: z.string() })),
        paidAt: z.iso.datetime(),
      }),
    );

    it('accepts conditions that fit the schema', () => {
      expect(
        validateCondition({
          condition: { field: 'invoice.amount', operator: { $gte: 10 } },
          context: ctx({ invoice: jsonRoot }),
        }),
      ).toEqual([]);
      expect(
        validateCondition({
          condition: { field: 'invoice.lines.0.sku', operator: 'a' },
          context: ctx({ invoice: jsonRoot }),
        }),
      ).toEqual([]);
    });

    it('reports an unknown path', () => {
      expect(
        validateCondition({
          condition: { field: 'invoice.nope', operator: 1 },
          context: ctx({ invoice: jsonRoot }),
        }).map((f) => f.code),
      ).toEqual(['unknown-path']);
    });

    it('reports a type mismatch', () => {
      expect(
        validateCondition({
          condition: { field: 'invoice.amount', operator: 'x' },
          context: ctx({ invoice: jsonRoot }),
        }).map((f) => f.code),
      ).toEqual(['type-mismatch']);
    });

    it('requires a guard for an optional field and not for a required one', () => {
      const negated = (field: string): Condition => ({ field, operator: { $ne: 'a' } });
      expect(
        validateCondition({ condition: negated('invoice.label'), context: ctx({ invoice: jsonRoot }) }).map(
          (f) => f.code,
        ),
      ).toEqual(['unguarded-negation']);
      expect(validateCondition({ condition: negated('invoice.id'), context: ctx({ invoice: jsonRoot }) })).toEqual([]);
    });
  });
});

describe('assertValidCondition', () => {
  const context = ctx({ order: orderSchema });

  it('returns the warnings of a condition without errors', () => {
    const warnings = assertValidCondition({ condition: { $expr: 'order.total > 1' }, context }, 'label');

    expect(warnings.map((finding) => [finding.severity, finding.code])).toEqual([['warning', 'expression-unchecked']]);
  });

  it('returns no warnings for a clean condition', () => {
    expect(assertValidCondition({ condition: { field: 'order.id', operator: 'a' }, context }, 'label')).toEqual([]);
  });

  it('throws one error that lists every error finding under the label', () => {
    const condition: Condition = {
      $and: [
        { field: 'order.nope', operator: 'x' },
        { field: 'missing.id', operator: 'x' },
        { $expr: 'order.total >' },
      ],
    };

    let caught: unknown;
    try {
      assertValidCondition({ condition, context }, 'Rule r1');
    } catch (cause) {
      caught = cause;
    }

    if (!(caught instanceof ConditionValidationError)) throw new Error('expected a ConditionValidationError');
    const failure = caught;
    expect(failure.findings.map((finding) => finding.code)).toEqual([
      'unknown-path',
      'unknown-root',
      'expression-syntax',
    ]);
    expect(failure.message).toMatch(
      /^Rule r1: unknown-path at '\$and\[0\]\.field': .*; unknown-root at '\$and\[1\]\.field': .*; expression-syntax at '\$and\[2\]\.\$expr': /,
    );
  });
});
