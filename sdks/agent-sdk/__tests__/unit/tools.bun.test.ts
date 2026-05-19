import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod/v3';
import { MakaioBus } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';
import { tool } from '../../src/shared/tools.js';
import { registerSdkToolBridge } from '../../src/shared/tool-bridge.js';

describe('tool()', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    MakaioBus.__resetHandlers?.();
  });

  it('creates a MakaioToolDefinition with name and description', () => {
    const t = tool('search', 'Search files', { pattern: z.string() }, async () => ({ results: [] }));
    expect(t.name).toBe('search');
    expect(t.description).toBe('Search files');
  });

  it('stores the Zod input schema as z.object()', () => {
    const t = tool('search', 'Search', { q: z.string() }, async () => ({}));
    expect(t.inputSchema).toBeDefined();
    expect(t.inputSchema.parse({ q: 'hello' })).toEqual({ q: 'hello' });
  });

  it('rejects invalid input via the schema', () => {
    const t = tool('search', 'Search', { q: z.string() }, async () => ({}));
    expect(() => t.inputSchema.parse({ q: 123 })).toThrow();
  });

  it('stores the handler function', async () => {
    const handler = async ({ q }: { q: string }) => ({ result: q.toUpperCase() });
    const t = tool('upper', 'Uppercase', { q: z.string() }, handler);
    const result = await t.handler({ q: 'hello' });
    expect(result).toEqual({ result: 'HELLO' });
  });

  it('passes through annotations', () => {
    const t = tool('rm', 'Delete', { path: z.string() }, async () => ({}), {
      annotations: { destructive: true },
    });
    expect(t.annotations?.destructive).toBe(true);
  });

  it('defaults annotations to undefined when not provided', () => {
    const t = tool('echo', 'Echo', { text: z.string() }, async ({ text }) => text);
    expect(t.annotations).toBeUndefined();
  });

  it('registerSdkToolBridge exposes SDK tools through tool.list', async () => {
    const cleanup = registerSdkToolBridge({
      bus: MakaioBus,
      sessionId: 'session-tools-1',
      cwd: '/tmp/project',
      env: {},
      tools: [tool('echo', 'Echo text', { text: z.string() }, async ({ text }) => text)],
    });
    cleanups.push(cleanup);

    const result = await MakaioBus.request(ToolSubjects.list, {});

    expect(result.tools).toEqual([
      expect.objectContaining({
        name: 'echo',
        description: 'Echo text',
        toolsetName: 'agent-sdk:session-tools-1',
      }),
    ]);
    expect(result.toolsets).toEqual([
      expect.objectContaining({
        name: 'agent-sdk:session-tools-1',
        toolCount: 1,
      }),
    ]);
  });

  it('registerSdkToolBridge executes SDK tools through tool.execute', async () => {
    const cleanup = registerSdkToolBridge({
      bus: MakaioBus,
      sessionId: 'session-tools-2',
      cwd: '/tmp/project',
      env: { FOO: 'bar' },
      tools: [tool('upper', 'Uppercase', { text: z.string() }, async ({ text }) => text.toUpperCase())],
    });
    cleanups.push(cleanup);

    const result = await MakaioBus.request(ToolSubjects.execute, {
      toolName: 'upper',
      input: { text: 'hello' },
    });

    expect(result).toEqual({ success: true, data: 'HELLO' });
  });

  it('registerSdkToolBridge delegates unknown tool execution to lower-priority handlers', async () => {
    const cleanup = registerSdkToolBridge({
      bus: MakaioBus,
      sessionId: 'session-tools-3',
      cwd: '/tmp/project',
      env: {},
      tools: [tool('known', 'Known', { text: z.string() }, async ({ text }) => text)],
    });
    cleanups.push(cleanup);
    cleanups.push(
      MakaioBus.on(ToolSubjects.execute, (ctx) => {
        ctx.setResult({ success: true, data: `fallback:${ctx.payload.toolName}` });
      }),
    );

    const result = await MakaioBus.request(ToolSubjects.execute, {
      toolName: 'other',
      input: {},
    });

    expect(result).toEqual({ success: true, data: 'fallback:other' });
  });
});
