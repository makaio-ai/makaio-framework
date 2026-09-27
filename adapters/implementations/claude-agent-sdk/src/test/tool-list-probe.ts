import { readFileSync } from 'node:fs';
import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
  Options,
} from '@anthropic-ai/claude-agent-sdk';
import { SessionLifecycle } from '@makaio/ai-adapters-core';
import { toNativeToolName } from '@makaio/contracts';
import { buildQueryOptions } from '../utils/buildQueryOptions.js';
import { createGateConnector, preToolUseInput } from './gate-test-helpers.js';
import type { GateConnectorLists } from './gate-test-helpers.js';

/** Options for {@link createToolListProbe}; tool lists use Makaio tool names. */
export interface ToolListProbeOptions {
  /** Makaio-named tool allowlist, or `undefined` when unrestricted. */
  readonly allowedTools?: readonly string[];
  /** Makaio-named tool denylist, or `undefined` when none is given. */
  readonly disallowedTools?: readonly string[];
  /**
   * Inject provider config that would bypass the gate: `queryOptions.allowedTools`
   * `['Bash', 'Read']` and `permissionMode: 'bypassPermissions'` with
   * `allowDangerouslySkipPermissions: true` (the FACT-72 live setup).
   */
  readonly withBypassingProviderConfig?: boolean;
  /**
   * Provider-config PreToolUse hook answering every call with `allow`, optionally
   * rewriting a shell call's command (claude: one `queryOptions.hooks.PreToolUse` matcher
   * without `matcher`, whose callback returns `permissionDecision: 'allow'` and, with
   * `rewriteCommand`, `updatedInput: { command }`).
   */
  readonly providerPreToolUseHook?: {
    readonly decision: 'allow';
    readonly rewriteCommand?: string;
  };
  /** Provider-config enablement of every skill (claude: `queryOptions.skills: 'all'`). */
  readonly providerSkills?: 'all';
}

/** One tool call in the adapter's native shape. */
export interface ToolListProbeCall {
  /** Native tool name as the SDK reports it. */
  readonly name: string;
  /** Native tool call input. */
  readonly input: Record<string, unknown>;
}

/** Central approval answer for one probed call, stated semantically. */
export interface ToolListProbeApproval {
  /** Replace the shell call's command (claude: `updatedInput: { command }`). */
  readonly rewriteCommand?: string;
  /** Ask to always allow the tool (claude: `updatedPermissions` adding a session allow rule). */
  readonly alwaysAllow?: true;
}

/** Outcome of one probed tool call through the adapter's per-call gate. */
export interface ToolListProbeGateResult {
  /** Whether the SDK was told to run the call. */
  allowed: boolean;
  /** Deny message, when denied; diagnostic only, never part of the contract's assertions. */
  reason?: string;
  /** Whether the central tool approval was asked for this call. */
  centralApprovalCalled: boolean;
  /** Whether the result would install persistent SDK permission rules. */
  persistsRules: boolean;
}

/** Adapter view of a resolved tool list, as consumed by the tool-list conformance suite. */
export interface ToolListProbe {
  /**
   * Translate a Makaio or MCP tool name into the adapter's native name.
   * @param makaioOrMcpName - Makaio tool name or `mcp__<server>__<tool>`.
   * @returns The native tool name.
   */
  nativeName(makaioOrMcpName: string): string;
  /** Built-in tools offered to the model (SDK `Options.tools`), `'all'` when unrestricted. */
  readonly availableBuiltIns: readonly string[] | 'all';
  /**
   * Build a shell call (claude: `Bash` with `{ command }`).
   * @param command - Shell command line.
   * @returns The native call.
   */
  shellCall(command: string): ToolListProbeCall;
  /**
   * Build a file read call (claude: `Read` with `{ file_path }`).
   * @param path - File path to read.
   * @returns The native call.
   */
  readCall(path: string): ToolListProbeCall;
  /**
   * Build a skill call (claude: `Skill` with `{ skill }`); the skill tool has no Makaio name.
   * @param skill - Skill name.
   * @returns The native call.
   */
  skillCall?(skill: string): ToolListProbeCall;
  /**
   * Run one tool call through the gate the SDK receives.
   * @param call - Native tool call.
   * @param approval - Central approval answer for this call; plain `allow` when omitted.
   * @returns The gate outcome.
   */
  gate(call: ToolListProbeCall, approval?: ToolListProbeApproval): Promise<ToolListProbeGateResult>;
}

