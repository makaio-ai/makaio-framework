import { describe, expect, it, vi } from 'vitest';
import { buildQueryOptions } from '../src/utils/buildQueryOptions.js';
import type { ClaudeSessionConfig } from '../src/types/index.js';
import { SessionLifecycle } from '@makaio/ai-adapters-core';
import { ToolNameError } from '@makaio/contracts';
import type { ResolvedToolPolicy } from '@makaio/contracts';
import type {
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
  Options,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Minimal `ClaudeSessionConfig` fixture for `buildQueryOptions` unit tests.
 * Only populates fields required to produce a well-formed `Options` object.
 * @param overrides - Partial config fields to override defaults.
 */
function makeMinimalConfig(overrides: Partial<ClaudeSessionConfig> = {}): ClaudeSessionConfig {
  return {
    bus: {} as ClaudeSessionConfig['bus'],
    adapterId: 'adapter-test',
    adapterName: 'claude-agent-sdk',
    agentId: 'agent-test',
    cwd: '/tmp',
    model: 'claude-sonnet-4-20250514',
    env: {},
    ...overrides,
  };
}

/**
 * Minimal `SessionLifecycle` stub — only `onAbort` is exercised by `buildQueryOptions`.
 * Uses a real instance so the return type is satisfied without unsafe casts.
 */
function makeLifecycleStub(): SessionLifecycle {
  return new SessionLifecycle();
}

describe('buildQueryOptions — responseSchema behaviour', () => {
  it('passes response schema descriptor schema to SDK outputFormat', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
      responseSchema: { schema: { type: 'object' }, name: 'object_schema' },
    });

    expect(options.outputFormat).toEqual({ type: 'json_schema', schema: { type: 'object' } });
  });

  it('omits outputFormat when responseSchema is not provided', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options).not.toHaveProperty('outputFormat');
  });
});

describe('buildQueryOptions — resume behaviour', () => {
  it('omits sessionId when resuming an existing SDK session', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'local-session-id',
      resumeAdapterSessionId: 'provider-session-id',
      responseSchema: { schema: { type: 'object' }, name: 'object_schema' },
    });

    expect(options.resume).toBe('provider-session-id');
    expect(options).not.toHaveProperty('sessionId');
  });
});

describe('buildQueryOptions — native fork behaviour', () => {
  it('tip fork: emits resume + forkSession:true, no sessionId', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'local-session-id',
      nativeFork: {
        sourceSessionId: 'makaio-source',
        sourceAdapterSessionId: 'provider-source',
      },
    });

    expect(options.resume).toBe('provider-source');
    expect(options.forkSession).toBe(true);
    expect(options).not.toHaveProperty('sessionId');
    expect(options).not.toHaveProperty('resumeSessionAt');
  });

  it('mid-history fork: emits resume + resumeSessionAt + forkSession:true, no sessionId', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'local-session-id',
      nativeFork: {
        sourceSessionId: 'makaio-source',
        sourceAdapterSessionId: 'provider-source',
        forkPointMessageId: 'msg-checkpoint',
      },
    });

    expect(options.resume).toBe('provider-source');
    expect(options.resumeSessionAt).toBe('msg-checkpoint');
    expect(options.forkSession).toBe(true);
    expect(options).not.toHaveProperty('sessionId');
  });

  it('nativeFork takes precedence over resumeAdapterSessionId', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'local-session-id',
      resumeAdapterSessionId: 'ignored-resume',
      nativeFork: {
        sourceSessionId: 'makaio-source',
        sourceAdapterSessionId: 'provider-source',
      },
    });

    expect(options.resume).toBe('provider-source');
    expect(options.forkSession).toBe(true);
  });
});

describe('buildQueryOptions — persistSession behaviour', () => {
  it('defaults persistSession to true when not configured', () => {
    const config = makeMinimalConfig();
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options.persistSession).toBe(true);
  });

  it('disables persistSession for ephemeral agents regardless of providerConfig override', () => {
    const config = makeMinimalConfig({
      ephemeral: true,
      providerConfig: {
        queryOptions: {
          persistSession: true,
        },
      },
    });
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options.persistSession).toBe(false);
  });

  it('respects an explicit persistSession: false override for non-ephemeral agents', () => {
    const config = makeMinimalConfig({
      providerConfig: {
        queryOptions: {
          persistSession: false,
        },
      },
    });
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options.persistSession).toBe(false);
  });
});

