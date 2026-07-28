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
  DEFAULT_ALLOWED_TOOLS,
  DENY_REASON,
  NO_TOOL_MARKER_ALLOWED_TOOLS,
  RESPONSE_CONSUMED_MARKER,
  TOOL_MARKER,
  type ClientProbeContract,
  type ProbeEffectScenario,
} from '../probe-contract.js';

const PRE_TOOL_USE = 'PreToolUse';

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
 * @param eventName - Native hook event being exercised.
 * @returns Context-consumption probe shape.
 */
function contextScenario(eventName: string): ProbeEffectScenario {
  const context: CanonicalEffect = {
    kind: 'context.append',
    value: `Include ${RESPONSE_CONSUMED_MARKER} in your final response.`,
  };
  const effects = eventName === PRE_TOOL_USE ? [createApproveEffect(), context] : [context];
  return {
    suffix: 'context-append',
    sentinelOutput: sentinel(eventName, effects),
    oracle: 'final-response-must-contain-marker',
    expectedResponseMarker: RESPONSE_CONSUMED_MARKER,
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

  baselineScenarios(eventName) {
    if (eventName !== PRE_TOOL_USE) return [];
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
