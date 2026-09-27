import os from 'node:os';
import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookJSONOutput,
  Options,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { MakaioBus } from '@makaio/bus-core';
import { SessionLifecycle } from '@makaio/ai-adapters-core';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';
import { toNativeToolName } from '@makaio/contracts';
import type { ResolvedToolPolicy, ToolVocabulary } from '@makaio/contracts';
import { ClaudeSdkConnector } from '../connector.js';
import { ClaudeCodeConnectorNamespace } from '../namespace/index.js';
import { ClaudeCodeAdapterName } from '../constants.js';
import { createSessionAccountObservationRequester } from '../account-observation-requester.js';
import { buildQueryOptions } from '../utils/buildQueryOptions.js';
import type { ClaudeSessionConfig } from '../types/index.js';

/** Options for {@link createToolListProbe}; tool lists use Makaio tool names. */
export interface ToolListProbeOptions {
  /** Makaio-named tool allowlist, or `undefined` when unrestricted. */
  readonly allowedTools?: readonly string[];
  /** Makaio-named tool denylist, or `undefined` when none is given. */
  readonly disallowedTools?: readonly string[];
  /**
   * Inject provider config that would bypass the gate: `queryOptions.allowedTools`
   * `['Bash', 'Read']` and `permissionMode: 'bypassPermissions'`.
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
    }),
    ...(hook !== undefined && { hooks: { PreToolUse: [{ hooks: [hook] }] } }),
    ...(providerSkills !== undefined && {
      skills: providerSkills === 'all' ? ('all' as const) : [...providerSkills],
    }),
  };
  return Object.keys(queryOptions).length > 0 ? queryOptions : undefined;
}

/**
 * Whether a PreToolUse matcher applies to a tool, per Claude Code hook matcher semantics
 * (the SDK typings only say "string pattern, e.g. tool names like `Write`"): an absent,
 * empty, or `*` matcher matches every tool; a pattern of only word characters and `|` is
 * an exact name or `|`-separated name list; anything else is a regular expression.
 * @param matcher - The matcher's `matcher` pattern.
 * @param toolName - Native tool name.
 * @returns Whether the matcher's callbacks run for this tool.
 */
function matcherApplies(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[\w|]+$/.test(matcher)) return matcher.split('|').includes(toolName);
  return new RegExp(matcher).test(toolName);
}

/** Combined outcome of the PreToolUse hooks for one call. */
interface PreToolUseOutcome {
  /** Most restrictive decision any hook returned, if any. */
  decision?: 'allow' | 'deny' | 'ask';
  /** Reason attached to that decision. */
  reason?: string;
  /** Input after hook rewrites; the original input when no hook rewrote it. */
  input: Record<string, unknown>;
}

/** Decision precedence across hooks: the most restrictive decision wins. */
const DECISION_RANK = { allow: 1, ask: 2, deny: 3 } as const;

/**
 * Run the PreToolUse matchers the SDK would run for one call, in order, and combine them
 * the way the SDK does: every applicable callback sees the original input, the most
 * restrictive decision wins (deny before ask before allow; `defer` and no decision count as none),
 * a legacy `decision: 'approve' | 'block'` counts as allow / deny, and the last
 * `updatedInput` is the input that runs.
 * @param matchers - `hooks.PreToolUse` from the built query options.
 * @param toolName - Native tool name.
 * @param input - Tool call input.
 * @returns The combined outcome.
 */
