/**
 * Claude Code probe contract.
 *
 * Native response shapes are not written here — they are rendered by
 * `renderClaudeCodeNativeResponse`, the same function the client's
 * `hook.handle` composer uses at runtime. This module only chooses which
 * effects a scenario contributes and how the resulting native behavior is
 * observed.
 * @packageDocumentation
 */

import type { CanonicalEffect, ProviderContributionEnvelope } from '@makaio/contracts/client';
import {
  CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES,
  clientDefinition,
} from '../../../../clients/claude-code/src/definition.js';
import {
  createApproveEffect,
  createDenyEffect,
} from '../../../../clients/claude-code/src/runtime/hook-response-contracts.js';
import { renderClaudeCodeNativeResponse } from '../../../../clients/claude-code/src/runtime/hook-response-composer.js';
import {
  CLAUDE_CODE_HOOK_POST_COMPACT,
  CLAUDE_CODE_HOOK_PRE_COMPACT,
  CLAUDE_CODE_HOOK_POST_TOOL_USE,
  CLAUDE_CODE_HOOK_PRE_TOOL_USE,
  CLAUDE_CODE_HOOK_SUBAGENT_START,
  CLAUDE_CODE_HOOK_SUBAGENT_STOP,
} from '../../../../clients/claude-code/src/runtime/schemas.js';
import {
  CONTEXT_VALUE,
  contextAppendScenario,
  DEFAULT_ALLOWED_TOOLS,
  DENY_REASON,
  MCP_TOOL_PROMPT,
  NO_TOOL_MARKER_ALLOWED_TOOLS,
  SUBAGENT_CONTEXT_VALUE,
  TOOL_MARKER,
  type ClientProbeContract,
  type ProbeEffectScenario,
} from '../probe-contract.js';
import { PROBE_MCP_SERVER_NAME, PROBE_MCP_SERVER_PATH, PROBE_TOOL_NAME } from '../probe-mcp-server.js';

/** Native tool that spawns a subagent, plus the ordinary scenario tools. */
const SUBAGENT_ALLOWED_TOOLS = ['Agent', ...DEFAULT_ALLOWED_TOOLS] as const;

/**
 * Prompt that makes the parent spawn one subagent and report the token it read.
 *
 * The relay is what makes the oracle sound. The scenario configures a hook on
 * `SubagentStart` alone, so the marker exists nowhere in the parent's own
 * context; if it reaches the parent's final response, it travelled there inside
 * the subagent's report, which is exactly the claim under test.
 *
 * Phrasing matters more here than anywhere else in this file. Asking a parent
 * to relay a subagent's answer *verbatim*, or to have a subagent "follow the
 * instruction in its own context", is the shape of a prompt-injection probe,
 * and Claude refuses it outright — the probe then measures the refusal, not the
 * binary. Handing a subagent an identifying token and asking what it received
 * is an ordinary request, and it is also exactly what a consumer exercises with
 * this capability.
 *
 * The subagent gets a concrete errand — a shell read of the probe file — before
 * it reports. Without one, the account's default model (claude-haiku-4-5 on
 * 2.1.283) answered in one turn without calling `Agent`, so `SubagentStart`
 * never fired. The same prompt serves the `PostToolUse` subagent scenario,
 * whose token enters the subagent's context only after that read.
 */
const SUBAGENT_RELAY_PROMPT =
  'Use the Agent tool to run a general-purpose subagent and ask it to run `cat MAKAIO_PROBE.md` with the Bash tool and then report the probe session token from its own context. Then reply with the token it reports.';

/**
 * Prompt that spawns one subagent on an ordinary errand.
 *
 * A subagent event cannot be observed without a subagent, and the generic
 * "exercise SubagentStop if available" prompt only produces one when the model
 * happens to choose the Agent tool — which it did once and then did not, moving
 * the committed evidence for a bus-mapped event between runs for no reason.
 */
const SUBAGENT_SPAWN_PROMPT =
  'Use the Agent tool to run a general-purpose subagent that reads MAKAIO_PROBE.md and reports which provider it names.';

/**
 * Conversation the compaction scenarios build before they compact it.
 *
 * The seed has to leave more behind than one exchange. Pinned 2.1.219 answers
 * `/compact` on a two-message session with "Not enough messages to compact.":
 * `PreCompact` fires, compaction then aborts, and `PostCompact` is never
 * reached. A seed that runs a tool leaves the tool call and its result in the
 * transcript as well, and that session compacts for real — `PostCompact`
 * arrives carrying `compact_summary`.
 *
 * It names the exact shell command so the tool call matches the scenario's own
 * pre-approved read tool instead of depending on how the model phrases one.
 */
const COMPACTION_SEED_PROMPT =
  'MAKAIO_PROBE_MARKER: use the shell tool to run `cat MAKAIO_PROBE.md`, then summarize the file in one sentence.';

