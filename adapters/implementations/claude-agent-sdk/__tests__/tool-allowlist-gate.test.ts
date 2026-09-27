import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { MakaioBus } from '@makaio/bus-core';
import { ToolNameError } from '@makaio/contracts';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';
import { ClaudeSdkConnector } from '../src/connector.js';
import { ClaudeCodeConnectorNamespace } from '../src/namespace/index.js';
import { ClaudeCodeAdapterName } from '../src/constants.js';
import { createSessionAccountObservationRequester } from '../src/account-observation-requester.js';
import type { ClaudeAgentConfig } from '../src/types/index.js';

/** Tool list options for {@link makeGate}, written with Makaio tool names. */
type GateLists = Pick<ClaudeAgentConfig, 'allowedTools' | 'disallowedTools'>;

/**
 * Build a connector whose central tool approval request (the bus round trip to
 * `ToolApprovalService`) is replaced by a spy that always allows. The unit under test,
 * the connector's real `canUseTool` handler, is left untouched.
 * @param lists - Caller allow/deny lists, written with Makaio tool names.
 * @returns The connector's `canUseTool` handler and the central approval spy.
 * @throws {@link ToolNameError} when a list entry is invalid, mirroring handler creation.
 */
async function makeGate(lists: GateLists): Promise<{
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
    ...(lists.allowedTools !== undefined && { allowedTools: lists.allowedTools }),
    ...(lists.disallowedTools !== undefined && { disallowedTools: lists.disallowedTools }),
  });
  const centralApproval = vi.fn().mockResolvedValue({ action: 'allow' });
  Object.defineProperty(connector, 'requestToolApproval', { value: centralApproval });
  const createHandler = Reflect.get(connector, 'createToolApprovalHandler') as () => CanUseTool;
  return { canUseTool: createHandler.call(connector), centralApproval };
}

/**
 * Invoke a `canUseTool` handler the way the SDK does for one tool call.
 * @param canUseTool - Handler under test.
 * @param toolName - Tool name as the SDK reports it (native Claude vocabulary).
 * @param input - Tool call input the SDK would report.
 * @returns The permission decision.
 */
function callTool(
  canUseTool: CanUseTool,
  toolName: string,
  input: Record<string, unknown> = {},
): Promise<PermissionResult> {
  return canUseTool(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: `tool-use-${toolName}`,
  } as Parameters<CanUseTool>[2]);
}

