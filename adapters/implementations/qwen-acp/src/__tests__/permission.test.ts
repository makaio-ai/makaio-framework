/**
 * Tests for mapApprovalToAcpResponse
 *
 * Verifies that Makaio allow/deny approval actions are mapped to the correct
 * ACP RequestPermissionResponse, with correct option-kind preference order
 * and cancelled fallback when no matching option exists.
 */

import { tmpdir } from 'node:os';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PermissionOption } from '@agentclientprotocol/sdk';
import { MessageHandle, type NormalizedMessageInput } from '@makaio/ai-adapters-core';
import { createBusInstance } from '@makaio/bus-core';
import { ToolSubjects, type CallContext, type Party } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { QwenAcpConnector } from '../connector.js';
import { QwenAcpNamespace, QwenAcpSubjects } from '../namespaces/index.js';
import { mapApprovalToAcpResponse } from '../permission.js';

/**
 * Build a minimal PermissionOption for use in tests.
 * @param optionId - Unique identifier for the option
 * @param kind - Permission option kind
 * @returns A valid PermissionOption
 */
function makeOption(optionId: string, kind: PermissionOption['kind']): PermissionOption {
  return { optionId, kind, name: `Option ${optionId}` };
}

describe('mapApprovalToAcpResponse', () => {
  describe('allow action', () => {
    it('selects the allow_once option by preference when present', () => {
      const options: PermissionOption[] = [
        makeOption('opt-always', 'allow_always'),
        makeOption('opt-once', 'allow_once'),
      ];

      const result = mapApprovalToAcpResponse('allow', options);

      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-once' } });
    });

    it('falls back to allow_always when allow_once is absent', () => {
      const options: PermissionOption[] = [makeOption('opt-always', 'allow_always')];

      const result = mapApprovalToAcpResponse('allow', options);

      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-always' } });
    });

    it('returns cancelled when no allow-prefixed option exists', () => {
      const options: PermissionOption[] = [makeOption('opt-reject', 'reject_once')];

      const result = mapApprovalToAcpResponse('allow', options);

      expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    });
  });

  describe('deny action', () => {
    it('selects the reject_once option by preference when present', () => {
      const options: PermissionOption[] = [
        makeOption('opt-always', 'reject_always'),
        makeOption('opt-once', 'reject_once'),
      ];

      const result = mapApprovalToAcpResponse('deny', options);

      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-once' } });
    });

    it('falls back to reject_always when reject_once is absent', () => {
      const options: PermissionOption[] = [makeOption('opt-always', 'reject_always')];

      const result = mapApprovalToAcpResponse('deny', options);

      expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-always' } });
    });

    it('returns cancelled when no reject-prefixed option exists', () => {
      const options: PermissionOption[] = [makeOption('opt-allow', 'allow_once')];

      const result = mapApprovalToAcpResponse('deny', options);

      expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    });
  });

  it('returns cancelled when the options array is empty', () => {
    expect(mapApprovalToAcpResponse('allow', [])).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(mapApprovalToAcpResponse('deny', [])).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});

const APPROVER: Party = { kind: 'acme.person', id: 'person-approver' };
const TEST_MESSAGE: NormalizedMessageInput = {
  role: 'user',
  message: 'Hello',
  blocks: [{ type: 'text', content: 'Hello' }],
};
const NATIVE_AUTH = { processEnv: {}, connectorDeliveries: [], configInheritance: 'auth-only' as const };

/**
 * Build a pending operation handle.
 * @param call - Call context the handle serves
 * @param messageId - Message identifier of the handle
 * @returns Message handle for the call
 */
function makeHandle(call: CallContext, messageId: string): MessageHandle {
  return new MessageHandle(call, messageId, TEST_MESSAGE, 'enqueue');
}

/**
 * Build a connector on an isolated host bus that records every approval request it delivers.
 * @param decide - Resolves the approval decision for a delivered request
 * @returns Connector, host bus and the principals of the delivered approval requests
 */
async function createApprovalConnector(decide: () => Promise<'allow' | 'deny'> = async () => 'allow') {
  const hostBus = createBusInstance();
  const bus = await QwenAcpNamespace.scopedBus(hostBus);
  const connector = new QwenAcpConnector({
    bus,
    globalBus: hostBus,
    adapterId: 'adapter-1',
    adapterName: 'qwen-acp',
    agentId: 'agent-1',
    sessionId: 'session-1',
    model: 'qwen3-coder',
    cwd: tmpdir(),
    env: {},
    adapterAuth: NATIVE_AUTH,
    allowedDirectories: ['/workspace/project'],
  });
  const approvalPrincipals: Party[] = [];
  bus.on(QwenAcpSubjects.permission_request, async (ctx) => {
    approvalPrincipals.push(ctx.call.principal);
    const action = await decide();
    ctx.setResult(action === 'allow' ? { action } : { action, message: 'denied by test' });
  });
  const executeRequest = vi.spyOn(hostBus, 'request').mockResolvedValue({
    success: true,
    data: { content: 'file contents', path: '/workspace/project/notes.md', size: 13, truncated: false },
  });
  return { connector, approvalPrincipals, executeRequest };
}

const PERMISSION_REQUEST = {
  sessionId: 'adapter-session',
  toolCall: { toolCallId: 'tool-1', title: 'read_file', rawInput: { path: 'a.md' } },
  options: [makeOption('opt-once', 'allow_once')],
};

describe('QwenAcpConnector approval attribution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('R1: a permission request carries the call of the pending handle', async () => {
    const { connector, approvalPrincipals } = await createApprovalConnector();
    connector['pendingMessageHandle'] = makeHandle(createTestCall({ principal: APPROVER }), 'msg-1');

    const response = await connector['onRequestPermission'](PERMISSION_REQUEST);

    expect(response).toEqual({ outcome: { outcome: 'selected', optionId: 'opt-once' } });
    expect(approvalPrincipals).toEqual([APPROVER]);
  });

  it('R3: a permission request without a pending handle is cancelled with no approval request', async () => {
    const { connector, approvalPrincipals, executeRequest } = await createApprovalConnector();

    const response = await connector['onRequestPermission'](PERMISSION_REQUEST);

    expect(response).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(approvalPrincipals).toEqual([]);
    expect(executeRequest).not.toHaveBeenCalled();
  });

  it('R3: filesystem access without a pending handle throws the denial with no approval and no execution', async () => {
    const { connector, approvalPrincipals, executeRequest } = await createApprovalConnector();

    await expect(connector['requestFsApproval'](undefined, 'read_file', { path: 'a.md' })).rejects.toThrow(
      'Tool use denied: no operation attributable to this request',
    );
    await expect(connector['onReadTextFile']({ sessionId: 's', path: 'a.md' })).rejects.toThrow(
      'Tool use denied: no operation attributable to this request',
    );
    await expect(connector['onWriteTextFile']({ sessionId: 's', path: 'a.md', content: 'x' })).rejects.toThrow(
      'Tool use denied: no operation attributable to this request',
    );

    expect(approvalPrincipals).toEqual([]);
    expect(executeRequest).not.toHaveBeenCalled();
  });

  it('R1: filesystem execution after an approval await uses the captured call, never a later pending handle', async () => {
    let releaseApproval: () => void = () => undefined;
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const { connector, approvalPrincipals, executeRequest } = await createApprovalConnector(async () => {
      await approvalGate;
      return 'allow';
    });
    const firstCall = createTestCall({ principal: APPROVER });
    connector['pendingMessageHandle'] = makeHandle(firstCall, 'msg-first');

    const read = connector['onReadTextFile']({ sessionId: 's', path: 'a.md' });
    await vi.waitFor(() => expect(approvalPrincipals).toEqual([APPROVER]));
    // A later turn becomes pending while the approval is still open.
    connector['pendingMessageHandle'] = makeHandle(createTestCall(), 'msg-later');
    releaseApproval();
    await read;

    expect(executeRequest).toHaveBeenCalledTimes(1);
    const sentArgs: unknown[] = executeRequest.mock.calls[0];
    expect(sentArgs[0]).toBe(firstCall);
    expect(executeRequest).toHaveBeenCalledWith(
      firstCall,
      ToolSubjects.execute,
      expect.objectContaining({ contextOverrides: expect.objectContaining({ turnId: 'msg-first' }) }),
    );
  });
});
