/**
 * Tests for CodexAppServerConnector - Tool Approval
 *
 * Tests tool approval requests:
 * - Command execution approval
 * - File change approval
 * - Dynamic tool call approval (item/tool/call gating)
 * - Native tool disable via harness nativeTools.disabled
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { HarnessSubjects, ToolSubjects } from '@makaio/contracts';
import { CodexAppServerNamespace } from '../namespaces/index.js';
import {
  createConnectorTestContext,
  createMockTurn,
  cleanupConnectorTestContext,
  startConnectorWithTurn,
  type ConnectorTestContext,
} from './shared.js';

describe('CodexAppServerConnector - Tool approval', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
    vi.clearAllMocks();
    await startConnectorWithTurn(ctx, 'Run ls command');
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
    MakaioBus.__resetHandlers?.();
  });

  it('should request exec_approval_request on command approval server request', async () => {
    const receivedRequests: unknown[] = [];
    // Register a handler that responds to the request (request/response pattern)
    ctx.mockBus.on(CodexAppServerNamespace.subjects.exec_approval_request, (busCtx) => {
      receivedRequests.push(busCtx.payload);
      // Must call setResult for request/response subjects
      busCtx.setResult({ decision: 'accept' });
    });

    // Send item/started before approval so the approval handler can resolve
    // command metadata before issuing the scoped bus request.
    await ctx.mockJsonRpcClient.receiveNotification('item/started', {
      threadId: 'thread-123',
      turnId: 'turn-456',
      item: {
        type: 'commandExecution',
        id: 'item-789',
        command: 'echo hello',
        cwd: '/workspace',
        processId: null,
        status: 'pending',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    });

    const serverRequest = {
      id: 100,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-123',
        turnId: 'turn-456',
        itemId: 'item-789',
        reason: 'Command needs approval',
        proposedExecpolicyAmendment: null,
      },
    };

    const response = await ctx.mockJsonRpcClient.receiveServerRequest(serverRequest);

    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0]).toMatchObject({
      threadId: 'thread-123',
      callId: 'item-789', // Schema uses callId, not itemId
      reason: 'Command needs approval',
    });
    expect(response).toMatchObject({ decision: 'accept' });
  });

  it('should resolve command info from item/started when approval arrives before item/started', async () => {
    const receivedRequests: unknown[] = [];
    ctx.mockBus.on(CodexAppServerNamespace.subjects.exec_approval_request, (busCtx) => {
      receivedRequests.push(busCtx.payload);
      busCtx.setResult({ decision: 'accept' });
    });

    const serverRequest = {
      id: 103,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-123',
        turnId: 'turn-456',
        itemId: 'item-race',
        reason: 'Approval before item/started',
        proposedExecpolicyAmendment: null,
      },
    };

    // Fire approval before item/started so commandExecutionByItemId is empty.
    // The approval handler will park on waitForCommandInfo().
    const approvalPromise = ctx.mockJsonRpcClient.receiveServerRequest(serverRequest);

    // Yield so the approval handler reaches waitForCommandInfo before we enqueue
    // the notification that resolves it.
    await new Promise((r) => setTimeout(r, 0));

    // Fire item/started — enqueueNotification chains handleItemStarted onto the
    // notification queue. When it drains, notifyCommandInfoReady unblocks the
    // parked waitForCommandInfo and the approval handler completes.
    await ctx.mockJsonRpcClient.receiveNotification('item/started', {
      threadId: 'thread-123',
      turnId: 'turn-456',
      item: {
        type: 'commandExecution',
        id: 'item-race',
        command: 'ls -la',
        cwd: '/workspace',
        processId: null,
        status: 'pending',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    });

    const response = await approvalPromise;

    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0]).toMatchObject({
      callId: 'item-race',
      command: ['ls -la'],
      cwd: '/workspace',
    });
    expect(response).toMatchObject({ decision: 'accept' });
  });

  it('should request file_change_approval_request on file change approval server request', async () => {
    const receivedRequests: unknown[] = [];
    // Register a handler that responds to the request (request/response pattern)
    ctx.mockBus.on(CodexAppServerNamespace.subjects.file_change_approval_request, (busCtx) => {
      receivedRequests.push(busCtx.payload);
      // Must call setResult for request/response subjects
      busCtx.setResult({ decision: 'accept' });
    });

    const serverRequest = {
      id: 101,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-123',
        turnId: 'turn-456',
        itemId: 'item-790',
        reason: 'File change needs approval',
        grantRoot: '/workspace',
      },
    };

    const response = await ctx.mockJsonRpcClient.receiveServerRequest(serverRequest);

    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0]).toMatchObject({
      threadId: 'thread-123',
      itemId: 'item-790',
      reason: 'File change needs approval',
      grantRoot: '/workspace',
    });
    expect(response).toMatchObject({ decision: 'accept' });
  });
});

describe('CodexAppServerConnector - nativeTools.disabled filtering', () => {
  let ctx: ConnectorTestContext;

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
    MakaioBus.__resetHandlers?.();
  });

  /**
   * Build a minimal harness response payload for test handlers.
   * @param disabledTools - Tool names to include in nativeTools.disabled
   */
  function buildHarnessPayload(disabledTools: string[]) {
    return {
      id: 'test-harness',
      name: 'Test Harness',
      adapterName: 'codex-app-server',
      approvalPolicy: 'always-ask' as const,
      nativeTools: { enabled: [], disabled: disabledTools },
      registryTools: { enabled: [], disabled: [] },
      isDefault: true,
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  it('should decline command approval immediately when bash is disabled by harness', async () => {
    MakaioBus.on(HarnessSubjects.getDefault, (busCtx) => {
      busCtx.setResult(buildHarnessPayload(['bash']));
    });

    ctx = await createConnectorTestContext();
    await startConnectorWithTurn(ctx, 'Run a command');

    const serverRequest = {
      id: 200,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-123',
        turnId: 'turn-456',
        itemId: 'item-789',
        reason: 'Command needs approval',
        proposedExecpolicyAmendment: null,
      },
    };

    const response = await ctx.mockJsonRpcClient.receiveServerRequest(serverRequest);

    expect(response).toMatchObject({ decision: 'decline' });
  });

  it('should decline file change approval immediately when patch is disabled by harness', async () => {
    MakaioBus.on(HarnessSubjects.getDefault, (busCtx) => {
      busCtx.setResult(buildHarnessPayload(['patch']));
    });

    ctx = await createConnectorTestContext();
    await startConnectorWithTurn(ctx, 'Apply a patch');

    const serverRequest = {
      id: 201,
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thread-123',
        turnId: 'turn-456',
        itemId: 'item-790',
        reason: 'File change needs approval',
        grantRoot: '/workspace',
      },
    };

    const response = await ctx.mockJsonRpcClient.receiveServerRequest(serverRequest);

    expect(response).toMatchObject({ decision: 'decline' });
  });

  it('should proceed with normal approval flow when no tools are disabled', async () => {
    MakaioBus.on(HarnessSubjects.getDefault, (busCtx) => {
      busCtx.setResult(buildHarnessPayload([]));
    });

    ctx = await createConnectorTestContext();
    await startConnectorWithTurn(ctx, 'Run a command');

    const receivedRequests: unknown[] = [];
    ctx.mockBus.on(CodexAppServerNamespace.subjects.exec_approval_request, (busCtx) => {
      receivedRequests.push(busCtx.payload);
      busCtx.setResult({ decision: 'accept' });
    });

    // Send item/started before approval so normal approval flow can include
    // command metadata in the scoped bus request.
    await ctx.mockJsonRpcClient.receiveNotification('item/started', {
      threadId: 'thread-123',
      turnId: 'turn-456',
      item: {
        type: 'commandExecution',
        id: 'item-791',
        command: 'echo test',
        cwd: '/workspace',
        processId: null,
        status: 'pending',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    });

    const serverRequest = {
      id: 202,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-123',
        turnId: 'turn-456',
        itemId: 'item-791',
        reason: 'Needs approval',
        proposedExecpolicyAmendment: null,
      },
    };

    const response = await ctx.mockJsonRpcClient.receiveServerRequest(serverRequest);

    expect(receivedRequests).toHaveLength(1);
    expect(response).toMatchObject({ decision: 'accept' });
  });
});