/**
 * Render one native Claude Code sentinel from the client's own renderer.
 * @param eventName - Native hook event being exercised.
 * @param effects - Effects the scenario contributes.
 * @returns Native response body written to stdout by the capture shim.
 */
function sentinel(eventName: string, effects: ReadonlyArray<CanonicalEffect | ProviderContributionEnvelope>): string {
  return renderClaudeCodeNativeResponse(eventName, effects).stdout;
}

/**
 * Prompt that makes the model read the probe file through the native `Read` tool.
 *
 * The harness default for `PostToolUse` asks for a shell read, which is the
 * Codex tool surface. Claude's built-in file tool is `Read`, and it is the
 * tool the scenario's hook matcher selects.
 */
const READ_TOOL_PROMPT = 'MAKAIO_PROBE_MARKER: use the Read tool to read MAKAIO_PROBE.md, then reply probe-ack.';

/**
 * Build the context-append probe shape for one event.
 *
 * The sentinel contributes context alone, on `PreToolUse` too: a context-only
 * response renders no permission decision, and the scenario's tool is
 * pre-approved under the dontAsk policy, so it still runs and the appended
 * context can reach the final response.
 *
 * `SubagentStart` appends to a context the parent never sees, so its scenario
 * has to create a subagent and route the subagent's own words back out; the
 * default marker-only prompt would leave the event unreached.
 *
 * `PostToolUse` reads the probe file through Claude's own `Read` tool, and its
 * hook matches that tool only.
 * @param eventName - Native hook event being exercised.
 * @returns Context-consumption probe shape.
 */
function contextScenario(eventName: string): ProbeEffectScenario {
  const isSubagentStart = eventName === CLAUDE_CODE_HOOK_SUBAGENT_START;
  return contextAppendScenario(
    sentinel(eventName, [{ kind: 'context.append', value: isSubagentStart ? SUBAGENT_CONTEXT_VALUE : CONTEXT_VALUE }]),
    {
      suffix: 'context-append',
      ...(isSubagentStart && {
        description: 'Attempts to seed a spawned subagent with hook-appended context it must repeat back.',
        prompt: SUBAGENT_RELAY_PROMPT,
        allowedTools: SUBAGENT_ALLOWED_TOOLS,
      }),
      ...(eventName === CLAUDE_CODE_HOOK_POST_TOOL_USE && {
        description: 'Attempts to append context after a built-in Read tool call.',
        prompt: READ_TOOL_PROMPT,
        allowedTools: ['Read', ...DEFAULT_ALLOWED_TOOLS],
        hookMatcher: 'Read',
      }),
    },
  );
}

/**
 * Additional `PostToolUse` context-append attempts on the other native tool paths.
 *
 * An MCP tool call and a tool call made inside a subagent reach `PostToolUse`
 * through different code in the binary than a built-in tool call in the main
 * session, so each is proven on its own. Both hooks match only the tool the
 * scenario is about.
 * @returns The MCP and subagent probe shapes.
 */
function postToolUseExtraContextScenarios(): readonly ProbeEffectScenario[] {
  const eventName = CLAUDE_CODE_HOOK_POST_TOOL_USE;
  return [
    contextAppendScenario(sentinel(eventName, [{ kind: 'context.append', value: CONTEXT_VALUE }]), {
      suffix: 'mcp-context-append',
      description: 'Attempts to append context after an MCP tool call.',
      prompt: MCP_TOOL_PROMPT,
      allowedTools: [`mcp__${PROBE_MCP_SERVER_NAME}__${PROBE_TOOL_NAME}`],
      hookMatcher: `mcp__${PROBE_MCP_SERVER_NAME}__.*`,
      // 2.1.283 defers MCP tools behind ToolSearch unless the server is marked alwaysLoad, which costs the turn budget.
      mcpServers: { [PROBE_MCP_SERVER_NAME]: { command: 'bun', args: [PROBE_MCP_SERVER_PATH], alwaysLoad: true } },
    }),
    // The parent only calls `Agent`, so a `Bash` matcher fires for the
    // subagent's read alone, and the captured payload carries `agent_id`.
    contextAppendScenario(sentinel(eventName, [{ kind: 'context.append', value: SUBAGENT_CONTEXT_VALUE }]), {
      suffix: 'subagent-context-append',
      description: 'Attempts to append context after a tool call made inside a spawned subagent.',
      prompt: SUBAGENT_RELAY_PROMPT,
      allowedTools: SUBAGENT_ALLOWED_TOOLS,
      hookMatcher: 'Bash',
      // The Bash matcher alone also passes if the parent runs `cat` itself; `agent_id` is present only in subagent tool hooks (Claude Code hooks docs).
      requiredPayloadKeys: ['agent_id'],
    }),
  ];
}

