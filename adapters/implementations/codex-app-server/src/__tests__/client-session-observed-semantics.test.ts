/**
 * Tests for CodexAppServerAgent — client.session.* observed-semantics emissions
 *
 * Verifies that the agent emits normalized client.session.* events on the
 * global bus at the correct adapter lifecycle points.
 *
 * Test setup: creates a real CodexAppServerConnector (via the shared test
 * context helper) and wires a CodexAppServerAgent on top of it. Connector
 * notifications are injected through the mock JSON-RPC client so the full
 * agent event-wiring path is exercised without a live subprocess.
 */

import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, ClientSubjects } from '@makaio/contracts';
import { CodexAppServerAgent } from '../agent.js';
import { CodexAppServerConfig } from '../config.js';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  startConnectorWithThread,
  createMockThread,
  createMockTurn,
  type ConnectorTestContext,
} from './shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a CodexAppServerAgent wired to the connector from an existing test
 * context.  The agent is initialized immediately so event subscriptions are
 * active before the first connector notification arrives.
 * @param ctx - Connector test context
 * @param clientId - Client ID for observed-semantics payloads (default: 'codex')
 * @returns The initialized agent instance
 */
async function createAgentForContext(ctx: ConnectorTestContext, clientId = 'codex'): Promise<CodexAppServerAgent> {
  const agent = new CodexAppServerAgent({
    agentId: 'test-agent',
    adapterId: 'test-adapter',
    adapterName: 'codex-app-server',
    capabilities: ['tools', 'streaming'],
    nativeTools: ['bash', 'patch'],
    adapterBus: ctx.mockBus,
    clientId,
    globalBus: MakaioBus,
    model: 'claude-3-5-sonnet-20241022',
    configFactory: CodexAppServerConfig.getConfig,
    // Return the already-created connector so the agent wires against it directly.
    connectorFactory: () => ctx.connector,
  });
  await agent.init();
  return agent;
}

/**
 * Collect payloads emitted to a bus subject while executing an action.
 *
 * Accepts a subscribe factory so callers provide the type-safe bus subscription
 * directly — avoiding the generic correlation problem that arises when the
 * subject is passed as an opaque parameter.
 *
 * Subscribes before the action, waits for the action to settle, then
 * unsubscribes and returns all captured payloads.
 * @param subscribe - Factory that installs the subscription and returns its cleanup
 * @param action - Async operation expected to produce emissions
 * @returns Collected payloads in emission order
 */
