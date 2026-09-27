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
import type { ToolVocabulary } from '@makaio/contracts';
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
   * Provider-config PreToolUse hook answering every call (claude: one
   * `queryOptions.hooks.PreToolUse` matcher without `matcher`, whose callback returns
   * `permissionDecision` and `updatedInput` as given).
   */
  readonly providerPreToolUseHook?: {
    readonly decision?: 'allow' | 'deny' | 'ask';
    readonly updatedInput?: Record<string, unknown>;
  };
  /** Provider-config skill enablement (claude: `queryOptions.skills`). */
  readonly providerSkills?: 'all' | readonly string[];
}

/** Outcome of one probed tool call through the adapter's per-call gate. */
export interface ToolListProbeGateResult {
  /** Whether the SDK was told to run the call. */
  allowed: boolean;
  /** Deny message, when denied. */
  reason?: string;
  /** Whether the central tool approval was asked for this call. */
  centralApprovalCalled: boolean;
  /** Whether the result would install persistent SDK permission rules. */
  persistsRules: boolean;
}

/** Adapter view of a resolved tool list, as consumed by the tool-list conformance suite. */
export interface ToolListProbe {
  /** Native tool vocabulary of the adapter. */
  readonly vocabulary: ToolVocabulary;
  /**
   * Translate a Makaio or MCP tool name into the adapter's native name.
   * @param makaioOrMcpName - Makaio tool name or `mcp__<server>__<tool>`.
   * @returns The native tool name.
   */
  nativeName(makaioOrMcpName: string): string;
  /** Native name of the skill tool, when the adapter has one (claude: `Skill`); it has no Makaio name. */
  readonly skillToolName?: string;
  /** Built-in tools offered to the model (SDK `Options.tools`), `'all'` when unrestricted. */
  readonly availableBuiltIns: readonly string[] | 'all';
  /** Settings that would skip the per-call gate (claude: SDK `allowedTools` plus `skills`-derived `Skill` rules). */
  readonly bypass: { autoApproved: readonly string[]; permissionModeBypasses: boolean };
  /**
   * Run one tool call through the gate the SDK receives.
   * @param nativeName - Native tool name as the SDK reports it.
   * @param input - Tool call input.
   * @param approval - Central approval answer overrides for this call.
   * @returns The gate outcome.
   */
  gate(
    nativeName: string,
    input: Record<string, unknown>,
    approval?: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] },
  ): Promise<ToolListProbeGateResult>;
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
              ...(hookAnswer.decision !== undefined && {
                permissionDecision: hookAnswer.decision,
                permissionDecisionReason: `provider hook: ${hookAnswer.decision}`,
              }),
              ...(hookAnswer.updatedInput !== undefined && { updatedInput: { ...hookAnswer.updatedInput } }),
            },
          });
  const queryOptions: Options = {
    ...(options.withBypassingProviderConfig === true && {
      allowedTools: ['Bash', 'Read'],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
    }),
    ...(hook !== undefined && { hooks: { PreToolUse: [{ hooks: [hook] }] } }),
    ...(providerSkills !== undefined && {
      skills: providerSkills === 'all' ? ('all' as const) : [...providerSkills],
    }),
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
 * SDK auto-approval rules for the query: `allowedTools` plus the `Skill` entries the SDK
 * appends from the `skills` option before spawning the CLI (`'all'` adds `Skill`, a list
 * adds `Skill(<name>)` per name).
 * @param queryOptions - The built query options.
 * @returns Auto-approval rules; calls matching one skip `canUseTool`.
 */
function sdkAutoApprovedRules(queryOptions: Options): readonly string[] {
  const { skills } = queryOptions;
  const skillRules = skills === undefined ? [] : skills === 'all' ? ['Skill'] : skills.map((name) => `Skill(${name})`);
  return [...(queryOptions.allowedTools ?? []), ...skillRules];
}

/**
 * Whether an SDK auto-approval rule covers a call. Models a bare tool name and
 * `Skill(<name>)` against the `skill` input; other rule contents throw.
 * @param rules - Auto-approval rules from {@link sdkAutoApprovedRules}.
 * @param toolName - Native tool name.
 * @param input - Tool call input after hook rewrites.
 * @returns Whether the call skips `canUseTool`.
 */
function isAutoApproved(rules: readonly string[], toolName: string, input: Record<string, unknown>): boolean {
  return rules.some((rule) => {
    if (rule === toolName) return true;
    if (/^Skill\(.+\)$/.test(rule)) return toolName === 'Skill' && rule === `Skill(${String(input.skill)})`;
    if (rule.includes('(')) notModelled(`auto-approval rule content '${rule}'`);
    return false;
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
  const vocabulary: ToolVocabulary = 'claude';
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
      hooked.decision === 'allow' ||
      isAutoApproved(autoApproved, nativeName, hooked.input) ||
      permissionMode === 'bypassPermissions';
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
    vocabulary,
    nativeName: (name) => toNativeToolName(vocabulary, name),
    skillToolName: 'Skill',
    availableBuiltIns: queryOptions.tools === undefined ? 'all' : (queryOptions.tools as readonly string[]),
    bypass: {
      autoApproved,
      permissionModeBypasses: permissionMode !== 'default',
    },
    async gate(nativeName, input, approval) {
      pendingApproval = approval;
      const before = centralCalls;
      const { persistsRules = false, ...verdict } = await decide(nativeName, input);
      return { ...verdict, centralApprovalCalled: centralCalls > before, persistsRules };
    },
  };
}