/**
 * Claude Agent SDK version whose bundled Claude Code CLI permission pipeline `gate()`
 * models; the branches it models were verified live against this version in FACT-72.
 */
const MODELLED_SDK_VERSION = '0.2.131';

/**
 * Fail unless the adapter still pins the SDK version `gate()` was verified against. The
 * SDK's `exports` has no `./package.json`, so the adapter's own devDependency pin is the
 * deterministic source; a bump turns into a failing suite until `gate()` is re-verified.
 * @throws When the pinned SDK version differs from {@link MODELLED_SDK_VERSION}.
 */
function assertModelledSdkVersion(): void {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    devDependencies?: Record<string, string>;
  };
  const pinned = manifest.devDependencies?.['@anthropic-ai/claude-agent-sdk'];
  if (pinned !== MODELLED_SDK_VERSION) {
    throw new Error(
      `tool-list probe: gate() models @anthropic-ai/claude-agent-sdk ${MODELLED_SDK_VERSION}, but the adapter ` +
        `pins ${String(pinned)}; re-verify gate() against the bundled CLI before updating MODELLED_SDK_VERSION`,
    );
  }
}

/**
 * Throw for a permission-pipeline branch `gate()` does not model.
 * @param branch - The unmodelled branch.
 * @returns Never.
 * @throws Always.
 */
function notModelled(branch: string): never {
  throw new Error(`tool-list probe: gate(): ${branch} not modelled`);
}

/**
 * Build the provider-config query options the probe options ask for.
 * @param options - Probe options.
 * @returns Provider `queryOptions`, or `undefined` when none are requested.
 */
function buildProviderQueryOptions(options: ToolListProbeOptions): Options | undefined {
  const { providerPreToolUseHook: hookAnswer, providerSkills } = options;
  const hook: HookCallback | undefined =
    hookAnswer === undefined
      ? undefined
      : () =>
          Promise.resolve({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: hookAnswer.decision,
              permissionDecisionReason: `provider hook: ${hookAnswer.decision}`,
              ...(hookAnswer.rewriteCommand !== undefined && { updatedInput: { command: hookAnswer.rewriteCommand } }),
            },
          });
  const queryOptions: Options = {
    ...(options.withBypassingProviderConfig === true && {
      allowedTools: ['Bash', 'Read'],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
    }),
    ...(hook !== undefined && { hooks: { PreToolUse: [{ hooks: [hook] }] } }),
    ...(providerSkills !== undefined && { skills: providerSkills }),
  };
  return Object.keys(queryOptions).length > 0 ? queryOptions : undefined;
}

/** Combined outcome of the PreToolUse hooks for one call. */
interface PreToolUseOutcome {
  /** Combined decision, if any hook returned one. */
  decision?: 'allow' | 'deny';
  /** Reason attached to the first deny. */
  reason?: string;
  /** Input that runs: the last rewrite from an allow or no-decision hook, else the original input. */
  input: Record<string, unknown>;
}

/**
 * Run the PreToolUse callbacks for one call and combine their outputs like the bundled
 * Claude Code CLI does. The SDK itself only forwards the matchers (as `hookCallbackIds`
 * plus `matcher`) to the CLI; matching and combination happen in the CLI. Modelled, as
 * verified live in FACT-72: every callback sees the original input; a `deny` wins over
 * any `allow` regardless of order; `updatedInput` applies from `allow` and no-decision
 * hooks and is dropped from `deny` hooks. Everything else throws: a matcher pattern
 * (only absent, empty, and `*` are modelled), `ask`, `defer`, legacy top-level
 * `decision`, and async outputs.
 * @param matchers - `hooks.PreToolUse` from the built query options.
 * @param toolName - Native tool name.
 * @param input - Tool call input.
 * @param permissionMode - Session permission mode the CLI reports to hooks.
 * @returns The combined outcome.
 */
