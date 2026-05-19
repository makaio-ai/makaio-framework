/**
 * Conformance tests for the `\@makaio/sdk` TypeScript bus protocol client.
 *
 * Verifies the wire-protocol, local-dispatch, and auth behaviors defined in
 * `sdks/conformance/cases.json` against the fixture messages in
 * `sdks/conformance/fixtures/messages.json`.
 *
 * Testing strategy: `WebSocketClientTransport` accepts a `createWebSocket`
 * factory, allowing injection of a `FakeWebSocket` that captures outbound
 * frames and allows server-side frames to be pushed in. Tests exercise the
 * `BusClient` facade end-to-end while using fake sockets for deterministic
 * wire-level assertions, so subscribe/unsubscribe, correlation, and reconnect
 * paths participate without requiring pre-registered typed subject definitions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocketLike, WebSocketCloseEvent } from '@makaio/bus-transport-websocket';
import type { SubjectDefinition } from '@makaio/core';
import { ApprovalSubjects, BusClient, AgentSubjects, ToolSubjects } from '../src/index.js';

// ---------------------------------------------------------------------------
// Conformance fixture loading
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFORMANCE_DIR = resolve(__dirname, '../../conformance');

/** Shape of a single wire entry in a conformance case. */
interface ConformanceWireEntry {
  direction: 'client->server' | 'server->client';
  messageRef: string;
  phase?: string;
}

/** Shape of a single assertion in a conformance case. */
interface ConformanceAssertion {
  kind: string;
  targets?: string[];
  subject?: string;
  pattern?: string;
  correlationId?: string;
  code?: string;
  priorities?: number[];
  messages?: string[];
  messageRef?: string;
}

/** Shape of a single conformance test case. */
interface ConformanceCase {
  id: string;
  title: string;
  description: string;
  wire: ConformanceWireEntry[];
  assertions: ConformanceAssertion[];
}

interface ConformanceCasesFile {
  version: number;
  protocol: string;
  fixtures: string;
  cases: ConformanceCase[];
}

interface ConformanceFixtures {
  version: number;
  messages: Record<string, Record<string, unknown>>;
}

function loadCases(): ConformanceCase[] {
  const raw = readFileSync(resolve(CONFORMANCE_DIR, 'cases.json'), 'utf-8');
  return (JSON.parse(raw) as ConformanceCasesFile).cases;
}

function loadMessages(): Record<string, Record<string, unknown>> {
  const raw = readFileSync(resolve(CONFORMANCE_DIR, 'fixtures/messages.json'), 'utf-8');
  return (JSON.parse(raw) as ConformanceFixtures).messages;
}

const CASES = loadCases();
const MESSAGES = loadMessages();
const CONFORMANCE_CASE_DECISIONS = {
  'auth-challenge-response': 'covered',
  'event-delivery-agent-complete': 'covered',
  'request-response-correlation-approval-request': 'covered',
  'no-handler-response-tool-execute': 'covered',
  'subscribe-replace-and-unsubscribe-approval-request': 'covered',
  'wildcard-subscriptions-agent-wildcard': 'covered',
  'reconnect-subscription-replay': 'covered',
  'heartbeat-handling': 'covered',
  'broadcast-response-tool-execute': 'covered',
  'local-event-parallel-dispatch': 'covered',
  'local-request-dispatch': 'covered',
  'local-request-priority-chain': 'covered',
  'local-wildcard-event-matching': 'covered',
} as const satisfies Record<string, 'covered'>;

// Auth secret used by the auth-challenge-response conformance fixture.
const AUTH_CONFORMANCE_SECRET = 'conformance-secret';

/**
 * Look up a conformance message by its fixture key.
 * @param ref - Message reference key from `fixtures/messages.json`
 * @returns The fixture message object
 */
function msg(ref: string): Record<string, unknown> {
  const m = MESSAGES[ref];
  if (!m) throw new Error(`Unknown fixture message ref: ${ref}`);
  return m;
}

/**
 * Look up a conformance case by ID.
 * @param id - Case identifier from `cases.json`
 * @returns The conformance case definition
 */
