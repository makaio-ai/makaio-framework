import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { JsonRecordSchema, zodSchemaToJsonRecord } from '@makaio/contracts/shared';
import type { WorkflowAutomationTriggerBinding } from '@makaio/contracts';
import type { Condition } from '@makaio/rules';
import { compileWorkflowTriggerCondition } from '../workflow-trigger-binding-consumer.js';

/**
 * Builds a binding whose `when` is checked against an event schema.
 * @param when - Condition under test.
 * @returns The binding.
 */
function bindingWith(when: Condition): WorkflowAutomationTriggerBinding {
  return { kind: 'test.event', params: {}, when };
}

/** Self-recursive event schema; zod writes the cycle back to the root as `$ref: '#'`. */
const RecursiveEvent = z.object({
  name: z.string(),
  get child() {
    return RecursiveEvent.optional();
  },
});

describe('compileWorkflowTriggerCondition reference root', () => {
  const recursive = zodSchemaToJsonRecord(RecursiveEvent, 'output');

  it('accepts a path through a self-recursive event schema and evaluates it', () => {
    const { matches } = compileWorkflowTriggerCondition(
      bindingWith({ field: 'payload.child.child.name', operator: 'x' }),
      recursive,
    );
    expect(matches({ name: 'a', child: { name: 'b', child: { name: 'x' } } })).toEqual({ matched: true });
  });

  it('rejects a typo below a self-recursive reference as unknown-path', () => {
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.child.nmae', operator: 'x' }), recursive),
    ).toThrow(/unknown-path/);
  });

  it('rejects a numeric operand on a string field behind the reference as type-mismatch', () => {
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.child.name', operator: { $gt: 1 } }), recursive),
    ).toThrow(/type-mismatch/);
  });

  it('type-checks paths below a $defs reference', () => {
    const schema = {
      type: 'object',
      properties: { item: { $ref: '#/$defs/item' } },
      required: ['item'],
      additionalProperties: false,
      $defs: {
        item: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
      },
    };
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.item.id', operator: 'x' }), schema),
    ).not.toThrow();
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.item.idd', operator: 'x' }), schema),
    ).toThrow(/unknown-path/);
  });

  it('leaves a property named $ref and data keyword values untouched', () => {
    const schema = {
      type: 'object',
      properties: {
        $ref: { type: 'string' },
        kind: { const: { $ref: '#/nowhere' } },
      },
      additionalProperties: false,
    };
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.$ref', operator: 'x' }), schema),
    ).not.toThrow();
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.$ref', operator: { $gt: 1 } }), schema),
    ).toThrow(/type-mismatch/);
  });

  it('rebases a local reference under a payload property named like a data keyword (enum)', () => {
    const schema = {
      type: 'object',
      properties: { enum: { $ref: '#/$defs/item' } },
      required: ['enum'],
      additionalProperties: false,
      $defs: {
        item: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
      },
    };
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.enum.id', operator: 'x' }), schema),
    ).not.toThrow();
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.enum.id', operator: { $gt: 1 } }), schema),
    ).toThrow(/type-mismatch/);
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.enum.idd', operator: 'x' }), schema),
    ).toThrow(/unknown-path/);
  });

  it('rebases a local reference under a payload property named like a data keyword (default)', () => {
    const schema = {
      type: 'object',
      properties: { default: { $ref: '#/$defs/item' } },
      required: ['default'],
      additionalProperties: false,
      $defs: {
        item: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
      },
    };
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.default.id', operator: 'x' }), schema),
    ).not.toThrow();
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.default.id', operator: { $gt: 1 } }), schema),
    ).toThrow(/type-mismatch/);
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.default.idd', operator: 'x' }), schema),
    ).toThrow(/unknown-path/);
  });

  // Without the name-table fix, `$defs`'s own loop treats its `const` entry as a data keyword
  // and copies it unrebased: `#/$defs/const` -> `{ $ref: '#/$defs/Item' }`, still pointing above
  // the `payload` wrapper. That inner `$ref` then resolves against the *wrapper* root, which has
  // no top-level `$defs`, so the whole `payload.item` chain goes `open` and neither assertion
  // below would throw. The fix rebases `$defs`'s entries unconditionally, so `#/$defs/const`
  // resolves to a rebased `#/properties/payload/$defs/Item`, keeping the subtree closed.
  it('type-checks a $defs entry named like a data keyword, reached through a property $ref', () => {
    const schema = {
      type: 'object',
      properties: { item: { $ref: '#/$defs/const' } },
      required: ['item'],
      additionalProperties: false,
      $defs: {
        const: { $ref: '#/$defs/Item' },
        Item: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
      },
    };
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.item.idd', operator: 'x' }), schema),
    ).toThrow(/unknown-path/);
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.item.id', operator: { $gt: 1 } }), schema),
    ).toThrow(/type-mismatch/);
  });

  it('preserves a $ref inside a real enum/default value even when another $ref reads it as a schema', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { $ref: '#/properties/b/default' },
        b: { type: 'object', default: { $ref: '#/$defs/Item' } },
      },
      $defs: {
        Item: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
      },
    };
    // `default`'s value is instance data: `rebaseLocalRefs` must leave it, and the `$ref` inside
    // it, untouched. `payload.a`'s own `$ref` points at that untouched value, so the pathological
    // read here still resolves `#/$defs/Item` against the wrapper root, finds no top-level
    // `$defs` there, and stays `open`. If `rebaseLocalRefs` ever rewrote `$ref`s nested inside a
    // `default`/`enum`/`const` value, this inner `$ref` would resolve under `payload` instead,
    // `payload.a` would become the closed `Item` schema, and every assertion below would start
    // throwing.
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.a.id', operator: 'x' }), schema),
    ).not.toThrow();
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.a.idd', operator: 'x' }), schema),
    ).not.toThrow();
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.a.id', operator: { $gt: 1 } }), schema),
    ).not.toThrow();
  });

  it('treats draft-07 dependencies entries as schemas regardless of their name', () => {
    const schema = {
      type: 'object',
      properties: { item: { $ref: '#/dependencies/enum' } },
      required: ['item'],
      additionalProperties: false,
      dependencies: {
        enum: { $ref: '#/definitions/Item' },
      },
      definitions: {
        Item: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
      },
    };
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.item.idd', operator: 'x' }), schema),
    ).toThrow(/unknown-path/);
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.item.id', operator: { $gt: 1 } }), schema),
    ).toThrow(/type-mismatch/);
  });

  it('keeps a __proto__ own key reached through a data-keyword-named property', () => {
    // Built from a JSON string, not an object literal, so `__proto__` lands in the parsed
    // schema as an own key (as it would from storage) rather than being read as the
    // special own-property-shadowing literal syntax.
    const schema = JSON.parse(`{
      "type": "object",
      "properties": {
        "default": {
          "type": "object",
          "properties": { "__proto__": { "type": "string" } },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    }`);
    expect(() =>
      compileWorkflowTriggerCondition(bindingWith({ field: 'payload.default.__proto__', operator: 'x' }), schema),
    ).not.toThrow();
    expect(() =>
      compileWorkflowTriggerCondition(
        bindingWith({ field: 'payload.default.__proto__', operator: { $gt: 1 } }),
        schema,
      ),
    ).toThrow(/type-mismatch/);
  });

  it('still admits an arbitrary payload path on the bus-event trigger schema', () => {
    const schema = zodSchemaToJsonRecord(JsonRecordSchema, 'output');
    const { matches } = compileWorkflowTriggerCondition(bindingWith({ field: 'payload.a.b.c', operator: 1 }), schema);
    expect(matches({ a: { b: { c: 1 } } })).toEqual({ matched: true });
  });
});