async function runPreToolUseHooks(
  matchers: readonly HookCallbackMatcher[],
  toolName: string,
  input: Record<string, unknown>,
  permissionMode: NonNullable<Options['permissionMode']>,
): Promise<PreToolUseOutcome> {
  const outcome: PreToolUseOutcome = { input };
  const hookInput = preToolUseInput(toolName, input, permissionMode);
  for (const matcher of matchers) {
    if (matcher.matcher !== undefined && matcher.matcher !== '' && matcher.matcher !== '*') {
      notModelled(`PreToolUse matcher pattern '${matcher.matcher}'`);
    }
    for (const hook of matcher.hooks) {
      const output: HookJSONOutput = await hook(hookInput, hookInput.tool_use_id, {
        signal: new AbortController().signal,
      });
      if ('async' in output) notModelled('async hook output');
      if (output.decision !== undefined) notModelled(`legacy hook decision '${output.decision}'`);
      const specific = output.hookSpecificOutput;
      if (specific?.hookEventName !== 'PreToolUse') continue;
      const { permissionDecision, permissionDecisionReason, updatedInput } = specific;
      if (permissionDecision === 'ask' || permissionDecision === 'defer') {
        notModelled(`hook permissionDecision '${permissionDecision}'`);
      }
      if (permissionDecision === 'deny') {
        if (outcome.decision !== 'deny') outcome.reason = permissionDecisionReason;
        outcome.decision = 'deny';
        continue;
      }
      if (permissionDecision === 'allow' && outcome.decision === undefined) outcome.decision = 'allow';
      if (updatedInput !== undefined) outcome.input = updatedInput;
    }
  }
  return outcome;
}

/**
 * SDK auto-approval rules for the query: `allowedTools` plus the `Skill` entry the SDK
 * appends from `skills: 'all'` before spawning the CLI. A skill list (the SDK appends
 * `Skill(<name>)` per name) is not used by the suite and throws.
 * @param queryOptions - The built query options.
 * @returns Auto-approval rules; calls matching one skip `canUseTool`.
 */
function sdkAutoApprovedRules(queryOptions: Options): readonly string[] {
  const { skills } = queryOptions;
  if (Array.isArray(skills)) notModelled('skills list');
  return [...(queryOptions.allowedTools ?? []), ...(skills === 'all' ? ['Skill'] : [])];
}

/**
 * Whether an SDK auto-approval rule covers a call. Models bare tool names only; rule
 * contents such as `Bash(git status)` throw.
 * @param rules - Auto-approval rules from {@link sdkAutoApprovedRules}.
 * @param toolName - Native tool name.
 * @returns Whether the call skips `canUseTool`.
 */
function isAutoApproved(rules: readonly string[], toolName: string): boolean {
  return rules.some((rule) => {
    if (rule.includes('(')) notModelled(`auto-approval rule content '${rule}'`);
    return rule === toolName;
  });
}

/** Result of one `ToolListProbe.gate` call, before central-approval bookkeeping. */
type GateVerdict = Pick<ToolListProbeGateResult, 'allowed' | 'reason'> & { persistsRules?: boolean };

/**
 * Build a tool-list probe for the Claude Agent SDK adapter.
 *
 * Constructs a real `ClaudeSdkConnector` whose central tool approval (the bus
 * round trip) is replaced by a counting closure that allows, takes the session config
 * from the connector's own `buildSessionConfig()` (what `start()` hands to the session),
 * and feeds it with the connector's real `canUseTool` factory into the real
 * `buildQueryOptions`, so the probe reads what the SDK would receive. Residual gap:
 * `ClaudeConnectorSession.createQuery` forwards that config unchanged plus the session
 * id, resume/fork directives, MCP server port, and response schema, none of which touch
 * the tool lists; that forwarding is not exercised here.
 *
 * `gate(...)` models the bundled Claude Code CLI 0.2.131 permission pipeline for the
 * branches this suite uses, verified live in FACT-72 (SDK 0.2.131): the PreToolUse
 * callbacks (provider hooks as wrapped by `buildQueryOptions`, then the adapter-owned
 * policy hook), combined as in {@link runPreToolUseHooks}; a hook `deny` stops the call;
 * a hook `allow`, an SDK auto-approval (`allowedTools` plus `skills`-derived `Skill`
 * rules), and `permissionMode: 'bypassPermissions'` each skip `canUseTool`; otherwise
 * `canUseTool` decides. Branches that were not verified throw `not modelled`: a hook
 * `allow` or an auto-approval or bypass mode next to `disallowedTools` deny rules (the
 * CLI re-checks deny and ask rules after those), permission modes other than `'default'`
 * and `'bypassPermissions'` (the latter only with `allowDangerouslySkipPermissions`),
 * and the hook branches listed at {@link runPreToolUseHooks}. Settings-file rules and
 * hooks (`settingSources`) are not part of the query options and are not modelled.
 * @param options - Caller tool lists and provider-config switches.
 * @returns The probe.
 * @throws {@link ToolNameError} When a list entry is invalid.
 * @throws When the adapter's SDK pin is not the modelled version.
 */