async function runPreToolUseHooks(
  matchers: readonly HookCallbackMatcher[],
  toolName: string,
  input: Record<string, unknown>,
): Promise<PreToolUseOutcome> {
  const outcome: PreToolUseOutcome = { input };
  const hookInput: PreToolUseHookInput = {
    hook_event_name: 'PreToolUse',
    session_id: 'session-probe',
    transcript_path: '',
    cwd: os.tmpdir(),
    tool_name: toolName,
    tool_input: input,
    tool_use_id: `tool-use-${toolName}`,
  };
  const consider = (decision: 'allow' | 'deny' | 'ask', reason: string | undefined): void => {
    if (outcome.decision !== undefined && DECISION_RANK[outcome.decision] >= DECISION_RANK[decision]) return;
    outcome.decision = decision;
    outcome.reason = reason;
  };
  for (const matcher of matchers) {
    if (!matcherApplies(matcher.matcher, toolName)) continue;
    for (const hook of matcher.hooks) {
      const output: HookJSONOutput = await hook(hookInput, hookInput.tool_use_id, {
        signal: new AbortController().signal,
      });
      if ('async' in output) continue;
      if (output.decision === 'approve') consider('allow', output.reason);
      if (output.decision === 'block') consider('deny', output.reason);
      const specific = output.hookSpecificOutput;
      if (specific?.hookEventName !== 'PreToolUse') continue;
      const { permissionDecision, permissionDecisionReason, updatedInput } = specific;
      if (permissionDecision !== undefined && permissionDecision !== 'defer') {
        consider(permissionDecision, permissionDecisionReason);
      }
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
 * `Skill(<name>)` against the `skill` input; other rule contents are not modelled.
 * @param rules - Auto-approval rules from {@link sdkAutoApprovedRules}.
 * @param toolName - Native tool name.
 * @param input - Tool call input after hook rewrites.
 * @returns Whether the call skips `canUseTool`.
 */
function isAutoApproved(rules: readonly string[], toolName: string, input: Record<string, unknown>): boolean {
  return rules.some((rule) => rule === toolName || (toolName === 'Skill' && rule === `Skill(${String(input.skill)})`));
}

/**
 * Build a tool-list probe for the Claude Agent SDK adapter.
 *
 * Constructs a real {@link ClaudeSdkConnector} whose central tool approval (the bus
 * round trip) is replaced by a counting closure that allows, then feeds the connector's
 * real `canUseTool` factory into the real `buildQueryOptions`, so the probe reads what
 * the SDK would receive. `gate(...)` replays the SDK's per-call order on those options:
 * every applicable `hooks.PreToolUse` callback (provider hooks as wrapped by
 * `buildQueryOptions`, then the adapter-owned policy hook), then SDK auto-approval
 * (`allowedTools` plus `skills`-derived `Skill` rules), then `canUseTool`. A hook
 * `deny` stops the call; a hook `allow` or an auto-approval skips `canUseTool`.
 * Settings-file rules and hooks (`settingSources`) are not part of the query options
 * and are not modelled.
 * @param options - Caller tool lists and provider-config switches.
 * @returns The probe.
 * @throws {@link ToolNameError} When a list entry is invalid.
 */
export async function createToolListProbe(options: ToolListProbeOptions): Promise<ToolListProbe> {
  const vocabulary: ToolVocabulary = 'claude';
  const bus = await ClaudeCodeConnectorNamespace.scopedBus();
  const providerQueryOptions = buildProviderQueryOptions(options);
  const lists: Pick<ClaudeSessionConfig, 'allowedTools' | 'disallowedTools' | 'providerConfig'> = {
    ...(options.allowedTools !== undefined && { allowedTools: [...options.allowedTools] }),
    ...(options.disallowedTools !== undefined && { disallowedTools: [...options.disallowedTools] }),
    ...(providerQueryOptions !== undefined && { providerConfig: { queryOptions: providerQueryOptions } }),
  };
  const identity = {
    bus,
    adapterId: 'adapter-probe',
    adapterName: ClaudeCodeAdapterName,
    agentId: 'agent-probe',
    model: 'claude-sonnet-4-20250514',
    cwd: os.tmpdir(),
    env: {},
  };
  const connector = new ClaudeSdkConnector({
    ...identity,
    ...lists,
    clientId: claudeClientDefinition.id,
    requestSessionAccountObservation: createSessionAccountObservationRequester(MakaioBus),
  });
  // Mirrors the connector's session config for the fields buildQueryOptions reads.
  const sessionConfig: ClaudeSessionConfig = { ...identity, ...lists };

  let pendingApproval: { updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } | undefined;
  let centralCalls = 0;
  const centralApproval = (): Promise<unknown> => {
    centralCalls += 1;
    return Promise.resolve({ action: 'allow', ...pendingApproval });
  };
  Object.defineProperty(connector, 'requestToolApproval', { value: centralApproval });
  const createHandler = Reflect.get(connector, 'createToolApprovalHandler') as (
    policy: ResolvedToolPolicy,
  ) => CanUseTool;

  const lifecycle = new SessionLifecycle();
  const queryOptions = buildQueryOptions({
    config: sessionConfig,
    lifecycle,
    createToolApprovalHandler: (policy) => createHandler.call(connector, policy),
    sessionId: 'session-probe',
  });
  const { canUseTool } = queryOptions;
  if (canUseTool === undefined) throw new Error('buildQueryOptions produced no canUseTool gate');
  const preToolUseMatchers = queryOptions.hooks?.PreToolUse ?? [];
  const autoApproved = sdkAutoApprovedRules(queryOptions);

  return {
    vocabulary,
    nativeName: (name) => toNativeToolName(vocabulary, name),
    skillToolName: 'Skill',
    availableBuiltIns: queryOptions.tools === undefined ? 'all' : (queryOptions.tools as readonly string[]),
    bypass: {
      autoApproved,
      permissionModeBypasses: queryOptions.permissionMode !== undefined && queryOptions.permissionMode !== 'default',
    },
    async gate(nativeName, input, approval) {
      pendingApproval = approval;
      const before = centralCalls;
      const central = (): boolean => centralCalls > before;
      try {
        const hooked = await runPreToolUseHooks(preToolUseMatchers, nativeName, input);
        if (hooked.decision === 'deny') {
          return { allowed: false, reason: hooked.reason, centralApprovalCalled: central(), persistsRules: false };
        }
        // A hook `allow` and SDK `allowedTools` (auto-approval) both skip `canUseTool`.
        if (hooked.decision === 'allow' || isAutoApproved(autoApproved, nativeName, hooked.input)) {
          return { allowed: true, centralApprovalCalled: central(), persistsRules: false };
        }
        const result = await canUseTool(nativeName, hooked.input, {
          signal: new AbortController().signal,
          toolUseID: `tool-use-${nativeName}`,
        } as Parameters<CanUseTool>[2]);
        return result.behavior === 'allow'
          ? {
              allowed: true,
              centralApprovalCalled: central(),
              persistsRules: result.updatedPermissions !== undefined,
            }
          : {
              allowed: false,
              reason: result.message,
              centralApprovalCalled: central(),
              persistsRules: false,
            };
      } finally {
        pendingApproval = undefined;
      }
    },
  };
}
