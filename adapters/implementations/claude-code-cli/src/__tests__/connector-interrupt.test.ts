import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { Party } from '@makaio/contracts';
import type { SDKMessage } from '@makaio/client-claude-code';
import { createTestCall } from '@makaio/test-utils';

const transportStub = vi.hoisted(() => {
  // Settled from `close()`, as the real transport settles it from the child's exit.
  let settleExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settleExit = resolve;
  });
  return {
    transport: {
      onMessage: vi.fn(),
      onError: vi.fn(),
      close: vi.fn(() => settleExit(null)),
      exited,
    },
    createStdioTransport: vi.fn(),
  };
});

vi.mock('../utils/createStdioTransport.js', () => ({
  createStdioTransport: transportStub.createStdioTransport,
}));

import { ClaudeCliConnector } from '../connector.js';
import { ClaudeCodeCliConnectorNamespace, ClaudeCodeCliConnectorSubjects } from '../namespace/index.js';
import { makeTransportHarness } from './fixtures/transport-harness.js';

const transportHarness = makeTransportHarness(transportStub.transport);

const PERSON_A: Party = { kind: 'acme.person', id: 'person-a' };

/**
 * Create a connector instance without initializing a CLI subprocess.
 * @returns Claude CLI connector under test.
 */
async function makeConnector(): Promise<ClaudeCliConnector> {
  const bus = await ClaudeCodeCliConnectorNamespace.scopedBus(MakaioBus);
  return new ClaudeCliConnector({
    bus,
    globalBus: MakaioBus,
    adapterId: 'test-adapter',
    adapterName: 'claude-code-cli',
    agentId: 'test-agent',
    cwd: os.tmpdir(),
    model: 'claude-sonnet',
    env: {},
  });
}

describe('ClaudeCliConnector interrupt', () => {
  it('rejects public interrupt requests as unsupported', async () => {
    const connector = await makeConnector();

    await expect(connector.interrupt()).rejects.toThrow('Claude Code CLI adapter does not support interrupt()');
  });
});

describe('ClaudeCliConnector sdk.event origin', () => {
  /** What one `sdk.event` delivery carried: the call's principal and the originating message id. */
  interface ObservedSdkEvent {
    principal: Party;
    originatingMessageId: string | undefined;
    type: string;
  }

  let observed: ObservedSdkEvent[];
  let connector: ClaudeCliConnector | undefined;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    transportHarness.reset();
    transportStub.createStdioTransport.mockReset();
    transportStub.createStdioTransport.mockImplementation(() => transportStub.transport);
    observed = [];
    MakaioBus.on(ClaudeCodeCliConnectorSubjects.sdk.event, (busCtx) => {
      const payload = busCtx.payload as { type: string; originatingMessageId?: string };
      observed.push({
        principal: busCtx.call.principal,
        originatingMessageId: payload.originatingMessageId,
        type: payload.type,
      });
    });
  });

  afterEach(async () => {
    await connector?.close();
    connector = undefined;
    MakaioBus.__resetHandlers?.();
  });

  it('R1: emits an event received during a turn under the call of the pending handle', async () => {
    connector = await makeConnector();
    const handle = await connector.start(
      { role: 'user', message: 'hello', blocks: [{ type: 'text', content: 'hello' }] },
      { call: createTestCall({ principal: PERSON_A }) },
    );

    transportHarness.emitMessage({ type: 'system', subtype: 'init', session_id: 'provider-session' } as SDKMessage);

    await vi.waitFor(() => {
      expect(observed.some((event) => event.type === 'system')).toBe(true);
    });
    const event = observed.find((candidate) => candidate.type === 'system');
    expect(event?.principal).toEqual(PERSON_A);
    expect(event?.originatingMessageId).toBe(handle.messageHandle.messageId);
  });

  it('R2: emits an event received with no pending handle with the observer context and no origin', async () => {
    connector = await makeConnector();
    await connector.start(
      { role: 'user', message: 'hello', blocks: [{ type: 'text', content: 'hello' }] },
      { call: createTestCall({ principal: PERSON_A }) },
    );
    transportHarness.emitMessage({ type: 'system', subtype: 'init', session_id: 'provider-session' } as SDKMessage);
    transportHarness.emitMessage({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      session_id: 'provider-session',
    } as SDKMessage);
    await connector.complete();
    observed.length = 0;

    // The turn is complete and its handle cleared: a late event belongs to no operation.
    transportHarness.emitMessage({ type: 'system', subtype: 'status', session_id: 'provider-session' } as SDKMessage);

    await vi.waitFor(() => {
      expect(observed.length).toBeGreaterThan(0);
    });
    expect(observed[0]?.originatingMessageId).toBeUndefined();
    expect(observed[0]?.principal).not.toEqual(PERSON_A);
  });
});