async function collectClientSessionEvents(
  subscribe: (onPayload: (payload: unknown) => void) => () => void,
  action: () => Promise<void>,
): Promise<unknown[]> {
  const collected: unknown[] = [];
  const cleanup = subscribe((payload) => {
    collected.push(payload);
  });
  try {
    await action();
    // Adapter-derived client.session emissions are intentionally best-effort
    // fire-and-forget. A short timer tick lets those async emissions settle
    // before the test tears down the bus subscription.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    cleanup();
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexAppServerAgent — client.session.* observed-semantics', () => {
  let ctx: ConnectorTestContext | undefined;

  const requireCtx = (): ConnectorTestContext => {
    if (!ctx) {
      throw new Error('Connector test context was not initialized');
    }
    return ctx;
  };

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
  });

  afterEach(() => {
    if (ctx) {
      cleanupConnectorTestContext(ctx);
      ctx = undefined;
    }
    MakaioBus.__resetHandlers?.();
  });

  // -------------------------------------------------------------------------
  // session.started
  // -------------------------------------------------------------------------

  describe('session.started', () => {
    it('emits client.session.started when thread/started arrives', async () => {
      await createAgentForContext(requireCtx());

      const events = await collectClientSessionEvents(
        (onPayload) => MakaioBus.on(ClientSubjects.session.started, (busCtx) => onPayload(busCtx.payload)),
        async () => {
          await startConnectorWithThread(requireCtx());
        },
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        clientId: 'codex',
        source: 'adapter-derived',
        observedAt: expect.any(Number),
      });
    });

    it('forwards clientId from agent config to session.started payload', async () => {
      await createAgentForContext(requireCtx(), 'custom-client');

      const events = await collectClientSessionEvents(
        (onPayload) => MakaioBus.on(ClientSubjects.session.started, (busCtx) => onPayload(busCtx.payload)),
        async () => {
          await startConnectorWithThread(requireCtx());
        },
      );

      expect(events).toHaveLength(1);
      expect((events[0] as { clientId: string }).clientId).toBe('custom-client');
    });
  });

  // -------------------------------------------------------------------------
  // session.turn.started / session.turn.completed
  // -------------------------------------------------------------------------

  describe('session.turn.started and session.turn.completed', () => {
    it('emits client.session.turn.started when AgentSubjects.turn.started fires for this agent', async () => {
      // wireClientSessionTurnObservations subscribes to AgentSubjects.turn.started
      // with an agentId filter and re-emits it as ClientSubjects.session.turn.started.
      // Emit the upstream event directly so the subscription fires without going through
      // the full connector lifecycle.
      await createAgentForContext(requireCtx());

      const events = await collectClientSessionEvents(
        (onPayload) => MakaioBus.on(ClientSubjects.session.turn.started, (busCtx) => onPayload(busCtx.payload)),
        async () => {
          await MakaioBus.emit(AgentSubjects.turn.started, {
            agentId: 'test-agent',
            adapterId: 'test-adapter',
            adapterName: 'codex-app-server',
            adapterSessionId: 'session-abc',
            messageId: 'msg-turn-001',
            content: {
              role: 'user',
              blocks: [{ type: 'text', content: 'Hello' }],
              message: 'Hello',
            },
          });
        },
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        clientId: 'codex',
        source: 'adapter-derived',
        observedAt: expect.any(Number),
      });
    });

    it('emits client.session.turn.completed after a turn completes', async () => {
      const agent = await createAgentForContext(requireCtx());

      // Drive the turn through the agent so the lifecycle tracker registers the handle.
      // connector.start() blocks on thread/started; inject it after yielding so the
      // deferred promise and notification handlers are wired before injection.
      void agent
        .start({ role: 'user', message: 'Hello', blocks: [{ type: 'text', content: 'Hello' }] }, {})
        .catch(() => undefined);

      // Yield past initializeConnection() and startThread() setup
      await new Promise((r) => setTimeout(r, 0));

      // Unblock startThread() — connector now creates the thread and handle,
      // which agent.start() registers with the lifecycle tracker
      await requireCtx().mockJsonRpcClient.receiveNotification('thread/started', {
        thread: createMockThread(),
      });

      // Allow agent.start() to finish and the lifecycle tracker to track the handle
      await new Promise((r) => setTimeout(r, 10));

      const events = await collectClientSessionEvents(
        (onPayload) => MakaioBus.on(ClientSubjects.session.turn.completed, (busCtx) => onPayload(busCtx.payload)),
        async () => {
          // turn/started acknowledges the handle → lifecycle tracker emits turn.started
          await requireCtx().mockJsonRpcClient.receiveNotification('turn/started', {
            threadId: 'thread-123',
            turn: createMockTurn(),
          });
          // turn/completed completes the handle → lifecycle tracker emits turn.completed
          await requireCtx().mockJsonRpcClient.receiveNotification('turn/completed', {
            threadId: 'thread-123',
            turn: createMockTurn({ status: 'completed' }),
          });
          await new Promise((r) => setTimeout(r, 50));
        },
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        clientId: 'codex',
        source: 'adapter-derived',
        observedAt: expect.any(Number),
      });
    });
  });

  // -------------------------------------------------------------------------
  // session.userPrompt.submitted — emitted when user_message.sent fires
  // -------------------------------------------------------------------------

  describe('session.userPrompt.submitted', () => {
    it('emits client.session.userPrompt.submitted with prompt text when user_message.sent fires', async () => {
      // Wire the agent so wireClientSessionTurnObservations registers the
      // AgentSubjects.user_message.sent → ClientSubjects.session.userPrompt.submitted
      // subscription. The connector is pre-created without onMessageSent, so we
      // drive the wired listener directly by emitting the upstream event.
      await createAgentForContext(requireCtx());

      const events = await collectClientSessionEvents(
        (onPayload) => MakaioBus.on(ClientSubjects.session.userPrompt.submitted, (busCtx) => onPayload(busCtx.payload)),
        async () => {
          // Emit agent.user_message.sent with the agentId filter that
          // wireClientSessionTurnObservations subscribes to.
          await MakaioBus.emit(AgentSubjects.user_message.sent, {
            agentId: 'test-agent',
            adapterId: 'test-adapter',
            adapterName: 'codex-app-server',
            adapterSessionId: 'session-abc',
            messageId: 'msg-001',
            content: {
              role: 'user',
              blocks: [{ type: 'text', content: 'Hello from user' }],
              message: 'Hello from user',
            },
            deliveryMode: 'enqueue',
          });
        },
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        clientId: 'codex',
        source: 'adapter-derived',
        observedAt: expect.any(Number),
        prompt: 'Hello from user',
      });
    });

    it('omits prompt from userPrompt.submitted payload when message text is absent', async () => {
      await createAgentForContext(requireCtx());

      const events = await collectClientSessionEvents(
        (onPayload) => MakaioBus.on(ClientSubjects.session.userPrompt.submitted, (busCtx) => onPayload(busCtx.payload)),
        async () => {
          await MakaioBus.emit(AgentSubjects.user_message.sent, {
            agentId: 'test-agent',
            adapterId: 'test-adapter',
            adapterName: 'codex-app-server',
            adapterSessionId: 'session-abc',
            messageId: 'msg-002',
            content: {
              role: 'user',
              blocks: [{ type: 'text', content: 'blocks only' }],
              // message intentionally absent
            },
            deliveryMode: 'enqueue',
          });
        },
      );

      expect(events).toHaveLength(1);
      expect(events[0]).not.toHaveProperty('prompt');
    });
  });

  // -------------------------------------------------------------------------
  // session.tool.pre / session.tool.post — bash command execution lifecycle
  // -------------------------------------------------------------------------

  describe('session.tool.pre and session.tool.post from bash command lifecycle', () => {
    beforeEach(async () => {
      await createAgentForContext(requireCtx());
      await startConnectorWithThread(requireCtx());
      await requireCtx().mockJsonRpcClient.receiveNotification('turn/started', {
        threadId: 'thread-123',
        turn: createMockTurn(),
      });
    });

    it('emits client.session.tool.pre when item/started fires for a commandExecution', async () => {
      const events = await collectClientSessionEvents(
        (onPayload) => MakaioBus.on(ClientSubjects.session.tool.pre, (busCtx) => onPayload(busCtx.payload)),
        async () => {
          await requireCtx().mockJsonRpcClient.receiveNotification('item/started', {
            threadId: 'thread-123',
            turnId: 'turn-456',
            item: {
              type: 'commandExecution',
              id: 'item-pre-001',
              command: 'echo hello',
              cwd: '/tmp',
              processId: null,
              status: 'pending',
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
          });
        },
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        clientId: 'codex',
        source: 'adapter-derived',
        toolName: 'bash',
        toolCallId: 'item-pre-001',
        observedAt: expect.any(Number),
      });
    });

    it('emits client.session.tool.post with success:true when command exits 0', async () => {
      // Prime with item/started so the connector has the item in its cache
      await requireCtx().mockJsonRpcClient.receiveNotification('item/started', {
        threadId: 'thread-123',
        turnId: 'turn-456',
        item: {
          type: 'commandExecution',
          id: 'item-post-001',
          command: 'echo hello',
          cwd: '/tmp',
          processId: null,
          status: 'pending',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });
      await new Promise((r) => setTimeout(r, 10));

      const events = await collectClientSessionEvents(
        (onPayload) => MakaioBus.on(ClientSubjects.session.tool.post, (busCtx) => onPayload(busCtx.payload)),
        async () => {
          await requireCtx().mockJsonRpcClient.receiveNotification('item/completed', {
            threadId: 'thread-123',
            turnId: 'turn-456',
            item: {
              type: 'commandExecution',
              id: 'item-post-001',
              command: 'echo hello',
              cwd: '/tmp',
              processId: null,
              status: 'completed',
              commandActions: [],
              aggregatedOutput: 'hello',
              exitCode: 0,
              durationMs: 10,
            },
          });
        },
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        clientId: 'codex',
        source: 'adapter-derived',
        toolName: 'bash',
        toolCallId: 'item-post-001',
        success: true,
        observedAt: expect.any(Number),
      });
    });

    it('emits client.session.tool.post with success:false when command exits non-zero', async () => {
      await requireCtx().mockJsonRpcClient.receiveNotification('item/started', {
        threadId: 'thread-123',
        turnId: 'turn-456',
        item: {
          type: 'commandExecution',
          id: 'item-fail-001',
          command: 'false',
          cwd: '/tmp',
          processId: null,
          status: 'pending',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
      });
      await new Promise((r) => setTimeout(r, 10));

      const events = await collectClientSessionEvents(
        (onPayload) => MakaioBus.on(ClientSubjects.session.tool.post, (busCtx) => onPayload(busCtx.payload)),
        async () => {
          await requireCtx().mockJsonRpcClient.receiveNotification('item/completed', {
            threadId: 'thread-123',
            turnId: 'turn-456',
            item: {
              type: 'commandExecution',
              id: 'item-fail-001',
              command: 'false',
              cwd: '/tmp',
              processId: null,
              status: 'completed',
              commandActions: [],
              aggregatedOutput: '',
              exitCode: 1,
              durationMs: 5,
            },
          });
        },
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        success: false,
      });
    });
  });
});
