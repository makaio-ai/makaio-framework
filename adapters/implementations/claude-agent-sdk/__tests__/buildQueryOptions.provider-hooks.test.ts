import { describe, expect, it, vi } from 'vitest';
import { buildQueryOptions } from '../src/utils/buildQueryOptions.js';
import type { ClaudeSessionConfig } from '../src/types/index.js';
import { SessionLifecycle } from '@makaio/ai-adapters-core';
import type { HookCallback, HookCallbackMatcher, HookJSONOutput, Options } from '@anthropic-ai/claude-agent-sdk';
import { PRE_TOOL_USE_ID, preToolUseInput } from '../src/test/gate-test-helpers.js';

/**
 * Build SDK options for the given config overrides.
 * @param overrides - Config overrides (tool lists, provider config).
 * @returns SDK query options.
 */
function build(overrides: Partial<ClaudeSessionConfig>): Options {
  return buildQueryOptions({
    config: {
      bus: {} as ClaudeSessionConfig['bus'],
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-test',
      cwd: '/tmp',
      model: 'claude-sonnet-4-20250514',
      env: {},
      ...overrides,
    },
    lifecycle: new SessionLifecycle(),
    createToolApprovalHandler: () => undefined,
    sessionId: 'session-test',
  });
}

/**
 * Build options with an allowlist and a single provider PreToolUse matcher, and return the
 * wrapped provider callback.
 * @param providerHook - Provider PreToolUse hook callback.
 * @param allowedTools - Caller allowlist.
 * @returns The wrapped provider hook the SDK would run.
 */
function wrappedProviderHook(
  providerHook: HookCallback,
  allowedTools: string[] = ['shell_exec(git status)'],
): HookCallback {
  const options = build({
    allowedTools,
    providerConfig: { queryOptions: { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [providerHook] }] } } },
  });
  const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
  if (hook === undefined) throw new Error('wrapped provider hook missing');
  return hook;
}

/**
 * Invoke a PreToolUse hook the way the SDK does.
 * @param hook - Hook callback under test.
 * @param toolName - Native tool name of the call.
 * @param toolInput - Tool call input.
 * @returns The hook output.
 */
function callPreToolUse(hook: HookCallback, toolName: string, toolInput: unknown): Promise<HookJSONOutput> {
  return hook(preToolUseInput(toolName, toolInput), PRE_TOOL_USE_ID, { signal: new AbortController().signal });
}

describe('buildQueryOptions — provider PreToolUse hooks under caller lists', () => {
  it('removes a provider allow decision so the call still reaches canUseTool', async () => {
    const providerHook: HookCallback = async () => ({
      systemMessage: 'note',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'provider says yes',
        additionalContext: 'ctx',
      },
    });

    const output = await callPreToolUse(wrappedProviderHook(providerHook), 'Bash', { command: 'git status' });

    expect(output).toEqual({
      systemMessage: 'note',
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'ctx' },
    });
  });

  it('removes a legacy top-level approve decision', async () => {
    const providerHook: HookCallback = async () => ({ decision: 'approve', reason: 'legacy yes' });

    const output = await callPreToolUse(wrappedProviderHook(providerHook), 'Bash', { command: 'git status' });

    expect(output).toEqual({});
  });

  it('passes a provider deny through unchanged', async () => {
    const denyOutput: HookJSONOutput = {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
    };
    const providerHook: HookCallback = async () => denyOutput;

    const output = await callPreToolUse(wrappedProviderHook(providerHook), 'Bash', { command: 'git status' });

    expect(output).toBe(denyOutput);
  });

  it('denies a provider allow whose updatedInput fails the allowlist', async () => {
    const providerHook: HookCallback = async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: 'git push' },
      },
    });

    const output = await callPreToolUse(wrappedProviderHook(providerHook), 'Bash', { command: 'git status' });

    expect(output).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
    const reason = (output as { hookSpecificOutput?: { permissionDecisionReason?: unknown } }).hookSpecificOutput
      ?.permissionDecisionReason;
    expect(typeof reason).toBe('string');
    expect(reason).not.toBe('');
    expect(output).not.toHaveProperty('hookSpecificOutput.updatedInput');
  });

  it('keeps a passing updatedInput and drops the allow decision', async () => {
    const providerHook: HookCallback = async () => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: 'git status' },
      },
    });

    const output = await callPreToolUse(wrappedProviderHook(providerHook), 'Bash', { command: 'git status --short' });

    expect(output).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'git status' } },
    });
  });

  it('passes an async provider output through unchanged', async () => {
    const asyncOutput: HookJSONOutput = { async: true };
    const providerHook: HookCallback = async () => asyncOutput;

    expect(await callPreToolUse(wrappedProviderHook(providerHook), 'Bash', { command: 'git push' })).toBe(asyncOutput);
  });

  it('forwards the SDK arguments to the provider hook and keeps matcher fields', async () => {
    const providerHook = vi.fn<HookCallback>(async () => ({}));
    const options = build({
      allowedTools: ['read_file'],
      providerConfig: {
        queryOptions: { hooks: { PreToolUse: [{ matcher: 'Bash', timeout: 7, hooks: [providerHook] }] } },
      },
    });
    const matcher = options.hooks?.PreToolUse?.[0];
    expect(matcher).toMatchObject({ matcher: 'Bash', timeout: 7 });
    const hook = matcher?.hooks[0];
    if (hook === undefined) throw new Error('wrapped provider hook missing');

    await callPreToolUse(hook, 'Bash', { command: 'ls' });

    expect(providerHook).toHaveBeenCalledTimes(1);
    expect(providerHook.mock.calls[0]?.[0]).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(providerHook.mock.calls[0]?.[1]).toBe(PRE_TOOL_USE_ID);
  });

  it('leaves provider hooks for other events untouched', () => {
    const postToolUse: HookCallbackMatcher[] = [{ hooks: [async () => ({})] }];
    const options = build({
      allowedTools: ['read_file'],
      providerConfig: { queryOptions: { hooks: { PostToolUse: postToolUse } } },
    });

    expect(options.hooks?.PostToolUse).toBe(postToolUse);
  });

  it('returns the provider hooks by reference without caller lists', () => {
    const providerHook: HookCallback = async () => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });
    const providerHooks: Options['hooks'] = { PreToolUse: [{ matcher: 'Bash', hooks: [providerHook] }] };
    const options = build({ providerConfig: { queryOptions: { hooks: providerHooks } } });

    expect(options.hooks).toBe(providerHooks);
    expect(options.hooks?.PreToolUse?.[0]?.hooks[0]).toBe(providerHook);
  });
});
