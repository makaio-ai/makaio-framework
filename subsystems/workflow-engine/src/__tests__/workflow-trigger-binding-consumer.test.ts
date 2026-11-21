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

  it('still admits an arbitrary payload path on the bus-event trigger schema', () => {
    const schema = zodSchemaToJsonRecord(JsonRecordSchema, 'output');
    const { matches } = compileWorkflowTriggerCondition(bindingWith({ field: 'payload.a.b.c', operator: 1 }), schema);
    expect(matches({ a: { b: { c: 1 } } })).toEqual({ matched: true });
  });
});
