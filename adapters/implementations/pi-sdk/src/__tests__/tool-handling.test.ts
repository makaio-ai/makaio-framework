import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { BeforeToolCallContext } from '@mariozechner/pi-agent-core';
import { MessageHandle } from '@makaio/ai-adapters-core';
import { createBusInstance } from '@makaio/bus-core';
import { AuthCredentialRefSchema, type AgentToolApproveResponse, type Party } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { PiConnector } from '../connector.js';
import { PiSdkNamespace, PiSdkSubjects } from '../namespaces/index.js';
import { createPiBeforeToolCallHook, type PiToolCallPayload } from '../tool-handling.js';

function createBeforeToolCallContext(args: Record<string, unknown> = { path: 'original.md' }): BeforeToolCallContext {
  const toolCallArgs = { ...args };
  const executionArgs = { ...args };
  return {
    toolCall: {
      id: 'tool-call-1',
      name: 'read_file',
      type: 'toolCall',
      arguments: toolCallArgs,
    },
    args: executionArgs,
    assistantMessage: {
      role: 'assistant',
      content: [],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: 'toolUse',
      timestamp: 0,
    },
    context: {
      systemPrompt: '',
      messages: [],
      tools: [],
    },
  };
}

describe('createPiBeforeToolCallHook', () => {
  it('stores approval-rewritten input for tools that can apply it', async () => {
    const requestApproval = vi.fn<() => Promise<AgentToolApproveResponse>>().mockResolvedValue({
      action: 'allow',
      updatedInput: { path: 'approved.md' },
    });
    const onApprovedInputUpdate = vi.fn(() => true);
    const hook = createPiBeforeToolCallHook(requestApproval, { onApprovedInputUpdate });

    const context = createBeforeToolCallContext();
    const result = await hook(context);

    expect(result).toBeUndefined();
    expect(onApprovedInputUpdate).toHaveBeenCalledWith('tool-call-1', 'read_file', { path: 'approved.md' });
    expect(context.args).toEqual({ path: 'approved.md' });
    expect(context.toolCall.arguments).toEqual({ path: 'approved.md' });
  });

  it('applies approval input rewrites to Pi native execution args', async () => {
    const requestApproval = vi.fn<() => Promise<AgentToolApproveResponse>>().mockResolvedValue({
      action: 'allow',
      updatedInput: { path: 'approved.md' },
    });
    const context = createBeforeToolCallContext();
    const hook = createPiBeforeToolCallHook(requestApproval);

    const result = await hook(context);

    expect(result).toBeUndefined();
    expect(context.args).toEqual({ path: 'approved.md' });
    expect(context.toolCall.arguments).toEqual({ path: 'approved.md' });
  });

  it('marks hard-denied approvals as abort requests', async () => {
    const requestApproval = vi.fn<() => Promise<AgentToolApproveResponse>>().mockResolvedValue({
      action: 'deny',
      message: 'Denied by policy.',
      shouldAbort: true,
    });
    const onAbortRequested = vi.fn();
    const hook = createPiBeforeToolCallHook(requestApproval, { onAbortRequested });

    const result = await hook(createBeforeToolCallContext());

    expect(result).toEqual({ block: true, reason: 'Denied by policy.' });
    expect(onAbortRequested).toHaveBeenCalledWith('read_file', 'Denied by policy.');
  });
});

/** Pi connector exposing the pending-turn slot and the real approval callback body. */
class ApprovalPiConnector extends PiConnector {
  /**
   * Install the handle of the turn a callback is attributed to.
   * @param handle - The pending handle, or `undefined` for no turn
   */
  public setPending(handle: MessageHandle | undefined): void {
    this.pendingMessageHandle = handle;
  }

  /**
   * Drive the approval callback the connector hands to its Pi session.
   * @param payload - Tool call fields from the beforeToolCall hook
   * @returns The approval decision
   */
  public approve(payload: PiToolCallPayload): Promise<AgentToolApproveResponse> {
    return this.requestPiToolApproval(payload);
  }
}

const APPROVER: Party = { kind: 'acme.person', id: 'person-approver' };
const TOOL_PAYLOAD: PiToolCallPayload = { toolCallId: 'tool-call-1', toolName: 'read_file', args: { path: 'a.md' } };

/**
 * Build a connector on an isolated host bus together with an approval handler recorder.
 * @returns Connector and the principals of every approval request the bus delivered
 */
async function createApprovalConnector() {
  const hostBus = createBusInstance();
  const bus = await PiSdkNamespace.scopedBus(hostBus);
  const connector = new ApprovalPiConnector({
    bus,
    globalBus: hostBus,
    adapterId: 'adapter-pi-approval',
    adapterName: 'pi-sdk',
    agentId: 'agent-pi-approval',
    model: 'claude-sonnet-4-20250514',
    cwd: os.tmpdir(),
    env: {},
    adapterAuth: {
      processEnv: {},
      connectorDeliveries: [{ target: 'pi-sdk.provider-auth', values: { apiKey: 'selected-connector-secret' } }],
      configInheritance: 'empty',
    },
    providerContext: {
      state: 'resolved',
      providerConfigId: 'provider-config-pi-approval',
      definitionId: 'anthropic',
      auth: {
        mode: 'explicit',
        method: { owner: 'provider', providerDefinitionId: 'anthropic', methodId: 'api-key' },
        definition: {
          id: 'api-key',
          mode: 'explicit',
          label: 'API key',
          fields: [
            {
              id: 'apiKey',
              label: 'API key',
              required: true,
              secret: true,
              sourceHints: [{ kind: 'environment', variable: 'ANTHROPIC_API_KEY' }],
            },
          ],
        },
        credentialRefs: { apiKey: AuthCredentialRefSchema.parse('env:ANTHROPIC_API_KEY') },
      },
    },
    providerProtocol: 'anthropic',
    providerConfig: {},
  });
  const approvalPrincipals: Party[] = [];
  bus.on(PiSdkSubjects.tool_approval, (ctx) => {
    approvalPrincipals.push(ctx.call.principal);
    ctx.setResult({ action: 'allow' });
  });
  return { connector, approvalPrincipals };
}

describe('PiConnector approval callback', () => {
  it('R1: requests approval under the call of the pending handle', async () => {
    const { connector, approvalPrincipals } = await createApprovalConnector();
    const call = createTestCall({ principal: APPROVER });
    connector.setPending(new MessageHandle(call, 'message-1', { role: 'user', message: 'hi', blocks: [] }, 'enqueue'));

    const response = await connector.approve(TOOL_PAYLOAD);

    expect(response).toEqual({ action: 'allow' });
    expect(approvalPrincipals).toEqual([APPROVER]);
  });

  it('R3: denies with the typed response and sends no approval request without a pending handle', async () => {
    const { connector, approvalPrincipals } = await createApprovalConnector();
    connector.setPending(undefined);

    const response = await connector.approve(TOOL_PAYLOAD);

    expect(response).toEqual({
      action: 'deny',
      message: 'Tool use denied: no operation attributable to this approval request',
      shouldAbort: false,
    });
    expect(approvalPrincipals).toEqual([]);
  });

  it('R3: the outer hook blocks tool execution on that denial', async () => {
    const { connector, approvalPrincipals } = await createApprovalConnector();
    const hook = createPiBeforeToolCallHook((payload) => connector.approve(payload));

    const result = await hook(createBeforeToolCallContext());

    expect(result).toEqual({
      block: true,
      reason: 'Tool use denied: no operation attributable to this approval request',
    });
    expect(approvalPrincipals).toEqual([]);
  });
});
