import { describe, expect, it, vi } from 'vitest';
import type { CanUseTool, HookCallback, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { SessionLifecycle } from '@makaio/ai-adapters-core';
import type { ResponseSchemaDescriptor } from '@makaio/contracts';
import { buildQueryOptions } from '../src/utils/buildQueryOptions.js';
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../src/constants.js';
import { createGateConnector, PRE_TOOL_USE_ID, preToolUseInput } from '../src/test/gate-test-helpers.js';
import type { GateConnectorLists } from '../src/test/gate-test-helpers.js';

/** Structured output descriptor for queries that request one. */
const RESPONSE_SCHEMA: ResponseSchemaDescriptor = {
  schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
};

/** Both per-call gates the SDK receives for one query. */
interface QueryGates {
  /** Run one call through the adapter-owned PreToolUse policy hook; true when not denied. */
  hookAllows(toolName: string, input?: Record<string, unknown>): Promise<boolean>;
  /** Run one call through the connector's real `canUseTool` handler. */
  canUseTool(toolName: string, input?: Record<string, unknown>): Promise<PermissionResult>;
}

/**
 * Build the query options the SDK would receive (real connector `canUseTool` factory,
 * central approval replaced by an allowing spy) and expose both per-call gates.
 * @param lists - Caller tool lists, written with Makaio tool names.
 * @param responseSchema - Structured output descriptor for the query, if any.
 * @returns The query's gates.
 */
async function buildGates(lists: GateConnectorLists, responseSchema?: ResponseSchemaDescriptor): Promise<QueryGates> {
  const centralApproval = vi.fn().mockResolvedValue({ action: 'allow' });
  const { createToolApprovalHandler, buildSessionConfig } = await createGateConnector(lists, centralApproval);
  const options = buildQueryOptions({
    config: buildSessionConfig(),
    lifecycle: new SessionLifecycle(),
    createToolApprovalHandler,
    sessionId: 'session-test',
    ...(responseSchema !== undefined && { responseSchema }),
  });
  const { canUseTool } = options;
  if (canUseTool === undefined) throw new Error('buildQueryOptions produced no canUseTool gate');
  const hooks: HookCallback[] = (options.hooks?.PreToolUse ?? []).flatMap((matcher) => matcher.hooks);
  return {
    async hookAllows(toolName, input = {}) {
      for (const hook of hooks) {
        const output = await hook(preToolUseInput(toolName, input), PRE_TOOL_USE_ID, {
          signal: new AbortController().signal,
        });
        if ('hookSpecificOutput' in output && output.hookSpecificOutput?.hookEventName === 'PreToolUse') {
          if (output.hookSpecificOutput.permissionDecision === 'deny') return false;
        }
      }
      return true;
    },
    canUseTool: (toolName, input = {}) =>
      (canUseTool as CanUseTool)(toolName, input, {
        signal: new AbortController().signal,
        toolUseID: `tool-use-${toolName}`,
      } as Parameters<CanUseTool>[2]),
  };
}

describe('buildQueryOptions — structured output tool under caller tool lists', () => {
  const allowlist: GateConnectorLists = { allowedTools: ['read_file', 'edit_file'] };

  it('allows StructuredOutput in the PreToolUse hook and canUseTool when the query has a responseSchema', async () => {
    const gates = await buildGates(allowlist, RESPONSE_SCHEMA);

    expect(await gates.hookAllows(STRUCTURED_OUTPUT_TOOL_NAME, { summary: 'done' })).toBe(true);
    expect(await gates.canUseTool(STRUCTURED_OUTPUT_TOOL_NAME, { summary: 'done' })).toMatchObject({
      behavior: 'allow',
    });
  });

  it('still denies an unlisted native tool when the query has a responseSchema', async () => {
    const gates = await buildGates(allowlist, RESPONSE_SCHEMA);

    expect(await gates.hookAllows('Bash', { command: 'ls' })).toBe(false);
    expect(await gates.canUseTool('Bash', { command: 'ls' })).toMatchObject({
      behavior: 'deny',
      message: "Tool Bash is not on the step's allowlist",
    });
  });

  it('denies StructuredOutput under an allowlist when the query has no responseSchema', async () => {
    const gates = await buildGates(allowlist);

    expect(await gates.hookAllows(STRUCTURED_OUTPUT_TOOL_NAME)).toBe(false);
    expect(await gates.canUseTool(STRUCTURED_OUTPUT_TOOL_NAME)).toMatchObject({ behavior: 'deny' });
  });

  it('leaves queries without caller tool lists unaffected', async () => {
    for (const responseSchema of [undefined, RESPONSE_SCHEMA]) {
      const gates = await buildGates({}, responseSchema);

      expect(await gates.hookAllows(STRUCTURED_OUTPUT_TOOL_NAME)).toBe(true);
      expect(await gates.canUseTool(STRUCTURED_OUTPUT_TOOL_NAME)).toMatchObject({ behavior: 'allow' });
      expect(await gates.canUseTool('Bash')).toMatchObject({ behavior: 'allow' });
    }
  });
});