export async function createToolListProbe(options: ToolListProbeOptions): Promise<ToolListProbe> {
  assertModelledSdkVersion();
  const vocabulary = 'claude';
  const providerQueryOptions = buildProviderQueryOptions(options);
  const lists: GateConnectorLists = {
    ...(options.allowedTools !== undefined && { allowedTools: [...options.allowedTools] }),
    ...(options.disallowedTools !== undefined && { disallowedTools: [...options.disallowedTools] }),
    ...(providerQueryOptions !== undefined && { providerConfig: { queryOptions: providerQueryOptions } }),
  };

  let pendingApproval: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } | undefined;
  let centralCalls = 0;
  const centralApproval = (): Promise<unknown> => {
    centralCalls += 1;
    return Promise.resolve({ action: 'allow', ...pendingApproval });
  };
  /**
   * Map a semantic approval answer onto the central approval payload for one call.
   * @param call - The probed call.
   * @param approval - Semantic approval answer.
   * @returns The native `updatedInput` / `updatedPermissions` overrides.
   */
  const toNativeApproval = (
    call: ToolListProbeCall,
    approval: ToolListProbeApproval | undefined,
  ): typeof pendingApproval => ({
    ...(approval?.rewriteCommand !== undefined && {
      updatedInput: { ...call.input, command: approval.rewriteCommand },
    }),
    ...(approval?.alwaysAllow === true && {
      updatedPermissions: [
        { type: 'addRules', rules: [{ toolName: call.name }], behavior: 'allow', destination: 'session' },
      ],
    }),
  });
  const { createToolApprovalHandler, buildSessionConfig } = await createGateConnector(lists, centralApproval);

  const queryOptions = buildQueryOptions({
    config: buildSessionConfig(),
    lifecycle: new SessionLifecycle(),
    createToolApprovalHandler,
    sessionId: 'session-probe',
  });
  const { canUseTool } = queryOptions;
  if (canUseTool === undefined) throw new Error('buildQueryOptions produced no canUseTool gate');
  const preToolUseMatchers = queryOptions.hooks?.PreToolUse ?? [];
  const autoApproved = sdkAutoApprovedRules(queryOptions);
  const permissionMode = queryOptions.permissionMode ?? 'default';
  const hasDenyRules = (queryOptions.disallowedTools?.length ?? 0) > 0;
  if (permissionMode !== 'default' && permissionMode !== 'bypassPermissions') {
    notModelled(`permissionMode '${permissionMode}'`);
  }
  if (permissionMode === 'bypassPermissions' && queryOptions.allowDangerouslySkipPermissions !== true) {
    notModelled("permissionMode 'bypassPermissions' without allowDangerouslySkipPermissions");
  }

  /**
   * Walk the modelled pipeline for one call.
   * @param nativeName - Native tool name.
   * @param input - Tool call input.
   * @returns The verdict.
   */
  const decide = async (nativeName: string, input: Record<string, unknown>): Promise<GateVerdict> => {
    const hooked = await runPreToolUseHooks(preToolUseMatchers, nativeName, input, permissionMode);
    if (hooked.decision === 'deny') return { allowed: false, reason: hooked.reason };
    const skipsCanUseTool =
      hooked.decision === 'allow' || isAutoApproved(autoApproved, nativeName) || permissionMode === 'bypassPermissions';
    if (skipsCanUseTool) {
      if (hasDenyRules) notModelled('canUseTool skip next to disallowedTools deny rules');
      return { allowed: true };
    }
    const result = await canUseTool(nativeName, hooked.input, {
      signal: new AbortController().signal,
      toolUseID: `tool-use-${nativeName}`,
    } as Parameters<CanUseTool>[2]);
    return result.behavior === 'allow'
      ? { allowed: true, persistsRules: result.updatedPermissions !== undefined }
      : { allowed: false, reason: result.message };
  };

  return {
    nativeName: (name) => toNativeToolName(vocabulary, name),
    availableBuiltIns: queryOptions.tools === undefined ? 'all' : (queryOptions.tools as readonly string[]),
    shellCall: (command) => ({ name: toNativeToolName(vocabulary, 'shell_exec'), input: { command } }),
    readCall: (path) => ({ name: toNativeToolName(vocabulary, 'read_file'), input: { file_path: path } }),
    skillCall: (skill) => ({ name: 'Skill', input: { skill } }),
    async gate(call, approval) {
      pendingApproval = toNativeApproval(call, approval);
      const before = centralCalls;
      const { persistsRules = false, ...verdict } = await decide(call.name, call.input);
      return { ...verdict, centralApprovalCalled: centralCalls > before, persistsRules };
    },
  };
}