describe('ClaudeSdkConnector canUseTool — caller allowlist gate', () => {
  it('denies a built-in tool that is not on the allowlist without asking central approval', async () => {
    const { canUseTool, centralApproval } = await makeGate({ allowedTools: ['read_file', 'edit_file'] });

    const result = await callTool(canUseTool, 'Bash');

    expect(result).toEqual({
      behavior: 'deny',
      message: "Tool Bash is not on the step's allowlist",
      interrupt: false,
    });
    expect(centralApproval).not.toHaveBeenCalled();
  });

  it('denies an MCP tool that is not on the allowlist without asking central approval', async () => {
    const { canUseTool, centralApproval } = await makeGate({
      allowedTools: ['read_file', 'mcp__github__get_issue'],
    });

    const result = await callTool(canUseTool, 'mcp__github__create_issue');

    expect(result).toMatchObject({ behavior: 'deny', message: expect.stringContaining('mcp__github__create_issue') });
    expect(centralApproval).not.toHaveBeenCalled();
  });

  it('denies every tool, built-in and MCP, for an empty allowlist', async () => {
    const { canUseTool, centralApproval } = await makeGate({ allowedTools: [] });

    expect(await callTool(canUseTool, 'Read')).toMatchObject({ behavior: 'deny' });
    expect(await callTool(canUseTool, 'mcp__makaio__search')).toMatchObject({ behavior: 'deny' });
    expect(centralApproval).not.toHaveBeenCalled();
  });

  it('passes allowlisted built-in and MCP tools on to central approval', async () => {
    const { canUseTool, centralApproval } = await makeGate({
      allowedTools: ['read_file', 'mcp__github__get_issue'],
    });

    expect(await callTool(canUseTool, 'Read')).toMatchObject({ behavior: 'allow' });
    expect(await callTool(canUseTool, 'mcp__github__get_issue')).toMatchObject({ behavior: 'allow' });
    expect(centralApproval).toHaveBeenCalledTimes(2);
    expect(centralApproval.mock.calls.map(([, payload]) => (payload as { toolName: string }).toolName)).toEqual([
      'Read',
      'mcp__github__get_issue',
    ]);
  });

  it('leaves approval unchanged when no allowlist is given', async () => {
    const { canUseTool, centralApproval } = await makeGate({});

    expect(await callTool(canUseTool, 'Bash')).toMatchObject({ behavior: 'allow' });
    expect(centralApproval).toHaveBeenCalledOnce();
  });

  it('allows an exact shell_exec command rule and denies a different command', async () => {
    const { canUseTool, centralApproval } = await makeGate({ allowedTools: ['shell_exec(git status)'] });

    expect(await callTool(canUseTool, 'Bash', { command: 'git status' })).toMatchObject({ behavior: 'allow' });
    expect(await callTool(canUseTool, 'Bash', { command: 'git push' })).toMatchObject({
      behavior: 'deny',
      message: "Tool Bash is not on the step's allowlist",
    });
    expect(centralApproval).toHaveBeenCalledOnce();
  });

  it('denies a shell_exec prefix rule command chained with a shell operator', async () => {
    const { canUseTool, centralApproval } = await makeGate({ allowedTools: ['shell_exec(git log:*)'] });

    const result = await callTool(canUseTool, 'Bash', { command: 'git log && rm -rf /' });

    expect(result).toMatchObject({
      behavior: 'deny',
      message: "Tool Bash is not on the step's allowlist",
    });
    expect(centralApproval).not.toHaveBeenCalled();
  });

  it('denies a shell_exec command chained with a shell operator under an exact allow rule', async () => {
    const { canUseTool, centralApproval } = await makeGate({ allowedTools: ['shell_exec(git status)'] });

    const result = await callTool(canUseTool, 'Bash', { command: 'git status; git push' });

    expect(result).toMatchObject({
      behavior: 'deny',
      message: "Tool Bash is not on the step's allowlist",
    });
    expect(centralApproval).not.toHaveBeenCalled();
  });

  it('denies an approver-rewritten input that falls outside the allowed command rule', async () => {
    const { canUseTool, centralApproval } = await makeGate({ allowedTools: ['shell_exec(git status)'] });
    centralApproval.mockResolvedValueOnce({ action: 'allow', updatedInput: { command: 'git push' } });

    const result = await callTool(canUseTool, 'Bash', { command: 'git status' });

    expect(result).toMatchObject({
      behavior: 'deny',
      message: "Tool Bash is not on the step's allowlist",
    });
    expect(centralApproval).toHaveBeenCalledOnce();
  });

  it('allows an approver-rewritten input that still satisfies the allowed command rule', async () => {
    const { canUseTool, centralApproval } = await makeGate({ allowedTools: ['shell_exec(git status)'] });
    centralApproval.mockResolvedValueOnce({
      action: 'allow',
      updatedInput: { command: 'git status', extra: true },
    });

    const result = await callTool(canUseTool, 'Bash', { command: 'git status' });

    expect(result).toMatchObject({ behavior: 'allow', updatedInput: { command: 'git status', extra: true } });
  });

  it('does not forward updatedPermissions from central approval while a caller tool list exists', async () => {
    const { canUseTool, centralApproval } = await makeGate({ allowedTools: ['read_file'] });
    centralApproval.mockResolvedValueOnce({
      action: 'allow',
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow' }],
    });

    const result = await callTool(canUseTool, 'Read');

    expect(result).toMatchObject({ behavior: 'allow' });
    expect(result).not.toHaveProperty('updatedPermissions');
  });

  it('forwards updatedPermissions from central approval when no caller tool list is given', async () => {
    const { canUseTool, centralApproval } = await makeGate({});
    const updatedPermissions = [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow' }];
    centralApproval.mockResolvedValueOnce({ action: 'allow', updatedPermissions });

    const result = await callTool(canUseTool, 'Bash');

    expect(result).toMatchObject({ behavior: 'allow', updatedPermissions });
  });

  it('lets a shell_exec denylist rule beat a plain shell_exec allowlist entry', async () => {
    const { canUseTool, centralApproval } = await makeGate({
      allowedTools: ['shell_exec'],
      disallowedTools: ['shell_exec(git push:*)'],
    });

    expect(await callTool(canUseTool, 'Bash', { command: 'git status' })).toMatchObject({ behavior: 'allow' });
    const denied = await callTool(canUseTool, 'Bash', { command: 'git push' });
    expect(denied).toMatchObject({
      behavior: 'deny',
      message: "Tool Bash is denied by the step's denylist entry shell_exec(git push:*)",
    });
    expect(centralApproval).toHaveBeenCalledOnce();
  });

  it('throws ToolNameError when the allowlist carries a native Claude name instead of a Makaio name', async () => {
    await expect(makeGate({ allowedTools: ['Read'] })).rejects.toThrow(ToolNameError);
  });
});