describe('CodexAppServerConnector - Dynamic tool call approval', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
    vi.clearAllMocks();
    await startConnectorWithTurn(ctx, 'Use registry tools');
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
    MakaioBus.__resetHandlers?.();
  });

  it('should request dynamic_tool_call_approval_request before executing', async () => {
    const approvalRequests: unknown[] = [];
    ctx.mockBus.on(CodexAppServerNamespace.subjects.dynamic_tool_call_approval_request, (busCtx) => {
      approvalRequests.push(busCtx.payload);
      busCtx.setResult({ decision: 'accept' });
    });

    const executePayloads: unknown[] = [];
    MakaioBus.on(ToolSubjects.execute, (busCtx) => {
      executePayloads.push(busCtx.payload);
      busCtx.setResult({ success: true, data: { result: 'ok' } });
    });

    const serverRequest = {
      id: 300,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-123',
        turnId: 'turn-456',
        itemId: 'item-tool-1',
        name: 'my_tool',
        arguments: { query: 'hello' },
      },
    };

    const response = await ctx.mockJsonRpcClient.receiveServerRequest(serverRequest);

    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({
      itemId: 'item-tool-1',
      name: 'my_tool',
      args: { query: 'hello' },
    });
    expect(executePayloads).toHaveLength(1);
    expect(executePayloads[0]).toMatchObject({
      toolName: 'my_tool',
      input: { query: 'hello' },
    });
    expect(response).toMatchObject({ content: [{ type: 'text' }] });
    const text = (response as { content: [{ text: string }] }).content[0].text;
    expect(JSON.parse(text)).toMatchObject({ result: 'ok' });
  });

  it('should return error content and skip execution when approval is denied', async () => {
    ctx.mockBus.on(CodexAppServerNamespace.subjects.dynamic_tool_call_approval_request, (busCtx) => {
      busCtx.setResult({ decision: 'decline', message: 'Not allowed' });
    });

    const executeRequests: unknown[] = [];
    MakaioBus.on(ToolSubjects.execute, (busCtx) => {
      executeRequests.push(busCtx.payload);
      busCtx.setResult({ success: true, data: {} });
    });

    const serverRequest = {
      id: 301,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-123',
        turnId: 'turn-456',
        itemId: 'item-tool-2',
        name: 'my_tool',
        arguments: { query: 'hello' },
      },
    };

    const response = await ctx.mockJsonRpcClient.receiveServerRequest(serverRequest);

    expect(executeRequests).toHaveLength(0);
    const text = (response as { content: [{ text: string }] }).content[0].text;
    expect(JSON.parse(text)).toMatchObject({ error: 'Not allowed' });
  });

  it('records mcp_call targets in the session tool ledger', async () => {
    const recordCall = vi.fn();
    cleanupConnectorTestContext(ctx);
    ctx = await createConnectorTestContext({
      toolLedger: { recordCall } as never,
    });
    await startConnectorWithTurn(ctx, 'Use registry tools');

    ctx.mockBus.on(CodexAppServerNamespace.subjects.dynamic_tool_call_approval_request, (busCtx) => {
      busCtx.setResult({ decision: 'accept' });
    });

    MakaioBus.on(ToolSubjects.execute, (busCtx) => {
      busCtx.setResult({ success: true, data: { result: 'ok' } });
    });

    await ctx.connector.setCanonicalTurnNumber(9);
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-789' }),
    });

    await ctx.mockJsonRpcClient.receiveServerRequest({
      id: 302,
      method: 'item/tool/call',
      params: {
        threadId: 'thread-123',
        turnId: 'turn-789',
        itemId: 'item-tool-3',
        name: 'mcp_call',
        arguments: { tool: 'github__create_issue', input: { title: 'Bug' } },
      },
    });

    expect(recordCall).toHaveBeenCalledWith('github__create_issue', 9);
  });
});