/**
 * Unapproved-tool negative control, carrying a context-only `PreToolUse` sentinel.
 *
 * Proves two things at once. Under the dontAsk policy Claude refuses a tool
 * that is not pre-approved, so the marker the prompt asks for stays absent; and
 * a sentinel that contributes context alone does not change that, because it
 * renders no `permissionDecision`. A composer that defaulted such a response to
 * `allow` would authorize the tool, the marker would appear, and this scenario
 * would fail.
 *
 * It rides the `context.append` effect path rather than being a baseline:
 * baselines inject no sentinel by rule, and this claim needs one.
 * @returns The negative-control probe shape.
 */
function preToolUseUnapprovedToolNegativeControl(): ProbeEffectScenario {
  return {
    suffix: 'unapproved-tool-negative-control',
    description:
      'Proves Claude dontAsk leaves the marker absent when the hook response appends context and makes no permission decision.',
    sentinelOutput: sentinel(CLAUDE_CODE_HOOK_PRE_TOOL_USE, [{ kind: 'context.append', value: CONTEXT_VALUE }]),
    oracle: 'native-must-deny-unapproved-tool',
    allowedTools: NO_TOOL_MARKER_ALLOWED_TOOLS,
    expectedAbsentMarker: TOOL_MARKER,
  };
}

/** Claude Code probe contract consumed by the scenario generator. */
export const claudeCodeProbeContract: ClientProbeContract = {
  clientId: 'claude-code',
  definition: clientDefinition,

  scenarioForEffect(eventName, effect) {
    if (effect === 'context.append') return contextScenario(eventName);

    if (effect === CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES.approve) {
      return {
        suffix: 'approve',
        sentinelOutput: sentinel(eventName, [createApproveEffect()]),
        oracle: 'sentinel-must-allow-tool',
        allowedTools: NO_TOOL_MARKER_ALLOWED_TOOLS,
        expectedPresentMarker: TOOL_MARKER,
      };
    }

    if (effect === CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES.deny) {
      return {
        suffix: 'deny',
        sentinelOutput: sentinel(eventName, [createDenyEffect(DENY_REASON)]),
        oracle: 'sentinel-must-block-tool',
        allowedTools: DEFAULT_ALLOWED_TOOLS,
        expectedAbsentMarker: TOOL_MARKER,
      };
    }

    throw new Error(`No Claude Code probe shape for effect '${effect}' on '${eventName}'`);
  },

  extraEffectScenarios(eventName, effect) {
    if (effect !== 'context.append') return [];
    if (eventName === CLAUDE_CODE_HOOK_PRE_TOOL_USE) return [preToolUseUnapprovedToolNegativeControl()];
    if (eventName === CLAUDE_CODE_HOOK_POST_TOOL_USE) return postToolUseExtraContextScenarios();
    return [];
  },

  observationScenario(eventName) {
    if (eventName === CLAUDE_CODE_HOOK_SUBAGENT_STOP) {
      return {
        suffix: 'observation',
        description: 'Spawns one subagent so the completion event is reached deterministically.',
        prompt: SUBAGENT_SPAWN_PROMPT,
        allowedTools: SUBAGENT_ALLOWED_TOOLS,
        // The prompt makes the subagent, so the event is reachable by
        // construction and the capture is the point: `unobserved` would also
        // pass a recapture in which no subagent ran and nothing fired.
        oracle: 'capture-only',
      };
    }

    // `/compact` is the only compaction trigger a bounded probe can reach: the
    // other one, auto-compaction, is gated on CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    // whose documented minimum is 100k tokens — out of reach in a synthetic
    // workspace.
    //
    // It also cannot be issued on its own. `/compact` is a local command, so
    // print mode runs it with no model turn, and pinned 2.1.219 answers an
    // empty session with an empty result in zero turns: compaction returns
    // before either hook, because there is nothing to compact. That is what an
    // earlier capture recorded, and it was misread as isolation silencing the
    // command. The isolated configuration directory is not involved: the same
    // binary, flags and hook file behave identically in both. What flips the
    // outcome is a registered SessionStart hook — its invocation is itself
    // enough conversation for `/compact` to proceed as far as PreCompact — and
    // an operator's own directory tends to have one where this harness, which
    // configures exactly the event under test, never does.
    //
    // So the scenario seeds a conversation first and compacts that. Both hooks
    // then fire on their own terms and neither declares a response capability,
    // which is exactly what `capture-only` records.
    if (eventName !== CLAUDE_CODE_HOOK_PRE_COMPACT && eventName !== CLAUDE_CODE_HOOK_POST_COMPACT) return undefined;
    return {
      suffix: 'observation',
      description: 'Compacts a seeded conversation, the only compaction trigger a bounded probe can reach.',
      seedPrompt: COMPACTION_SEED_PROMPT,
      prompt: '/compact',
      oracle: 'capture-only',
    };
  },
};
