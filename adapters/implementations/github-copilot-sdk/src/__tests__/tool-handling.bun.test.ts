/**
 * Tests for GitHub Copilot SDK tool-handling utilities.
 *
 * Tests cover:
 * - `toCopilotToolFormat`: schema filtering, field mapping, handler approval gate,
 *   success/denial/abort result shapes
 * - `fetchToolsForCopilot`: empty-array fallback when registry is unavailable
 *
 * Strategy: All I/O goes through the real MakaioBus so we test the actual
 * integration path rather than mocked internals. Bus handlers are registered
 * per test via `afterEach` cleanups and cleared via `MakaioBus.__resetHandlers`.
 *
 * Vitest runs tests within a single file sequentially by default, so the
 * shared `MakaioBus.__resetHandlers()` cleanup is safe without
 * `describe.sequential()` (which only applies under `describe.concurrent()`).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, ToolSubjects, type ToolListItem } from '@makaio/contracts';
import type { ToolInvocation } from '@github/copilot-sdk';
import { toCopilotToolFormat, fetchToolsForCopilot } from '../tool-handling.js';
import type { CopilotToolHandlerContext } from '../tool-handling.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<CopilotToolHandlerContext> = {}): CopilotToolHandlerContext {
  return {
    adapterId: 'adapter-1',
    adapterName: 'github-copilot-sdk',
    agentId: 'agent-1',
    ...overrides,
  };
}

function makeInvocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    sessionId: 'session-abc',
    toolCallId: 'call-1',
    toolName: 'search_repo',
    arguments: {},
    ...overrides,
  };
}

function makeToolListItem(overrides: Partial<ToolListItem> = {}): ToolListItem {
  return {
    name: 'search_repo',
    description: 'Search the repository for code.',
    toolsetName: 'registry',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    ...overrides,
  };
}

/** Allow approval response — execution proceeds with original args. */
function allowApproval() {
  return MakaioBus.on(AgentSubjects.toolApprove, (ctx) => {
    ctx.setResult({ action: 'allow' });
  });
}

/**
 * Deny approval response — soft denial without abort.
 * @param message - Denial message returned in the response
 */
function denyApproval(message = 'Denied by test.') {
  return MakaioBus.on(AgentSubjects.toolApprove, (ctx) => {
    ctx.setResult({ action: 'deny', message, shouldAbort: false });
  });
}

/**
 * Deny approval response — abort turn signal.
 * @param message - Denial message returned in the response
 */
function abortApproval(message = 'Aborted by test.') {
  return MakaioBus.on(AgentSubjects.toolApprove, (ctx) => {
    ctx.setResult({ action: 'deny', message, shouldAbort: true });
  });
}

/**
 * Successful execution response returning a plain string.
 * @param output - String to return as the tool result data
 */
