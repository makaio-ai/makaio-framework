import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { ensureMcpObjectSchema, toMcpTool } from '../export.js';
import { toolSuccess } from '../errors.js';

describe('toMcpTool', () => {
  it('flattens discriminated union input schemas into an MCP object schema', () => {
    const tool = defineTool({
      name: 'multi_op',
      description: 'Tool with multiple operations',
      inputSchema: z.discriminatedUnion('op', [
        z.object({ op: z.literal('create').describe('Operation'), name: z.string().describe('Name to create') }),
        z.object({ op: z.literal('delete').describe('Operation'), id: z.string().describe('ID to delete') }),
      ]),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => toolSuccess({ ok: true }),
    });

    const schema = toMcpTool(tool).inputSchema as Record<string, unknown>;

    expect(schema.type).toBe('object');
    expect(schema).not.toHaveProperty('oneOf');
    expect(schema).not.toHaveProperty('anyOf');
    expect(schema.required).toEqual(['op']);

    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.op).toEqual({ type: 'string', enum: ['create', 'delete'], description: 'Operation' });
    expect(props.name).toEqual({ type: 'string', description: 'Name to create' });
    expect(props.id).toEqual({ type: 'string', description: 'ID to delete' });
  });

  it('selects the unique const field as discriminator when variants contain other const fields', () => {
    const tool = defineTool({
      name: 'multi_op',
      description: 'Tool with multiple const fields',
      inputSchema: z.discriminatedUnion('op', [
        z.object({
          kind: z.literal('fixed'),
          op: z.literal('create').describe('Operation'),
          name: z.string().describe('Name to create'),
        }),
        z.object({
          kind: z.literal('fixed'),
          op: z.literal('delete').describe('Operation'),
          id: z.string().describe('ID to delete'),
        }),
      ]),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: async () => toolSuccess({ ok: true }),
    });

    const schema = toMcpTool(tool).inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;

    expect(schema.required).toEqual(['op']);
    expect(props.op).toEqual({ type: 'string', enum: ['create', 'delete'], description: 'Operation' });
    expect(props.kind).toEqual({ type: 'string', const: 'fixed' });
  });

  it('preserves discriminator literal types when flattening boolean const values', () => {
    const schema = ensureMcpObjectSchema({
      anyOf: [
        { type: 'object', properties: { success: { type: 'boolean', const: true }, value: { type: 'string' } } },
        { type: 'object', properties: { success: { type: 'boolean', const: false }, error: { type: 'string' } } },
      ],
    }) as Record<string, unknown>;

    const props = schema.properties as Record<string, Record<string, unknown>>;

    expect(schema.required).toEqual(['success']);
    expect(props.success).toEqual({ type: 'boolean', enum: [true, false] });
  });

  it('flattens combinators even when the schema already declares an object root', () => {
    const schema = ensureMcpObjectSchema({
      type: 'object',
      oneOf: [
        { type: 'object', properties: { op: { type: 'string', const: 'create' }, name: { type: 'string' } } },
        { type: 'object', properties: { op: { type: 'string', const: 'delete' }, id: { type: 'string' } } },
      ],
    }) as Record<string, unknown>;

    const props = schema.properties as Record<string, Record<string, unknown>>;

    expect(schema).not.toHaveProperty('oneOf');
    expect(schema.required).toEqual(['op']);
    expect(props.op).toEqual({ type: 'string', enum: ['create', 'delete'] });
    expect(props.name).toEqual({ type: 'string' });
    expect(props.id).toEqual({ type: 'string' });
  });
});
