import { describe, expect, it } from 'vitest';
import type { ResponseSchemaDescriptor } from '@makaio/contracts';
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../src/constants.js';
import { createToolListProbe } from '../src/test/tool-list-probe.js';

/** Structured output descriptor for queries that request one. */
const RESPONSE_SCHEMA: ResponseSchemaDescriptor = {
  schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
};

/** The synthetic call the CLI makes to deliver a structured result. */
const STRUCTURED_OUTPUT_CALL = { name: STRUCTURED_OUTPUT_TOOL_NAME, input: { summary: 'done' } };

describe('buildQueryOptions — structured output tool under caller tool lists', () => {
  const allowedTools = ['read_file', 'edit_file'];

  it('admits StructuredOutput under an allowlist when the query has a responseSchema', async () => {
    const probe = await createToolListProbe({ allowedTools, responseSchema: RESPONSE_SCHEMA });

    expect(await probe.gate(STRUCTURED_OUTPUT_CALL)).toMatchObject({ allowed: true });
  });

  it('still denies an unlisted native tool when the query has a responseSchema', async () => {
    const probe = await createToolListProbe({ allowedTools, responseSchema: RESPONSE_SCHEMA });

    expect(await probe.gate(probe.shellCall('ls'))).toMatchObject({ allowed: false, centralApprovalCalled: false });
  });

  it('denies StructuredOutput under an allowlist when the query has no responseSchema', async () => {
    const probe = await createToolListProbe({ allowedTools });

    expect(await probe.gate(STRUCTURED_OUTPUT_CALL)).toMatchObject({ allowed: false, centralApprovalCalled: false });
  });

  it('leaves queries without caller tool lists unaffected', async () => {
    for (const responseSchema of [undefined, RESPONSE_SCHEMA]) {
      const probe = await createToolListProbe(responseSchema === undefined ? {} : { responseSchema });

      expect(await probe.gate(STRUCTURED_OUTPUT_CALL)).toMatchObject({ allowed: true });
      expect(await probe.gate(probe.shellCall('ls'))).toMatchObject({ allowed: true });
    }
  });
});
