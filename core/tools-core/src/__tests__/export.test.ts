import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../define-tool.js';
import { toMcpTool } from '../export.js';
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
});
