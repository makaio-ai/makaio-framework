import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { MakaioBus } from '@makaio/bus-core';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';
import { ClaudeSdkConnector } from '../src/connector.js';
import { ClaudeCodeConnectorNamespace } from '../src/namespace/index.js';
import { ClaudeCodeAdapterName } from '../src/constants.js';
import { createSessionAccountObservationRequester } from '../src/account-observation-requester.js';

/**
 * Build a connector whose central tool approval request (the bus round trip to
 * `ToolApprovalService`) is replaced by a spy that always allows. The unit under test,
 * the connector's real `canUseTool` handler, is left untouched.
 * @param allowedTools - Caller allowlist, or `undefined` for none.
 * @returns The connector's `canUseTool` handler and the central approval spy.
 */
async function makeGate(allowedTools: string[] | undefined): Promise<{
  canUseTool: CanUseTool;
  centralApproval: ReturnType<typeof vi.fn>;
}> {
  const bus = await ClaudeCodeConnectorNamespace.scopedBus();
  const connector = new ClaudeSdkConnector({
    bus,
    adapterId: 'adapter-test',
    adapterName: ClaudeCodeAdapterName,
    agentId: 'agent-test',
    model: 'claude-sonnet-4-20250514',
    cwd: os.tmpdir(),
    env: {},
    clientId: claudeClientDefinition.id,
    requestSessionAccountObservation: createSessionAccountObservationRequester(MakaioBus),
    ...(allowedTools !== undefined && { allowedTools }),
  });
  const centralApproval = vi.fn().mockResolvedValue({ action: 'allow' });
  Object.defineProperty(connector, 'requestToolApproval', { value: centralApproval });
  const createHandler = Reflect.get(connector, 'createToolApprovalHandler') as () => CanUseTool;
  return { canUseTool: createHandler.call(connector), centralApproval };
}

/**
 * Invoke a `canUseTool` handler the way the SDK does for one tool call.
 * @param canUseTool - Handler under test.
 * @param toolName - Tool name as the SDK reports it.
 * @returns The permission decision.
 */
function callTool(canUseTool: CanUseTool, toolName: string): Promise<PermissionResult> {
  return canUseTool(toolName, { any: 'input' }, {
    signal: new AbortController().signal,
    toolUseID: `tool-use-${toolName}`,
  } as Parameters<CanUseTool>[2]);
}

describe('ClaudeSdkConnector canUseTool — caller allowlist gate', () => {
  it('denies a built-in tool that is not on the allowlist without asking central approval', async () => {
    const { canUseTool, centralApproval } = await makeGate(['Read', 'Edit']);

    const result = await callTool(canUseTool, 'Bash');

    expect(result).toEqual({
      behavior: 'deny',
      message: "Tool Bash is not on the step's allowlist",
      interrupt: false,
    });
    expect(centralApproval).not.toHaveBeenCalled();
  });

  it('denies an MCP tool that is not on the allowlist without asking central approval', async () => {
    const { canUseTool, centralApproval } = await makeGate(['Read', 'mcp__github__get_issue']);

    const result = await callTool(canUseTool, 'mcp__github__create_issue');

    expect(result).toMatchObject({ behavior: 'deny', message: expect.stringContaining('mcp__github__create_issue') });
    expect(centralApproval).not.toHaveBeenCalled();
  });

  it('denies every tool, built-in and MCP, for an empty allowlist', async () => {
    const { canUseTool, centralApproval } = await makeGate([]);

    expect(await callTool(canUseTool, 'Read')).toMatchObject({ behavior: 'deny' });
    expect(await callTool(canUseTool, 'mcp__makaio__search')).toMatchObject({ behavior: 'deny' });
    expect(centralApproval).not.toHaveBeenCalled();
  });

  it('passes allowlisted built-in and MCP tools on to central approval', async () => {
    const { canUseTool, centralApproval } = await makeGate(['Read', 'mcp__github__get_issue']);

    expect(await callTool(canUseTool, 'Read')).toMatchObject({ behavior: 'allow' });
    expect(await callTool(canUseTool, 'mcp__github__get_issue')).toMatchObject({ behavior: 'allow' });
    expect(centralApproval).toHaveBeenCalledTimes(2);
    expect(centralApproval.mock.calls.map(([, payload]) => (payload as { toolName: string }).toolName)).toEqual([
      'Read',
      'mcp__github__get_issue',
    ]);
  });

  it('leaves approval unchanged when no allowlist is given', async () => {
    const { canUseTool, centralApproval } = await makeGate(undefined);

    expect(await callTool(canUseTool, 'Bash')).toMatchObject({ behavior: 'allow' });
    expect(centralApproval).toHaveBeenCalledOnce();
  });
});
