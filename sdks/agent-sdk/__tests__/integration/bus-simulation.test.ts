/**
 * Bus-simulation integration test.
 *
 * Exercises the full pipeline from bus event emission through the message
 * mapper and push-pull queue to the SDK message yielded by the generator.
 *
 * No provider credentials or live Makaio runtime are required — all transport
 * is in-process via the real {@link MakaioBus} singleton.  This makes these
 * tests fast, deterministic, and safe to run on every CI invocation.
 *
 * These tests complement the focused unit tests in
 * `__tests__/unit/query-generator.test.ts` by exercising richer multi-event
 * sequences and the interaction between the generator, the message mapper,
 * and the bus subscription layer.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import type { AgentComplete, AgentStarted } from '@makaio/contracts';
import { createQueryGenerator } from '../../src/shared/query-generator.js';
import type { ResolvedQueryConfig } from '../../src/shared/options.js';
import type {
  SDKAssistantMessage,
  SDKResultError,
  SDKResultMessage,
  SDKResultSuccess,
  SDKSystemMessage,
  SDKToolResultMessage,
} from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = 'bus-sim-session-1';
const AGENT_ID = 'bus-sim-agent-1';

/** Minimal resolved config for createQueryGenerator. */
const FAKE_CONFIG: ResolvedQueryConfig = {
  parsedModel: { kind: 'bare', model: 'sonnet' },
  rawModel: 'sonnet',
  cwd: '/tmp',
  tools: [],
  persistSession: false,
  ephemeral: true,
};

