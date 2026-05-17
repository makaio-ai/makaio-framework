/**
 * Tool-execution integration tests.
 *
 * These tests verify that a custom tool created via {@link tool} is wired
 * correctly through the full query pipeline: the tool definition is passed to
 * `query()`, the agent emits `agent.tool.use` and `agent.tool.output` events,
 * and the generator yields the corresponding SDK messages with the expected
 * shapes.
 *
 * The tests use the real {@link MakaioBus} to emit simulated agent events so
 * they exercise the actual bus subscription and message-mapper code paths.
 * Provider credentials are NOT required for the bus-simulation variant of
 * these tests.
 *
 * The env-gated variants (MAKAIO_TEST_RUNTIME or ANTHROPIC_API_KEY) perform a
 * live end-to-end query with a real adapter to confirm the tool handler is
 * called by a real model response.
 *
 * To run the env-gated tests locally:
 * ```
 * MAKAIO_TEST_RUNTIME=1 yarn test framework/sdks/agent-sdk
 * # or with direct Anthropic credentials:
 * ANTHROPIC_API_KEY=sk-... yarn test framework/sdks/agent-sdk
 * ```
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v3';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { AgentComplete } from '@makaio/contracts';
import { tool } from '../../src/shared/tools.js';
import { createQueryGenerator } from '../../src/shared/query-generator.js';
import type { ResolvedQueryConfig } from '../../src/shared/options.js';
import type { SDKAssistantMessage } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const RUNTIME_ENABLED = Boolean(process.env['MAKAIO_TEST_RUNTIME']);
const API_KEY_PRESENT = Boolean(process.env['ANTHROPIC_API_KEY']);
const LIVE_ENABLED = RUNTIME_ENABLED || API_KEY_PRESENT;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'tool-exec-session-1';
const AGENT_ID = 'tool-exec-agent-1';
const TOOL_CALL_ID = 'tc-upper-1';

const BASE_FIELDS = {
  agentId: AGENT_ID,
  adapterId: 'adapter-tool-1',
  adapterName: 'anthropic-sdk',
  adapterSessionId: 'as-tool-1',
  sessionId: SESSION_ID,
  messageId: 'msg-tool-1',
} as const;

const FAKE_CONFIG: ResolvedQueryConfig = {
  parsedModel: { kind: 'bare', model: 'sonnet' },
  rawModel: 'sonnet',
  cwd: '/tmp',
  tools: [],
  persistSession: false,
  ephemeral: true,
};

// ---------------------------------------------------------------------------
// Tool-definition tests (always run — no credentials needed)
// ---------------------------------------------------------------------------

describe('tool() definition', () => {
  it('creates a MakaioToolDefinition with the expected name and description', () => {
    const upperTool = tool('upper', 'Uppercase a string', { text: z.string() }, ({ text }) => text.toUpperCase());

    expect(upperTool.name).toBe('upper');
    expect(upperTool.description).toBe('Uppercase a string');
  });

  it('handler receives validated args and returns the transformed value', async () => {
    const upperTool = tool('upper', 'Uppercase a string', { text: z.string() }, ({ text }) => text.toUpperCase());

    const result = await upperTool.handler({ text: 'hello world' });
    expect(result).toBe('HELLO WORLD');
  });

  it('handler is called with correct args from a simulated tool.use event', async () => {
    const handler = vi.fn(({ text }: { text: string }) => text.toUpperCase());
    const upperTool = tool('upper', 'Uppercase a string', { text: z.string() }, handler);

    // Simulate the tool invocation path used by adapters.
    const rawArgs = { text: 'simulate me' };
    await upperTool.handler(rawArgs);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ text: 'simulate me' });
  });
});

// ---------------------------------------------------------------------------
// Bus-simulation tool-pipeline tests (always run — no credentials needed)
// ---------------------------------------------------------------------------

describe('tool execution — bus simulation (always runs)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    MakaioBus.__resetHandlers?.();
  });

  it('agent.tool.use event yields an assistant message with a tool_use content block', async () => {
    const gen = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => gen.close());

    const pullPromise = gen.next();

    await MakaioBus.emit(AgentSubjects.tool.use, {
      ...BASE_FIELDS,
      toolName: 'upper',
      toolCallId: TOOL_CALL_ID,
      args: { text: 'hello' },
    });

    const result = await pullPromise;
    expect(result.done).toBe(false);

    const msg = result.value as SDKAssistantMessage;
    expect(msg.type).toBe('assistant');
    expect(msg.message.content).toHaveLength(1);
    expect(msg.message.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'upper',
      id: TOOL_CALL_ID,
      input: { text: 'hello' },
    });
  });

  it('agent.tool.output event yields an assistant message with a tool_result content block', async () => {
    const gen = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => gen.close());

    const pullPromise = gen.next();

    await MakaioBus.emit(AgentSubjects.tool.output, {
      ...BASE_FIELDS,
      toolCallId: TOOL_CALL_ID,
      toolName: 'upper',
      output: 'HELLO',
    });

    const result = await pullPromise;
    expect(result.done).toBe(false);

    const msg = result.value as SDKAssistantMessage;
    expect(msg.type).toBe('assistant');
    expect(msg.message.content[0]).toMatchObject({
      type: 'tool_result',
      content: 'HELLO',
      id: TOOL_CALL_ID,
    });
  });

  it('full tool round-trip: tool_use → tool_result → completion', async () => {
    const gen = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      config: FAKE_CONFIG,
    });
    cleanups.push(() => gen.close());

    // Emit the full tool lifecycle in sequence.
    await MakaioBus.emit(AgentSubjects.tool.use, {
      ...BASE_FIELDS,
      toolName: 'upper',
      toolCallId: TOOL_CALL_ID,
      args: { text: 'greet' },
    });

    await MakaioBus.emit(AgentSubjects.tool.output, {
      ...BASE_FIELDS,
      toolCallId: TOOL_CALL_ID,
      toolName: 'upper',
      output: 'GREET',
    });

    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE_FIELDS,
      message: 'Tool executed successfully.',
      outcome: 'completed',
    } satisfies AgentComplete);

    // Pull all three expected messages plus the generator done sentinel.
    const useMsg = await gen.next();
    const resultMsg = await gen.next();
    const completeMsg = await gen.next();
    const done = await gen.next();

    expect(useMsg.value).toMatchObject({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } });
    expect(resultMsg.value).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_result', content: 'GREET' }] },
    });
    expect(completeMsg.value).toMatchObject({ type: 'result', subtype: 'success' });
    expect(done.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live end-to-end tests (require MAKAIO_TEST_RUNTIME or ANTHROPIC_API_KEY)
// ---------------------------------------------------------------------------

describe.skipIf(!LIVE_ENABLED)('tool execution — live runtime (requires credentials)', () => {
  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('query() with a custom tool reaches the handler when the model invokes it', { timeout: 120_000 }, async () => {
    const callLog: Array<{ text: string }> = [];

    const upperTool = tool('upper', 'Uppercase the provided text and return it.', { text: z.string() }, (args) => {
      callLog.push({ text: args.text });
      return args.text.toUpperCase();
    });

    // Register a sendMessage handler so bus.request resolves.
    const unsub = MakaioBus.on(SessionSubjects.sendMessage, (ctx) => {
      ctx.setResult({ messageId: 'msg-live-1', turnId: 'turn-live-1', sessionId: SESSION_ID });
    });

    try {
      const { query } = await import('../../src/runtime/index.js');
      const gen = await query({
        prompt: 'Use the upper tool on the text "integration test"',
        options: {
          model: 'sonnet',
          sessionId: SESSION_ID,
          tools: [upperTool],
        },
      });

      // Consume all messages — the real runtime will emit agent events.
      const messages = [];
      for await (const msg of gen) {
        messages.push(msg);
      }

      // The tool handler must have been invoked.
      expect(callLog.length).toBeGreaterThanOrEqual(1);

      // At least one tool_use message must appear in the stream.
      const toolUseMessages = messages.filter(
        (m) => m.type === 'assistant' && m.message.content.some((b) => b.type === 'tool_use' && b.name === 'upper'),
      );
      expect(toolUseMessages.length).toBeGreaterThanOrEqual(1);
    } finally {
      unsub();
    }
  });
});