function succeedExecution(output: string) {
  return MakaioBus.on(ToolSubjects.execute, (ctx) => {
    ctx.setResult({ success: true, data: output });
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('toCopilotToolFormat', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    MakaioBus.__resetHandlers?.();
  });

  // -------------------------------------------------------------------------
  // Conversion logic
  // -------------------------------------------------------------------------

  describe('conversion', () => {
    it('filters out tools that have no inputSchema', () => {
      const tools: ToolListItem[] = [
        makeToolListItem({ name: 'with_schema' }),
        makeToolListItem({ name: 'no_schema', inputSchema: undefined }),
      ];

      const result = toCopilotToolFormat(tools, makeContext());

      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe('with_schema');
    });

    it('maps name, description, and inputSchema to SDK fields', () => {
      const schema = {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      };
      const tool = makeToolListItem({
        name: 'search_repo',
        description: 'Search the repository.',
        inputSchema: schema,
      });

      const [converted] = toCopilotToolFormat([tool], makeContext());

      expect(converted).toMatchObject({
        name: 'search_repo',
        description: 'Search the repository.',
        parameters: schema,
      });
    });

    it('returns an empty array when all tools lack inputSchema', () => {
      const tools: ToolListItem[] = [makeToolListItem({ inputSchema: undefined })];

      expect(toCopilotToolFormat(tools, makeContext())).toEqual([]);
    });

    it('returns an empty array when given an empty tool list', () => {
      expect(toCopilotToolFormat([], makeContext())).toEqual([]);
    });

    it('exposes a handler function on each converted tool', () => {
      const [converted] = toCopilotToolFormat([makeToolListItem()], makeContext());

      expect(typeof converted!.handler).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // Handler: approval gate
  // -------------------------------------------------------------------------

  describe('handler — approval gate', () => {
    it('requests approval before executing the tool', async () => {
      const events: string[] = [];

      cleanups.push(
        MakaioBus.on(AgentSubjects.toolApprove, (ctx) => {
          events.push('approve');
          ctx.setResult({ action: 'allow' });
        }),
      );
      cleanups.push(
        MakaioBus.on(ToolSubjects.execute, (ctx) => {
          events.push('execute');
          ctx.setResult({ success: true, data: 'ok' });
        }),
      );

      const [converted] = toCopilotToolFormat([makeToolListItem()], makeContext());
      await converted!.handler!({}, makeInvocation());

      expect(events).toEqual(['approve', 'execute']);
    });

    it('forwards invocation sessionId in the approval payload', async () => {
      let capturedSessionId: string | undefined;

      cleanups.push(
        MakaioBus.on(AgentSubjects.toolApprove, (ctx) => {
          capturedSessionId = ctx.payload.sessionId;
          ctx.setResult({ action: 'allow' });
        }),
      );
      cleanups.push(succeedExecution('ok'));

      const [converted] = toCopilotToolFormat([makeToolListItem()], makeContext());
      await converted!.handler!({}, makeInvocation({ sessionId: 'session-xyz' }));

      expect(capturedSessionId).toBe('session-xyz');
    });
  });

  // -------------------------------------------------------------------------
  // Handler: successful execution
  // -------------------------------------------------------------------------

  describe('handler — success', () => {
    it('returns the tool output as a string when execution succeeds', async () => {
      cleanups.push(allowApproval());
      cleanups.push(succeedExecution('{"results":[]}'));

      const [converted] = toCopilotToolFormat([makeToolListItem()], makeContext());
      const result = await converted!.handler!({ query: 'hello' }, makeInvocation());

      expect(result).toBe('{"results":[]}');
    });

    it('JSON-serialises non-string data returned by the tool', async () => {
      cleanups.push(allowApproval());
      cleanups.push(
        MakaioBus.on(ToolSubjects.execute, (ctx) => {
          ctx.setResult({ success: true, data: { count: 3, items: ['a', 'b', 'c'] } });
        }),
      );

      const [converted] = toCopilotToolFormat([makeToolListItem()], makeContext());
      const result = await converted!.handler!({}, makeInvocation());

      expect(JSON.parse(result as string)).toEqual({ count: 3, items: ['a', 'b', 'c'] });
    });

    it('uses updated args from the approval response when provided', async () => {
      let capturedInput: Record<string, unknown> | undefined;

      cleanups.push(
        MakaioBus.on(AgentSubjects.toolApprove, (ctx) => {
          ctx.setResult({ action: 'allow', updatedInput: { query: 'updated-query' } });
        }),
      );
      cleanups.push(
        MakaioBus.on(ToolSubjects.execute, (ctx) => {
          capturedInput = ctx.payload.input as Record<string, unknown>;
          ctx.setResult({ success: true, data: 'done' });
        }),
      );

      const [converted] = toCopilotToolFormat([makeToolListItem()], makeContext());
      await converted!.handler!({ query: 'original-query' }, makeInvocation());

      expect(capturedInput).toEqual({ query: 'updated-query' });
    });

    it('returns error JSON when the tool execution result has success=false', async () => {
      cleanups.push(allowApproval());
      cleanups.push(
        MakaioBus.on(ToolSubjects.execute, (ctx) => {
          ctx.setResult({
            success: false,
            error: { code: 'TOOL_FAILED', message: 'Something went wrong.' },
          });
        }),
      );

      const [converted] = toCopilotToolFormat([makeToolListItem()], makeContext());
      const result = await converted!.handler!({}, makeInvocation());

      const parsed = JSON.parse(result as string);
      expect(parsed).toMatchObject({ error: 'Something went wrong.', code: 'TOOL_FAILED' });
    });
  });

  // -------------------------------------------------------------------------
  // Handler: denial
  // -------------------------------------------------------------------------

  describe('handler — denial (soft deny)', () => {
    it('returns error JSON and does not execute the tool when denied', async () => {
      let executionCalled = false;

      cleanups.push(denyApproval('Not allowed.'));
      cleanups.push(
        MakaioBus.on(ToolSubjects.execute, (ctx) => {
          executionCalled = true;
          ctx.setResult({ success: true, data: 'should not reach' });
        }),
      );

      const [converted] = toCopilotToolFormat([makeToolListItem()], makeContext());
      const result = await converted!.handler!({}, makeInvocation());

      expect(executionCalled).toBe(false);
      const parsed = JSON.parse(result as string);
      expect(parsed).toMatchObject({ error: 'Not allowed.' });
      expect(parsed.shouldAbort).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Handler: abort denial
  // -------------------------------------------------------------------------

  describe('handler — denial with shouldAbort', () => {
    it('returns shouldAbort:true in the JSON when approval is denied with abort', async () => {
      let executionCalled = false;

      cleanups.push(abortApproval('Turn aborted.'));
      cleanups.push(
        MakaioBus.on(ToolSubjects.execute, (ctx) => {
          executionCalled = true;
          ctx.setResult({ success: true, data: 'should not reach' });
        }),
      );

      const [converted] = toCopilotToolFormat([makeToolListItem()], makeContext());
      const result = await converted!.handler!({}, makeInvocation());

      expect(executionCalled).toBe(false);
      const parsed = JSON.parse(result as string);
      expect(parsed).toMatchObject({ error: 'Turn aborted.', shouldAbort: true });
    });
  });

  // -------------------------------------------------------------------------
  // Handler: approval bus error
  // -------------------------------------------------------------------------

  describe('handler — approval failure', () => {
    it('returns error JSON without throwing when the approval bus handler throws', async () => {
      let executionCalled = false;

      cleanups.push(
        MakaioBus.on(AgentSubjects.toolApprove, () => {
          throw new Error('Approval bus failure.');
        }),
      );
      cleanups.push(
        MakaioBus.on(ToolSubjects.execute, (ctx) => {
          executionCalled = true;
          ctx.setResult({ success: true, data: 'should not reach' });
        }),
      );

      const [converted] = toCopilotToolFormat([makeToolListItem()], makeContext());

      // Must not throw — the handler always returns a string.
      await expect(converted!.handler!({}, makeInvocation())).resolves.toEqual(
        expect.stringContaining('Approval bus failure.'),
      );
      expect(executionCalled).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// fetchToolsForCopilot
// ---------------------------------------------------------------------------

describe('fetchToolsForCopilot', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    MakaioBus.__resetHandlers?.();
  });

  it('returns an empty array when the registry bus handler is not registered', async () => {
    // No ToolSubjects.list handler — loadToolsFromRegistry catches and returns [].
    const result = await fetchToolsForCopilot(makeContext());

    expect(result).toEqual([]);
  });

  it('converts tools loaded from the registry to SDK format', async () => {
    cleanups.push(
      MakaioBus.on(ToolSubjects.list, (ctx) => {
        ctx.setResult({
          tools: [
            {
              name: 'list_files',
              description: 'List files in a directory.',
              toolsetName: 'registry',
              inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
            },
          ],
          toolsets: [],
        });
      }),
    );

    const result = await fetchToolsForCopilot(makeContext());

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'list_files',
      description: 'List files in a directory.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    });
    expect(typeof result[0]!.handler).toBe('function');
  });

  it('filters out registry tools without inputSchema', async () => {
    cleanups.push(
      MakaioBus.on(ToolSubjects.list, (ctx) => {
        ctx.setResult({
          tools: [
            {
              name: 'no_schema_tool',
              description: 'No schema.',
              toolsetName: 'registry',
            },
          ],
          toolsets: [],
        });
      }),
    );

    const result = await fetchToolsForCopilot(makeContext());

    expect(result).toEqual([]);
  });
});