function conformanceCase(id: string): ConformanceCase {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown conformance case: ${id}`);
  return c;
}

/**
 * Build an SDK-facing event subject for conformance-only subjects that are not
 * part of the framework contracts package.
 * @param namespace - Bus namespace.
 * @param subject - Subject key within the namespace.
 * @param options - Subject metadata overrides.
 * @returns Subject definition accepted by the BusClient facade.
 */
function eventSubject(namespace: string, subject: string, options?: { local?: boolean }): SubjectDefinition {
  return {
    subject,
    $meta: {
      namespace,
      isRequest: false,
      local: options?.local ?? false,
      channel: false,
      payload: {},
    },
  };
}

/**
 * Build an SDK-facing request subject for conformance-only subjects that are
 * not part of the framework contracts package.
 * @param namespace - Bus namespace.
 * @param subject - Subject key within the namespace.
 * @param options - Subject metadata overrides.
 * @returns Subject definition accepted by the BusClient facade.
 */
function requestSubject(namespace: string, subject: string, options?: { local?: boolean }): SubjectDefinition {
  return {
    subject,
    $meta: {
      namespace,
      isRequest: true,
      local: options?.local ?? false,
      channel: false,
      payload: {
        request: {},
        response: {},
      },
    },
  };
}

// ---------------------------------------------------------------------------
// FakeWebSocket
// ---------------------------------------------------------------------------

/** Event type map for the fake WebSocket event listeners. */
interface FakeWebSocketEventMap {
  message: MessageEvent;
  error: Event;
  close: WebSocketCloseEvent;
  open: Event;
}

/**
 * In-process fake WebSocket that captures outbound frames and allows
 * server-side frames to be pushed to the client without network I/O.
 *
 * Mirrors the pattern used in the Python `FakeWebSocket` and the existing
 * `MockWebSocket` in `transports/ws/src/__tests__/test-helpers.ts`.
 */
class FakeWebSocket implements WebSocketLike {
  /** Captured outbound JSON frames (subscribe, request, event, etc.). */
  public sent: Array<Record<string, unknown>> = [];

  /** `readyState` 1 = OPEN, 3 = CLOSED (matches the WebSocket spec). */
  public readyState: number = 1;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  // ---- WebSocketLike interface ----

  send(data: string | BufferSource | Blob): void {
    if (this.readyState !== 1) throw new Error('FakeWebSocket is not open');
    const str = typeof data === 'string' ? data : '[binary]';
    // subscribe-sync-complete is a transport-internal handshake — exclude from
    // the recorded frame list so count assertions are not affected.
    if (!str.includes('"subscribe-sync-complete"')) {
      this.sent.push(JSON.parse(str) as Record<string, unknown>);
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    const evt = new Event('close') as Event & { code: number; reason: string };
    Object.defineProperties(evt, {
      code: { value: code ?? 1000, enumerable: true },
      reason: { value: reason ?? '', enumerable: true },
    });
    this.emit('close', evt);
  }

  addEventListener<K extends keyof FakeWebSocketEventMap>(
    event: K,
    listener: (event: FakeWebSocketEventMap[K]) => void,
  ): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as (event: unknown) => void);
  }

  removeEventListener<K extends keyof FakeWebSocketEventMap>(
    event: K,
    listener: (event: FakeWebSocketEventMap[K]) => void,
  ): void {
    this.listeners.get(event)?.delete(listener as (event: unknown) => void);
  }

  // ---- Test helpers ----

  /**
   * Push a fixture message object as an inbound server frame.
   * @param message - Message object to JSON-encode and inject
   */
  receiveMessage(message: Record<string, unknown>): void {
    this.emit('message', { data: JSON.stringify(message) } as MessageEvent);
  }

  /**
   * Report whether at least one listener is registered for the given event.
   * @param event - Event name to inspect
   * @returns `true` when the fake has a listener for the event
   */
  hasListener(event: keyof FakeWebSocketEventMap): boolean {
    return (this.listeners.get(event)?.size ?? 0) > 0;
  }

  /**
   * Wait until at least `count` outbound frames have been captured, then
   * return the frame at index `count - 1`.
   * @param count - Minimum number of outbound frames to await
   * @param timeoutMs - Maximum wait time in milliseconds
   * @returns The `count`-th outbound frame
   */
  async waitSent(count: number, timeoutMs = 2000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.sent.length >= count) return this.sent[count - 1]!;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    // One final check to avoid a race between the last sleep and the deadline.
    if (this.sent.length >= count) return this.sent[count - 1]!;
    throw new Error(`Expected ${count} sent frames, got ${this.sent.length} after ${timeoutMs}ms`);
  }

  private emit(event: string, data: unknown): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        listener(data);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/** Result of `createHarness()`. */
interface Harness {
  client: BusClient;
  /** Fake sockets allocated by the transport factory, in creation order. */
  fakes: FakeWebSocket[];
  /** Tear down the transport after each test. */
  teardown: () => Promise<void>;
}

/**
 * Create a connected facade harness backed by `BusClient` and fake websocket(s).
 *
 * The fake transport is connected (socket open). The caller can inject
 * `subscribe-sync-complete` and request/response fixtures through
 * `harness.fakes[i]`.
 * @param count - Number of fake sockets to allocate for this test harness.
 * @param dispatch - Request dispatch mode to use for the connected client.
 * @returns Harness with the connected transport and fake socket
 */
async function createHarness(count = 1, dispatch: 'local-first' | 'remote' = 'remote'): Promise<Harness> {
  const fakes = Array.from({ length: count }, () => new FakeWebSocket());
  const client = new BusClient('ws://test-host/bus');

  let index = 0;
  const connect = client.connect({
    dispatch,
    createWebSocket: () => {
      const fake = fakes[index];
      index += 1;
      if (!fake) throw new Error('No more fake sockets available');
      return fake;
    },
  });

  const fake = fakes[0]!;
  await waitFor(() => fake.hasListener('message'), 2000, 'client did not attach a message listener');
  fake.receiveMessage({ type: 'subscribe-sync-complete' });
  await connect;

  return {
    client,
    fakes,
    teardown: async (): Promise<void> => {
      client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: poll a condition with a timeout
// ---------------------------------------------------------------------------

/**
 * Repeatedly poll a condition function until it returns `true`, or reject when
 * the timeout expires.
 * @param condition - Predicate to poll.
 * @param timeoutMs - Maximum wait time in milliseconds.
 * @param message - Error message on timeout.
 */
async function waitFor(condition: () => boolean, timeoutMs = 2000, message = 'Condition not met'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (condition()) return;
  throw new Error(`${message} (after ${timeoutMs}ms)`);
}

// ---------------------------------------------------------------------------
// Conformance fixture meta-tests
// ---------------------------------------------------------------------------

describe('conformance fixture integrity', () => {
  it('all message refs in cases.json resolve in messages.json', () => {
    for (const c of CASES) {
      for (const wire of c.wire) {
        expect(MESSAGES, `case ${c.id}: messageRef "${wire.messageRef}" not found in fixtures`).toHaveProperty(
          wire.messageRef,
        );
      }
    }
  });

  it('all assertion messageRef values resolve in messages.json', () => {
    for (const c of CASES) {
      for (const assertion of c.assertions) {
        if (typeof assertion.messageRef === 'string') {
          expect(MESSAGES, `case ${c.id}: assertion messageRef "${assertion.messageRef}" not found`).toHaveProperty(
            assertion.messageRef,
          );
        }
        for (const replayRef of assertion.messages ?? []) {
          expect(MESSAGES, `case ${c.id}: replay ref "${replayRef}" not found`).toHaveProperty(replayRef);
        }
      }
    }
  });

  it('all TypeScript facade conformance cases are explicitly covered', () => {
    const expected = CASES.map((c) => c.id).sort();
    const decided = Object.keys(CONFORMANCE_CASE_DECISIONS).sort();
    expect(decided).toEqual(expected);
  });

  it('all conformance case decisions resolve to cases', () => {
    const ids = new Set(CASES.map((c) => c.id));
    for (const id of Object.keys(CONFORMANCE_CASE_DECISIONS)) {
      expect(ids.has(id), `Missing conformance case: ${id}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Public BusClient facade
// ---------------------------------------------------------------------------

describe('BusClient public facade', () => {
  let fake: FakeWebSocket;
  let client: BusClient;

  beforeEach(async () => {
    fake = new FakeWebSocket();
    client = new BusClient('ws://test-host/bus');

    const connectPromise = client.connect({ createWebSocket: () => fake });
    await waitFor(() => fake.hasListener('message'), 2000, 'client did not attach a message listener');
    fake.receiveMessage({ type: 'subscribe-sync-complete' });
    await connectPromise;
  });

  afterEach(() => {
    client.close();
  });

  it('advertises event subscriptions through the SDK facade', async () => {
    const unsubscribe = client.subscribe(AgentSubjects.$all, () => undefined);

    const subscribeFrame = await fake.waitSent(1);
    expect(subscribeFrame).toEqual(msg('subscribe.agent.wildcard'));

    unsubscribe();

    const unsubscribeFrame = await fake.waitSent(2);
    expect(unsubscribeFrame).toEqual({
      type: 'unsubscribe',
      subjects: {
        'agent.*': [],
      },
    });
  });

  it('advertises request handler priority and uses returned handler values as responses', async () => {
    client.onRequest(
      ApprovalSubjects.request,
      () => ({
        action: 'allow',
      }),
      { priority: 250 },
    );

    const subscribeFrame = await fake.waitSent(1);
    expect(subscribeFrame).toEqual(msg('subscribe.approval.request'));

    fake.receiveMessage({
      type: 'request',
      namespace: 'approval',
      subject: 'request',
      correlationId: 'corr-returned-result',
      messageId: 'req-returned-result',
      payload: msg('request.approval.request').payload,
    });

    const responseFrame = await fake.waitSent(2);
    expect(responseFrame).toEqual({
      type: 'response',
      correlationId: 'corr-returned-result',
      result: {
        action: 'allow',
      },
    });
  });

  it('uses default local-first dispatch for matching local request handlers without sending a wire request', async () => {
    const unsubscribe = client.onRequest(
      ApprovalSubjects.request,
      () => ({
        action: 'allow',
      }),
      { priority: 250 },
    );

    const subscribeFrame = await fake.waitSent(1);
    expect(subscribeFrame).toEqual(msg('subscribe.approval.request'));

    const requestFixture = msg('request.approval.request');
    const result = await client.request<unknown, { action: 'allow' }>(
      ApprovalSubjects.request,
      requestFixture.payload,
      { timeout: requestFixture.timeout as number },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(result).toEqual({ action: 'allow' });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent.some((frame) => frame.type === 'request')).toBe(false);
    unsubscribe();
  });

  it("bypasses local request handlers and sends over the transport when dispatch is 'remote'", async () => {
    client.close();
    fake = new FakeWebSocket();
    client = new BusClient('ws://test-host/bus');

    const connectPromise = client.connect({ dispatch: 'remote', createWebSocket: () => fake });
    await waitFor(() => fake.hasListener('message'), 2000, 'client did not attach a message listener');
    fake.receiveMessage({ type: 'subscribe-sync-complete' });
    await connectPromise;

    let localCalls = 0;
    client.onRequest(
      ApprovalSubjects.request,
      () => {
        localCalls += 1;
        return {
          action: 'deny',
        };
      },
      { priority: 250 },
    );

    const subscribeFrame = await fake.waitSent(1);
    expect(subscribeFrame).toEqual(msg('subscribe.approval.request'));

    const requestFixture = msg('request.approval.request');
    const responsePromise = client.request<unknown, { action: 'allow' }>(
      ApprovalSubjects.request,
      requestFixture.payload,
      { timeout: requestFixture.timeout as number },
    );

    const requestFrame = await fake.waitSent(2);
    expect(requestFrame.type).toBe('request');
    expect(requestFrame.namespace).toBe(requestFixture.namespace);
    expect(requestFrame.subject).toBe(requestFixture.subject);
    expect(localCalls).toBe(0);

    const responseFixture = msg('response.approval.request');
    fake.receiveMessage({
      ...responseFixture,
      correlationId: requestFrame.correlationId,
    });

    await expect(responsePromise).resolves.toEqual(responseFixture.result);
    expect(localCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 1: event-delivery-agent-complete
// ---------------------------------------------------------------------------

describe(conformanceCase('event-delivery-agent-complete').title, () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('concrete subscription receives the matching event', async () => {
    const { client, fakes } = harness;
    const fake = fakes[0]!;
    const receivedEvents: Array<{ subject: string; payload: unknown; type: string }> = [];

    const unsubscribe = client.subscribe(AgentSubjects.complete, (ctx) => {
      receivedEvents.push({ type: 'event', subject: ctx.subject, payload: ctx.payload });
    });

    // The transport must have sent a subscribe wire message.
    const subscribeFrame = await fake.waitSent(1);
    expect(subscribeFrame).toMatchObject(msg('subscribe.agent.complete.initial'));

    // Server delivers the event.
    const eventFixture = msg('event.agent.complete');
    fake.receiveMessage(eventFixture);

    await waitFor(() => receivedEvents.length > 0, 2000, 'event not delivered to subscriber');

    const deliveredEvent = receivedEvents[0]!;
    expect(deliveredEvent.type).toBe('event');
    expect(deliveredEvent.subject).toBe(`${eventFixture.namespace}.${eventFixture.subject}`);
    expect(deliveredEvent.payload).toEqual(eventFixture.payload);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Case 2: request-response-correlation-approval-request
// ---------------------------------------------------------------------------

describe(conformanceCase('request-response-correlation-approval-request').title, () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('request and response are bound by the same correlationId', async () => {
    const { client, fakes } = harness;
    const fake = fakes[0]!;

    // Issue a request via the SDK request API. The SDK correlation tracker
    // resolves the returned promise when the response arrives.
    const requestFixture = msg('request.approval.request');
    const responsePromise = client.request(ApprovalSubjects.request, requestFixture.payload as never, {
      timeout: requestFixture.timeout as number,
    });

    // Verify the outbound request wire frame.
    const requestFrame = await fake.waitSent(1);
    expect(requestFrame.type).toBe('request');
    expect(requestFrame.namespace).toBe(requestFixture.namespace);
    expect(requestFrame.subject).toBe(requestFixture.subject);
    expect(requestFrame.correlationId).toBeDefined();

    // Server sends back a response with the same correlationId — the transport's
    // internal tracker matches it and resolves the request promise.
    const responseFixture = msg('response.approval.request');
    fake.receiveMessage({
      ...responseFixture,
      correlationId: requestFrame.correlationId,
    });

    const result = await responsePromise;
    expect(result).toEqual(responseFixture.result);
  });
});

// ---------------------------------------------------------------------------
// Case 3: no-handler-response-tool-execute
// ---------------------------------------------------------------------------

describe(conformanceCase('no-handler-response-tool-execute').title, () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('NO_HANDLER error response matches the fixture', async () => {
    const { client, fakes } = harness;
    const fake = fakes[0]!;

    // Client sends a request. The SDK correlation tracker awaits the matching
    // response and turns transport errors into request rejections.
    const requestFixture = msg('request.tool.execute.no-handler');

    const responsePromise = client.request(ToolSubjects.execute, requestFixture.payload as never, {
      timeout: requestFixture.timeout as number,
    });

    const requestFrame = await fake.waitSent(1);
    expect(requestFrame.type).toBe('request');
    expect(requestFrame.subject).toBe(requestFixture.subject);

    // Server responds with the canonical NO_HANDLER error. The transport's
    // correlation tracker rejects the pending promise with the structured error.
    const errorFixture = msg('response.tool.execute.no-handler');
    fake.receiveMessage({
      ...errorFixture,
      correlationId: requestFrame.correlationId,
    });

    const expectedSubject = (errorFixture.error as Record<string, unknown>).subject as string;

    await expect(responsePromise).rejects.toMatchObject({
      code: 'NO_HANDLER',
      subject: expectedSubject,
    });
  });
});

// ---------------------------------------------------------------------------
// Case 4: subscribe-replace-and-unsubscribe-approval-request
// ---------------------------------------------------------------------------

describe(conformanceCase('subscribe-replace-and-unsubscribe-approval-request').title, () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('subscribe replaces, close of one registration republishes remainder, final unsubscribes', async () => {
    const { client, fakes } = harness;
    const fake = fakes[0]!;

    // First registration at priority 100.
    const unsubscribe100 = client.subscribe(ApprovalSubjects.request, () => undefined, { priority: 100 });
    const firstFrame = await fake.waitSent(1);
    expect(firstFrame).toMatchObject(msg('subscribe.approval.request.initial'));

    // Second registration at priority 250 — replaces with [250, 100].
    const unsubscribe250 = client.subscribe(ApprovalSubjects.request, () => undefined, { priority: 250 });
    const secondFrame = await fake.waitSent(2);
    expect(secondFrame).toMatchObject(msg('subscribe.approval.request.updated'));

    // Close the first registration — republishes with [250] only.
    unsubscribe100();
    const remainingFrame = await fake.waitSent(3);
    expect(remainingFrame).toMatchObject(msg('subscribe.approval.request.remaining'));

    // Final unsubscribe — sends the unsubscribe frame.
    unsubscribe250();
    const unsubFrame = await fake.waitSent(4);
    expect(unsubFrame).toMatchObject(msg('unsubscribe.approval.request'));
  });
});

// ---------------------------------------------------------------------------
// Case 5: wildcard-subscriptions-agent-wildcard
// ---------------------------------------------------------------------------

describe(conformanceCase('wildcard-subscriptions-agent-wildcard').title, () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('wildcard subscribe frame matches fixture; server event delivered to onReceive', async () => {
    const { client, fakes } = harness;
    const fake = fakes[0]!;
    const receivedEvents: Array<{ subject: string; payload: unknown; type: string }> = [];

    const unsubscribe = client.subscribe(AgentSubjects.$all, (ctx) => {
      receivedEvents.push({ type: 'event', subject: ctx.subject, payload: ctx.payload });
    });

    // Subscribe with the wildcard pattern.
    const subscribeFrame = await fake.waitSent(1);
    expect(subscribeFrame).toMatchObject(msg('subscribe.agent.wildcard'));

    // Server delivers a concrete subject that matches the wildcard.
    const eventFixture = msg('event.agent.complete');
    fake.receiveMessage(eventFixture);

    await waitFor(() => receivedEvents.length > 0, 2000, 'wildcard did not receive concrete event');

    const deliveredEvent = receivedEvents[0]!;
    expect(deliveredEvent.type).toBe('event');
    expect(deliveredEvent.subject).toBe(`${eventFixture.namespace}.${eventFixture.subject}`);
    expect(deliveredEvent.payload).toEqual(eventFixture.payload);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Case 6: reconnect-subscription-replay
// ---------------------------------------------------------------------------

describe(conformanceCase('reconnect-subscription-replay').title, () => {
  it('local subscriptions are replayed on reconnect and handshake completes', async () => {
    const { client, fakes } = await createHarness(2);
    const initialFake = fakes[0]!;

    // Register subscriptions that should be replayed on reconnect.
    client.subscribe(AgentSubjects.$all, () => undefined);
    client.subscribe(ApprovalSubjects.request, () => undefined, { priority: 250 });

    // Wait for both subscribe frames on the initial connection.
    await initialFake.waitSent(2);

    // Simulate a server-side disconnect.
    initialFake.close(1001, 'server closed');

    // Reconnect through the bus facade — the same transport creates a new socket
    // and replays local subscriptions.
    await client.getBus().reconnect();

    const reconnectFake = fakes[1]!;

    // The replay must send a single subscribe frame covering both subjects.
    const replayFrame = await reconnectFake.waitSent(1);
    expect(replayFrame.type).toBe('subscribe');

    const subjects = replayFrame.subjects as Record<string, number[]>;
    const replayedRefs = conformanceCase('reconnect-subscription-replay').assertions.find((a) => a.kind === 'replays')!
      .messages!;

    // Both subscriptions must appear in the replayed subscribe frame.
    for (const ref of replayedRefs) {
      const fixtureSubjects = msg(ref).subjects as Record<string, number[]>;
      for (const [subject, priorities] of Object.entries(fixtureSubjects)) {
        expect(subjects, `Replay is missing subject "${subject}" from fixture "${ref}"`).toHaveProperty(subject);
        const replayedPriorities = subjects[subject]!;
        for (const p of priorities) {
          expect(replayedPriorities, `Replay for "${subject}" is missing priority ${p}`).toContain(p);
        }
      }
    }

    // Complete the post-reconnect handshake.
    reconnectFake.receiveMessage({ type: 'subscribe-sync-complete' });
    await client.getBus().ready;

    client.close();
  });
});

// ---------------------------------------------------------------------------
// Case 7: heartbeat-handling
// ---------------------------------------------------------------------------

describe(conformanceCase('heartbeat-handling').title, () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('heartbeat frames are not forwarded to onReceive handlers', async () => {
    const { client, fakes } = harness;
    const fake = fakes[0]!;
    let receivedCount = 0;
    const unsubscribe = client.subscribe(ToolSubjects.$all, () => {
      receivedCount += 1;
    });
    await fake.waitSent(1);

    const frameCountBefore = fake.sent.length;

    // Inject a heartbeat from the server.
    fake.receiveMessage(msg('heartbeat'));

    // Allow any async dispatch to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // No messages should have reached the onReceive handler.
    expect(receivedCount).toBe(0);
    unsubscribe();

    // No additional outbound frames (no echo, no subscribe changes).
    expect(fake.sent.length).toBe(frameCountBefore);
  });
});

// ---------------------------------------------------------------------------
// Case 8: broadcast-response-tool-execute
// ---------------------------------------------------------------------------

describe(conformanceCase('broadcast-response-tool-execute').title, () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('broadcast and broadcast-response frames do not trigger event subscription callbacks', async () => {
    const { client, fakes } = harness;
    const fake = fakes[0]!;
    let receivedCount = 0;
    const unsubscribe = client.subscribe(ToolSubjects.$all, () => {
      receivedCount += 1;
    });

    // Subscribe broadly to detect any spurious event dispatch.

    fake.receiveMessage(msg('broadcast.tool.execute'));
    fake.receiveMessage(msg('broadcast-response.tool.execute'));

    // Allow any async dispatch to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // Phase 1 SDKs do not expose a broadcast API. Broadcast frames must not
    // trigger event subscription callbacks (`type: 'event'` dispatch only).
    expect(receivedCount).toBe(0);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Case 9: local-event-parallel-dispatch
// ---------------------------------------------------------------------------

describe(conformanceCase('local-event-parallel-dispatch').title, () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness(1, 'local-first');
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('local event emission reaches every matching SDK facade subscriber', async () => {
    const { client, fakes } = harness;
    const fake = fakes[0]!;
    const subject = eventSubject('test', 'event.parallel', {
      local: true,
    });
    const received: string[] = [];

    const unsubscribeA = client.subscribe(subject, () => {
      received.push('a');
    });
    const unsubscribeB = client.subscribe(subject, () => {
      received.push('b');
    });

    await fake.waitSent(2);
    const frameCountBeforeEmit = fake.sent.length;

    await client.emit(subject, { seq: 1 });

    expect(received.sort()).toEqual(['a', 'b']);
    expect(fake.sent).toHaveLength(frameCountBeforeEmit);
    expect(fake.sent.some((frame) => frame.type === 'event')).toBe(false);

    unsubscribeA();
    unsubscribeB();
  });
});

// ---------------------------------------------------------------------------
// Case 10: local-request-priority-chain
// ---------------------------------------------------------------------------

describe(conformanceCase('local-request-priority-chain').title, () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness(1, 'local-first');
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('higher priority local handler can delegate to the lower priority handler result', async () => {
    const { client, fakes } = harness;
    const fake = fakes[0]!;
    const subject = requestSubject('test', 'chain', {
      local: true,
    });
    const calls: string[] = [];

    const unsubscribeHigh = client.onRequest(
      subject,
      async (ctx) => {
        calls.push('high');
        await ctx.next();
      },
      { priority: 100 },
    );
    const unsubscribeLow = client.onRequest(
      subject,
      () => {
        calls.push('low');
        return { from: 'low' };
      },
      { priority: 50 },
    );

    await fake.waitSent(2);
    const frameCountBeforeRequest = fake.sent.length;

    const result = await client.request<Record<string, never>, { from: string }>(subject, {});

    expect(result).toEqual({ from: 'low' });
    expect(calls).toEqual(['high', 'low']);
    expect(fake.sent).toHaveLength(frameCountBeforeRequest);
    expect(fake.sent.some((frame) => frame.type === 'request')).toBe(false);

    unsubscribeHigh();
    unsubscribeLow();
  });
});

// ---------------------------------------------------------------------------
// Case 11: local-wildcard-event-matching
// ---------------------------------------------------------------------------

describe(conformanceCase('local-wildcard-event-matching').title, () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness(1, 'local-first');
  });

  afterEach(async () => {
    await harness.teardown();
  });

  it('local wildcard subscription matches an emitted concrete subject', async () => {
    const { client, fakes } = harness;
    const fake = fakes[0]!;
    const receivedEvents: Array<{ subject: string; payload: unknown }> = [];
    const localAgentComplete = eventSubject('agent', 'complete', {
      local: true,
    });

    const unsubscribe = client.subscribe(AgentSubjects.$all, (ctx) => {
      receivedEvents.push({ subject: ctx.subject, payload: ctx.payload });
    });

    const subscribeFrame = await fake.waitSent(1);
    expect(subscribeFrame).toEqual(msg('subscribe.agent.wildcard'));

    const eventFixture = msg('event.agent.complete');
    await client.emit(localAgentComplete, eventFixture.payload as Record<string, unknown>);

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toEqual({
      subject: `${eventFixture.namespace}.${eventFixture.subject}`,
      payload: eventFixture.payload,
    });
    expect(fake.sent.some((frame) => frame.type === 'event')).toBe(false);

    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Case 12: auth-challenge-response
// ---------------------------------------------------------------------------

describe(conformanceCase('auth-challenge-response').title, () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('auto-resolved HMAC auth responds to the server challenge with the fixture signature', async () => {
    const fake = new FakeWebSocket();
    const client = new BusClient('ws://test-host/bus');
    const previousSecret = process.env.MAKAIO_BUS_SECRET;
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ ok: true, auth: true }), { status: 200 }));

    vi.stubGlobal('fetch', fetchStub);
    process.env.MAKAIO_BUS_SECRET = AUTH_CONFORMANCE_SECRET;

    try {
      const connectPromise = client.connect({ createWebSocket: () => fake, connectTimeoutMs: 2000 });
      await waitFor(() => fake.hasListener('message'), 2000, 'client did not attach a message listener');

      fake.receiveMessage(msg('auth-challenge'));

      const responseFrame = await fake.waitSent(1);
      expect(responseFrame).toEqual(msg('auth-response'));

      fake.receiveMessage(msg('auth-result'));
      fake.receiveMessage(msg('subscribe-sync-complete'));
      await connectPromise;

      expect(fetchStub).toHaveBeenCalledWith('http://test-host/health', expect.any(Object));
    } finally {
      client.close();
      if (previousSecret === undefined) {
        delete process.env.MAKAIO_BUS_SECRET;
      } else {
        process.env.MAKAIO_BUS_SECRET = previousSecret;
      }
    }
  });
});