describe('buildQueryOptions — maxThinkingTokens behaviour', () => {
  it('omits maxThinkingTokens when reasoningEffort is not configured', () => {
    const config = makeMinimalConfig(); // no reasoningEffort
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options).not.toHaveProperty('maxThinkingTokens');
  });

  it('omits maxThinkingTokens when reasoningEffort is "none"', () => {
    const config = makeMinimalConfig({ reasoningEffort: 'none' });
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options).not.toHaveProperty('maxThinkingTokens');
  });

  it.each([
    ['low', 4000],
    ['medium', 8000],
    ['high', 16000],
    ['extra-high', 32000],
  ] as const)('reasoningEffort "%s" sets maxThinkingTokens to %i', (level, expectedTokens) => {
    const config = makeMinimalConfig({ reasoningEffort: level });
    const options = buildQueryOptions({
      config,
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });

    expect(options.maxThinkingTokens).toBe(expectedTokens);
  });
});

describe('buildQueryOptions — tool policy behaviour', () => {
  /**
   * Build SDK options for a config carrying the given tool policy.
   * @param overrides - Tool policy fields (and any other config overrides).
   * @returns SDK query options.
   */
  function buildWithToolPolicy(overrides: Partial<ClaudeSessionConfig>) {
    return buildQueryOptions({
      config: makeMinimalConfig(overrides),
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });
  }

  it('leaves tools, allowedTools and disallowedTools unset when no policy is given', () => {
    const options = buildWithToolPolicy({});

    expect(options).not.toHaveProperty('tools');
    expect(options).not.toHaveProperty('allowedTools');
    expect(options).not.toHaveProperty('disallowedTools');
  });

  it('keeps provider-config tool options when no policy is given', () => {
    const options = buildWithToolPolicy({
      providerConfig: { queryOptions: { tools: ['Read'], allowedTools: ['Read'] } },
    });

    expect(options.tools).toEqual(['Read']);
    expect(options.allowedTools).toEqual(['Read']);
  });

  it('maps a Makaio allowlist entry to the native built-in tool', () => {
    const options = buildWithToolPolicy({ allowedTools: ['read_file'] });

    expect(options.tools).toEqual(['Read']);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('restricts available tools without auto-approving them when an allowlist is given', () => {
    const allowlist = ['read_file', 'edit_file', 'write_file', 'glob_files', 'grep_files'];
    const options = buildWithToolPolicy({ allowedTools: allowlist });

    expect(options.tools).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
    expect(options).not.toHaveProperty('disallowedTools');
  });

  it('keeps MCP allowlist entries out of the built-in tool set', () => {
    const options = buildWithToolPolicy({ allowedTools: ['read_file', 'mcp__makaio__search'] });

    expect(options.tools).toEqual(['Read']);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('accepts a command-specific permission rule on shell_exec and makes its base tool available, without auto-approving it', () => {
    const options = buildWithToolPolicy({ allowedTools: ['shell_exec(git status)'] });

    expect(options.tools).toEqual(['Bash']);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('rejects native Claude tool names in the allowlist', () => {
    expect(() => buildWithToolPolicy({ allowedTools: ['Read'] })).toThrow(ToolNameError);
  });

  it('rejects WebFetch in the allowlist', () => {
    expect(() => buildWithToolPolicy({ allowedTools: ['WebFetch'] })).toThrow(ToolNameError);
  });

  it('rejects command-specific permission rules on tools other than shell_exec', () => {
    expect(() => buildWithToolPolicy({ allowedTools: ['read_file(x)'] })).toThrow(ToolNameError);
  });

  it('deduplicates allowlist entries', () => {
    const options = buildWithToolPolicy({ allowedTools: ['read_file', 'edit_file', 'read_file'] });

    expect(options.tools).toEqual(['Read', 'Edit']);
  });

  it('replaces provider-config tools with the caller allowlist and drops provider auto-approvals outside it', () => {
    const options = buildWithToolPolicy({
      allowedTools: ['read_file'],
      providerConfig: { queryOptions: { tools: ['Bash', 'Read'], allowedTools: ['Bash'] } },
    });

    expect(options.tools).toEqual(['Read']);
    expect(options.allowedTools).toEqual([]);
  });

  it('clears all provider-config auto-approvals for an explicitly empty allowlist', () => {
    const options = buildWithToolPolicy({
      allowedTools: [],
      providerConfig: { queryOptions: { allowedTools: ['Read', 'Bash(git status)'] } },
    });

    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('clears provider-config auto-approvals when only a denylist is given', () => {
    const options = buildWithToolPolicy({
      disallowedTools: ['write_file'],
      providerConfig: { queryOptions: { allowedTools: ['Bash', 'Read'] } },
    });

    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('disables all built-in tools for an explicitly empty allowlist', () => {
    const options = buildWithToolPolicy({ allowedTools: [] });

    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('forces permissionMode to default when the provider config sets bypassPermissions and the caller passes a list', () => {
    const options = buildWithToolPolicy({
      allowedTools: ['read_file'],
      providerConfig: { queryOptions: { permissionMode: 'bypassPermissions' } },
    });

    expect(options.permissionMode).toBe('default');
    expect(options.allowedTools).toEqual([]);
  });

  it('forces permissionMode to default when the provider config sets acceptEdits and the caller passes a denylist', () => {
    const options = buildWithToolPolicy({
      disallowedTools: ['write_file'],
      providerConfig: { queryOptions: { permissionMode: 'acceptEdits' } },
    });

    expect(options.permissionMode).toBe('default');
    expect(options.allowedTools).toEqual([]);
  });

  it('leaves provider-config permissionMode and allowedTools untouched without caller lists', () => {
    const options = buildWithToolPolicy({
      providerConfig: { queryOptions: { permissionMode: 'bypassPermissions', allowedTools: ['Read'] } },
    });

    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.allowedTools).toEqual(['Read']);
  });

  it('forwards disallowedTools permission rules verbatim without restricting the available tool set', () => {
    const options = buildWithToolPolicy({ disallowedTools: ['write_file', 'shell_exec(rm:*)'] });

    expect(options.disallowedTools).toEqual(['Write', 'Bash(rm:*)']);
    expect(options).not.toHaveProperty('tools');
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('translates a denylist prefix rule to a native permission rule', () => {
    const options = buildWithToolPolicy({ disallowedTools: ['shell_exec(rm -rf:*)'] });

    expect(options.disallowedTools).toEqual(['Bash(rm -rf:*)']);
  });

  it('routes allowlisted tools through the canUseTool approval handler', () => {
    const approvalHandler: NonNullable<Options['canUseTool']> = async () => ({ behavior: 'deny', message: 'no' });
    const options = buildQueryOptions({
      config: makeMinimalConfig({ allowedTools: ['read_file'] }),
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => approvalHandler,
      sessionId: 'session-test',
    });

    expect(options.canUseTool).toBe(approvalHandler);
  });
});

describe('buildQueryOptions — tool policy PreToolUse hook', () => {
  /** Provider PreToolUse hook that never decides. */
  const providerPreToolUseHook: HookCallback = async () => ({});
  /** Provider PostToolUse hook that never decides. */
  const providerPostToolUseHook: HookCallback = async () => ({});

  /**
   * Build SDK options for the given config overrides.
   * @param overrides - Config overrides (tool lists, provider config).
   * @returns SDK query options.
   */
  function build(overrides: Partial<ClaudeSessionConfig>): Options {
    return buildQueryOptions({
      config: makeMinimalConfig(overrides),
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler: () => undefined,
      sessionId: 'session-test',
    });
  }

  /**
   * Extract the adapter-owned policy hook: the single callback of the last PreToolUse matcher.
   * @param options - SDK query options built with caller tool lists.
   * @returns The policy hook callback.
   */
  function policyHookOf(options: Options): HookCallback {
    const matchers = options.hooks?.PreToolUse ?? [];
    const policyMatcher = matchers.at(-1);
    expect(policyMatcher?.hooks).toHaveLength(1);
    const hook = policyMatcher?.hooks[0];
    if (hook === undefined) throw new Error('policy hook missing');
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
    const input: PreToolUseHookInput = {
      session_id: 'session-test',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp',
      permission_mode: 'default',
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'toolu-test',
    };
    return hook(input, 'toolu-test', { signal: new AbortController().signal });
  }

  /**
   * Assert a hook output is a PreToolUse deny with a non-empty reason.
   * @param output - Hook output.
   */
  function expectDeny(output: HookJSONOutput): void {
    expect(output).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
    const reason = (output as { hookSpecificOutput?: { permissionDecisionReason?: unknown } }).hookSpecificOutput
      ?.permissionDecisionReason;
    expect(typeof reason).toBe('string');
    expect(reason).not.toBe('');
  }

  it('leaves provider hooks untouched without caller lists', () => {
    const providerHooks: Options['hooks'] = {
      PreToolUse: [{ matcher: 'Bash', hooks: [providerPreToolUseHook] }],
      PostToolUse: [{ hooks: [providerPostToolUseHook] }],
    };
    const options = build({ providerConfig: { queryOptions: { hooks: providerHooks } } });

    expect(options.hooks).toBe(providerHooks);
    expect(options.hooks?.PreToolUse).toHaveLength(1);
  });

  it('emits no hooks without caller lists when the provider config has none', () => {
    const options = build({});

    expect(options).not.toHaveProperty('hooks');
  });

  it('appends the matcherless policy matcher after provider PreToolUse matchers and keeps other events', () => {
    const firstProviderMatcher: HookCallbackMatcher = { matcher: 'Bash', hooks: [providerPreToolUseHook] };
    const secondProviderMatcher: HookCallbackMatcher = { hooks: [providerPreToolUseHook] };
    const postToolUse: HookCallbackMatcher[] = [{ hooks: [providerPostToolUseHook] }];
    const options = build({
      allowedTools: ['read_file'],
      providerConfig: {
        queryOptions: {
          hooks: { PreToolUse: [firstProviderMatcher, secondProviderMatcher], PostToolUse: postToolUse },
        },
      },
    });

    const preToolUse = options.hooks?.PreToolUse ?? [];
    expect(preToolUse).toHaveLength(3);
    // Provider matchers are wrapped copies (see buildQueryOptions.provider-hooks.test.ts).
    expect(preToolUse[0]).toMatchObject({ matcher: 'Bash' });
    expect(preToolUse[0]?.hooks).toHaveLength(1);
    expect(preToolUse[1]).not.toHaveProperty('matcher');
    expect(preToolUse[1]?.hooks).toHaveLength(1);
    expect(preToolUse[2]).not.toHaveProperty('matcher');
    expect(preToolUse[2]?.hooks[0]).not.toBe(providerPreToolUseHook);
    expect(options.hooks?.PostToolUse).toBe(postToolUse);
  });

  it('denies an MCP tool outside the allowlist and passes an allowlisted built-in with an empty output', async () => {
    const hook = policyHookOf(build({ allowedTools: ['read_file'] }));

    expectDeny(await callPreToolUse(hook, 'mcp__claude_ai_Foo__bar', {}));

    const passOutput = await callPreToolUse(hook, 'Read', { file_path: '/tmp/a.txt' });
    expect(passOutput).toEqual({});
    expect(passOutput).not.toHaveProperty('hookSpecificOutput');
  });

  it('denies a Skill call the allowlist does not cover', async () => {
    const hook = policyHookOf(build({ allowedTools: ['read_file'] }));

    expectDeny(await callPreToolUse(hook, 'Skill', { skill: 'x' }));
  });

  it('enforces a denylist command rule even with provider skills enabled', async () => {
    const options = build({
      disallowedTools: ['shell_exec(git push:*)'],
      providerConfig: { queryOptions: { skills: 'all' } },
    });
    const hook = policyHookOf(options);

    expectDeny(await callPreToolUse(hook, 'Bash', { command: 'git push origin' }));
    expect(await callPreToolUse(hook, 'Bash', { command: 'git status' })).toEqual({});
  });

  it('denies a Bash call with a non-object input when a denylist command rule targets Bash', async () => {
    const hook = policyHookOf(build({ disallowedTools: ['shell_exec(rm -rf:*)'] }));

    expectDeny(await callPreToolUse(hook, 'Bash', 'rm -rf /'));
  });

  it('hands the resolved policy to createToolApprovalHandler and overrides provider bypasses with caller lists', () => {
    const createToolApprovalHandler = vi.fn((_policy: ResolvedToolPolicy): Options['canUseTool'] => undefined);
    const options = buildQueryOptions({
      config: makeMinimalConfig({
        allowedTools: ['read_file'],
        providerConfig: { queryOptions: { permissionMode: 'bypassPermissions', allowedTools: ['Bash'] } },
      }),
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler,
      sessionId: 'session-test',
    });

    expect(createToolApprovalHandler).toHaveBeenCalledTimes(1);
    const policy = createToolApprovalHandler.mock.calls[0]?.[0];
    expect(policy?.restricts).toBe(true);
    expect(policy?.checkToolCall('Read', {})).toEqual({ allowed: true });
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe('default');
  });

  it('hands a non-restricting policy to createToolApprovalHandler without caller lists', () => {
    const createToolApprovalHandler = vi.fn((_policy: ResolvedToolPolicy): Options['canUseTool'] => undefined);
    buildQueryOptions({
      config: makeMinimalConfig(),
      lifecycle: makeLifecycleStub(),
      createToolApprovalHandler,
      sessionId: 'session-test',
    });

    expect(createToolApprovalHandler).toHaveBeenCalledTimes(1);
    expect(createToolApprovalHandler.mock.calls[0]?.[0]?.restricts).toBe(false);
  });
});
