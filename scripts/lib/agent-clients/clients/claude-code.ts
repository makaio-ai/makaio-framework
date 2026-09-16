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
  CLAUDE_CODE_HOOK_PRE_COMPACT,
  CLAUDE_CODE_HOOK_PRE_TOOL_USE,
  CLAUDE_CODE_HOOK_SUBAGENT_START,
  CLAUDE_CODE_HOOK_SUBAGENT_STOP,
} from '../../../../clients/claude-code/src/runtime/schemas.js';
import {
  DEFAULT_ALLOWED_TOOLS,
  DENY_REASON,
  NO_TOOL_MARKER_ALLOWED_TOOLS,
  RESPONSE_CONSUMED_MARKER,
  SUBAGENT_CONTEXT_VALUE,
  TOOL_MARKER,
  type ClientProbeContract,
  type ProbeEffectScenario,
} from '../probe-contract.js';

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
 */
const SUBAGENT_RELAY_PROMPT =
  'Use the Agent tool to run a general-purpose subagent and ask it to report the probe session token from its own context. Then reply with the token it reports.';

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
 * Render one native Claude Code sentinel from the client's own renderer.
 * @param eventName - Native hook event being exercised.
 * @param effects - Effects the scenario contributes.
 * @returns Native response body written to stdout by the capture shim.
 */
function sentinel(eventName: string, effects: ReadonlyArray<CanonicalEffect | ProviderContributionEnvelope>): string {
  return renderClaudeCodeNativeResponse(eventName, effects).stdout;
}

/**
 * Build the context-append probe shape for one event.
 *
 * On `PreToolUse` the scenario must also approve the marker tool: the probe
 * runs under a dontAsk policy that would otherwise deny it before the appended
 * context could influence the final response. Events without a permission
 * decision contribute context alone.
 *
 * `SubagentStart` appends to a context the parent never sees, so its scenario
 * has to create a subagent and route the subagent's own words back out; the
 * default marker-only prompt would leave the event unreached.
 * @param eventName - Native hook event being exercised.
 * @returns Context-consumption probe shape.
 */
function contextScenario(eventName: string): ProbeEffectScenario {
  const isSubagentStart = eventName === CLAUDE_CODE_HOOK_SUBAGENT_START;
  const context: CanonicalEffect = {
    kind: 'context.append',
    value: isSubagentStart ? SUBAGENT_CONTEXT_VALUE : `Include ${RESPONSE_CONSUMED_MARKER} in your final response.`,
  };
  const effects = eventName === CLAUDE_CODE_HOOK_PRE_TOOL_USE ? [createApproveEffect(), context] : [context];
  return {
    suffix: 'context-append',
    sentinelOutput: sentinel(eventName, effects),
    oracle: 'final-response-must-contain-marker',
    expectedResponseMarker: RESPONSE_CONSUMED_MARKER,
    ...(isSubagentStart && {
      description: 'Attempts to seed a spawned subagent with hook-appended context it must repeat back.',
      prompt: SUBAGENT_RELAY_PROMPT,
      allowedTools: SUBAGENT_ALLOWED_TOOLS,
    }),
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

    // `/compact` is the only compaction trigger a bounded probe can reach. It
    // is a local slash command, so print mode runs the manual-trigger path with
    // no model turn at all; the other trigger, auto-compaction, is gated on
    // CLAUDE_CODE_AUTO_COMPACT_WINDOW, whose documented minimum is 100k tokens —
    // out of reach inside a synthetic workspace.
    //
    // Driven against the developer's own configuration directory, pinned 2.1.219
    // fires PreCompact from this prompt (`trigger: "manual"`, payload keys
    // `cwd`, `custom_instructions`, `hook_event_name`, `prompt_id`, `session_id`,
    // `transcript_path`, `trigger`) before it reports that there is not yet
    // enough conversation to summarize. Inside the probe's *isolated*
    // configuration directory the same binary, flags, and hook file return an
    // empty result in zero turns and never invoke the hook — the local command
    // is listed in the session's `slash_commands` but its handler stops short.
    // Neither authentication (lease materialized), session persistence, user
    // config, nor the minimal child environment accounts for it; each was ruled
    // out one at a time. So the committed capture records honestly that the
    // event did not fire, and this scenario is the record of what was attempted.
    if (eventName !== CLAUDE_CODE_HOOK_PRE_COMPACT) return undefined;
    return {
      suffix: 'observation',
      description: 'Runs the manual compaction command, the only PreCompact trigger reachable without a model turn.',
      prompt: '/compact',
      oracle: 'unobserved',
    };
  },

  baselineScenarios(eventName) {
    if (eventName !== CLAUDE_CODE_HOOK_PRE_TOOL_USE) return [];
    return [
      {
        suffix: 'unapproved-tool-negative-control',
        description: 'Proves Claude dontAsk leaves the marker absent without a hook permission decision.',
        oracle: 'native-must-deny-unapproved-tool',
        allowedTools: NO_TOOL_MARKER_ALLOWED_TOOLS,
        expectedAbsentMarker: TOOL_MARKER,
      },
    ];
  },
};