/** Fields shared across all agent events for this session. */
const BASE_FIELDS = {
  agentId: AGENT_ID,
  adapterId: 'adapter-sim-1',
  adapterName: 'anthropic-sdk',
  adapterSessionId: 'as-sim-1',
  sessionId: SESSION_ID,
  messageId: 'msg-sim-1',
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a query generator wired to the real MakaioBus for this session.
 * @returns Generator instance; caller is responsible for calling close().
 */
const makeGenerator = () =>
  createQueryGenerator({
    bus: MakaioBus,
    sessionId: SESSION_ID,
    agentId: AGENT_ID,
    config: FAKE_CONFIG,
  });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bus simulation — full pipeline (always runs)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    MakaioBus.__resetHandlers?.();
  });

  // -------------------------------------------------------------------------
  // Basic event → SDK message mapping
  // -------------------------------------------------------------------------

  it('agent.started event produces an SDKSystemMessage', async () => {
    const gen = makeGenerator();
    cleanups.push(() => gen.close());

    const pullPromise = gen.next();

    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      model: 'claude-sonnet-4-5',
      cwd: '/workspace',
      startMode: 'fresh',
    } satisfies AgentStarted);

    const result = await pullPromise;

    expect(result.done).toBe(false);
    const msg = result.value as SDKSystemMessage;
    expect(msg.type).toBe('system');
    expect(msg.subtype).toBe('init');
    expect(msg.model).toBe('claude-sonnet-4-5');
    expect(msg.cwd).toBe('/workspace');
    expect(msg.session_id).toBe(SESSION_ID);
  });

  it('agent.message_delta event produces an SDKAssistantMessage with text block', async () => {
    const gen = makeGenerator();
    cleanups.push(() => gen.close());

    const pullPromise = gen.next();

    await MakaioBus.emit(AgentSubjects.message_delta, {
      ...BASE_FIELDS,
      text: 'Hello from the bus!',
    });

    const result = await pullPromise;

    expect(result.done).toBe(false);
    const msg = result.value as SDKAssistantMessage;
    expect(msg.type).toBe('assistant');
    expect(msg.message.role).toBe('assistant');
    expect(msg.message.content).toHaveLength(1);
    expect(msg.message.content[0]).toMatchObject({ type: 'text', text: 'Hello from the bus!' });
    expect(msg.session_id).toBe(SESSION_ID);
  });

  it('agent.tool.use event produces an SDKAssistantMessage with tool_use block', async () => {
    const gen = makeGenerator();
    cleanups.push(() => gen.close());

    const pullPromise = gen.next();

    await MakaioBus.emit(AgentSubjects.tool.use, {
      ...BASE_FIELDS,
      toolName: 'upper',
      toolCallId: 'tc-sim-1',
      args: { text: 'hello' },
    });

    const result = await pullPromise;

    expect(result.done).toBe(false);
    const msg = result.value as SDKAssistantMessage;
    expect(msg.type).toBe('assistant');
    expect(msg.message.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'upper',
      id: 'tc-sim-1',
      input: { text: 'hello' },
    });
  });

  it('agent.tool.output event produces an SDKToolResultMessage', async () => {
    const gen = makeGenerator();
    cleanups.push(() => gen.close());

    const pullPromise = gen.next();

    await MakaioBus.emit(AgentSubjects.tool.output, {
      ...BASE_FIELDS,
      toolCallId: 'tc-sim-1',
      toolName: 'upper',
      output: 'HELLO',
    });

    const result = await pullPromise;

    expect(result.done).toBe(false);
    const msg = result.value as SDKToolResultMessage;
    expect(msg.type).toBe('tool_result');
    expect(msg.tool_use_id).toBe('tc-sim-1');
    expect(msg.content).toBe('HELLO');
    expect(msg.is_error).toBe(false);
    expect(msg.session_id).toBe(SESSION_ID);
  });

  it('agent.complete event produces an SDKResultMessage and closes the generator', async () => {
    const gen = makeGenerator();
    cleanups.push(() => gen.close());

    const pullPromise = gen.next();

    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE_FIELDS,
      message: 'Task complete.',
      outcome: 'completed',
    } satisfies AgentComplete);

    const result = await pullPromise;

    expect(result.done).toBe(false);
    const msg = result.value as SDKResultMessage;
    expect(msg.type).toBe('result');
    expect(msg.subtype).toBe('success');
    expect(msg.is_error).toBe(false);
    expect((msg as SDKResultSuccess).result).toBe('Task complete.');
    expect(msg.session_id).toBe(SESSION_ID);

    // The next pull must mark the generator as done.
    const done = await gen.next();
    expect(done.done).toBe(true);
    expect(done.value).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Multi-event sequence: full simulated query turn
  // -------------------------------------------------------------------------

  it('yields a complete SDK message sequence in emission order', async () => {
    const gen = makeGenerator();
    cleanups.push(() => gen.close());

    // Emit all events before pulling — tests the queue is properly ordered.
    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      model: 'claude-sonnet-4-5',
      cwd: '/tmp',
      startMode: 'fresh',
    } satisfies AgentStarted);

    await MakaioBus.emit(AgentSubjects.message_delta, { ...BASE_FIELDS, text: 'chunk one ' });

    await MakaioBus.emit(AgentSubjects.tool.use, {
      ...BASE_FIELDS,
      toolName: 'upper',
      toolCallId: 'tc-seq-1',
      args: { text: 'hello' },
    });

    await MakaioBus.emit(AgentSubjects.tool.output, {
      ...BASE_FIELDS,
      toolCallId: 'tc-seq-1',
      toolName: 'upper',
      output: 'HELLO',
    });

    await MakaioBus.emit(AgentSubjects.message_delta, { ...BASE_FIELDS, text: 'chunk two' });

    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE_FIELDS,
      message: 'All done.',
      outcome: 'completed',
    } satisfies AgentComplete);

    // Now pull all yielded messages.
    // Events: started, message_delta, tool.use, tool.output, message_delta, complete
    // → 5 messages + result message + generator done
    const first = await gen.next();
    const second = await gen.next();
    const third = await gen.next();
    const fourth = await gen.next();
    const fifth = await gen.next();
    const sixth = await gen.next();
    const done = await gen.next();

    expect(first.value).toMatchObject({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-5' });
    expect(second.value).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'chunk one ' }] },
    });
    expect(third.value).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'upper' }] },
    });
    expect(fourth.value).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tc-seq-1',
      content: 'HELLO',
    });
    expect(fifth.value).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'chunk two' }] },
    });
    expect(sixth.value).toMatchObject({ type: 'result', subtype: 'success', result: 'All done.' });
    expect(sixth.done).toBe(false);
    expect(done.done).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Session isolation
  // -------------------------------------------------------------------------

  it('two generators subscribed to different sessions do not cross-contaminate', async () => {
    const SESSION_B = 'bus-sim-session-b';
    const AGENT_B = 'bus-sim-agent-b';

    const genA = makeGenerator();
    const genB = createQueryGenerator({
      bus: MakaioBus,
      sessionId: SESSION_B,
      agentId: AGENT_B,
      config: FAKE_CONFIG,
    });
    cleanups.push(
      () => genA.close(),
      () => genB.close(),
    );

    const pullA = genA.next();
    const pullB = genB.next();

    // Emit for session B first, then for session A.
    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      sessionId: SESSION_B,
      agentId: AGENT_B,
      model: 'model-b',
      cwd: '/b',
      startMode: 'fresh',
    } satisfies AgentStarted);

    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      model: 'model-a',
      cwd: '/a',
      startMode: 'fresh',
    } satisfies AgentStarted);

    const resA = await pullA;
    const resB = await pullB;

    // Each generator must receive exactly its session's event.
    expect((resA.value as SDKSystemMessage).model).toBe('model-a');
    expect((resB.value as SDKSystemMessage).model).toBe('model-b');
  });

  // -------------------------------------------------------------------------
  // Error outcome
  // -------------------------------------------------------------------------

  it('agent.complete with outcome=error produces an SDKResultMessage with subtype error', async () => {
    const gen = makeGenerator();
    cleanups.push(() => gen.close());

    const pullPromise = gen.next();

    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE_FIELDS,
      outcome: 'error',
      error: 'Rate limit exceeded',
    } satisfies AgentComplete);

    const result = await pullPromise;

    const msg = result.value as SDKResultMessage;
    expect(msg.type).toBe('result');
    expect(msg.subtype).toBe('error_during_execution');
    expect(msg.is_error).toBe(true);
    expect((msg as SDKResultError).errors[0]).toBe('Rate limit exceeded');
  });

  // -------------------------------------------------------------------------
  // Generator close() unsubscribes from subsequent events
  // -------------------------------------------------------------------------

  it('events emitted after close() are not buffered or yielded', async () => {
    const gen = makeGenerator();

    gen.close();

    // Emit after close — the generator must be silent.
    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE_FIELDS,
      model: 'ghost-model',
      cwd: '/ghost',
      startMode: 'fresh',
    } satisfies AgentStarted);

    const result = await gen.next();
    expect(result.done).toBe(true);
    expect(result.value).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Usage accumulation feeds into result message
  // -------------------------------------------------------------------------

  it('accumulated usage tokens appear on the result message', async () => {
    const gen = makeGenerator();
    cleanups.push(() => gen.close());

    // Emit usage events before the complete.
    await MakaioBus.emit(AgentSubjects.usage, {
      ...BASE_FIELDS,
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 120,
      outputTokens: 60,
      inputCachedTokens: 20,
      cacheWriteTokens: 5,
      totalTokens: 180,
      reasoningTokens: 0,
      costUnits: 1,
      costUnitType: 'tokens',
      cost: 0.0015,
    });

    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE_FIELDS,
      message: 'Done.',
      outcome: 'completed',
    } satisfies AgentComplete);

    const result = await gen.next();
    const msg = result.value as SDKResultMessage;

    expect(msg.type).toBe('result');
    expect(msg.usage.input_tokens).toBe(120);
    expect(msg.usage.output_tokens).toBe(60);
    expect(msg.usage.cache_read_input_tokens).toBe(20);
    expect(msg.usage.cache_creation_input_tokens).toBe(5);
    expect(msg.total_cost_usd).toBeCloseTo(0.0015);
  });
});
