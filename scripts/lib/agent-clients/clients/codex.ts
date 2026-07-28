/**
 * Codex probe contract.
 *
 * Native response shapes are not written here — they are rendered by
 * `renderCodexNativeResponse`, the same function the client's `hook.handle`
 * composer uses at runtime. This module only chooses which effects a scenario
 * contributes and how the resulting native behavior is observed.
 * @packageDocumentation
 */

import type { CanonicalEffect, ProviderContributionEnvelope } from '@makaio/contracts/client';
import { CODEX_HOOK_RESPONSE_CAPABILITIES, clientDefinition } from '../../../../clients/codex/src/definition.js';
import {
  CODEX_CLIENT_ID,
  CODEX_CONTRACT_ID,
  createCodexPreToolUseDenyEffect,
  createCodexPreToolUseUpdateEffect,
  type CodexBlockEffects,
} from '../../../../clients/codex/src/runtime/hook-response-contracts.js';
import { renderCodexNativeResponse } from '../../../../clients/codex/src/runtime/hook-response-composer.js';
import {
  DENY_REASON,
  ORIGINAL_MARKER,
  RESPONSE_CONSUMED_MARKER,
  REWRITTEN_MARKER,
  TOOL_MARKER,
  TOOL_MARKER_PROMPT,
  type ClientProbeContract,
  type ProbeEffectScenario,
} from '../probe-contract.js';

const SESSION_START = 'SessionStart';
const USER_PROMPT_SUBMIT = 'UserPromptSubmit';
const PRE_TOOL_USE = 'PreToolUse';

/** Instruction a blocked turn must echo for a response-consumption oracle. */
const BLOCK_INSTRUCTION = `The requested tool result failed. Reply with exactly ${RESPONSE_CONSUMED_MARKER}.`;

/** Tool request whose rewrite is observable through a distinct workspace marker. */
const REWRITE_PROMPT = `MAKAIO_PROBE_MARKER: use the shell tool to run \`touch ${ORIGINAL_MARKER}\`, then reply probe-ack.`;

/**
 * Render one native Codex sentinel from the client's own renderer.
 * @param eventName - Native hook event being exercised.
 * @param effects - Effects the scenario contributes.
 * @returns Native response body written to stdout by the capture shim.
 */
function sentinel(eventName: string, effects: ReadonlyArray<CanonicalEffect | ProviderContributionEnvelope>): string {
  return renderCodexNativeResponse(eventName, effects).stdout;
}

/**
 * Wrap a Codex block effect in a contribution envelope.
 *
 * Built here rather than through a `createCodex*BlockEffect` factory because
 * the event varies: the client exports one block factory per event, and all
 * five return the identical `{ decision: 'block', reason }` payload — the
 * per-event difference lives in the renderer, not the effect. Dispatching to
 * them would need a five-way lookup that renders the same bytes and adds an
 * unmapped-event failure path. Typing the payload as {@link CodexBlockEffects}
 * keeps the field names compile-checked, which is the part that matters.
 * @param reason - Reason the block effect carries.
 * @returns Provider contribution envelope for a Codex block effect.
 */
function blockEffect(reason: string): ProviderContributionEnvelope<CodexBlockEffects> {
  return { clientId: CODEX_CLIENT_ID, contractId: CODEX_CONTRACT_ID, effects: { decision: 'block', reason } };
}

/**
 * Build the block probe shape, whose observable outcome depends on where in
 * the turn the event fires.
 *
 * `SessionStart` and `UserPromptSubmit` terminate before any model work, so the
 * proof is the absence of the tool marker. Later events cannot prevent the turn
 * and instead prove consumption through the final response.
 * @param eventName - Native hook event being exercised.
 * @returns Block probe shape.
 */
function blockScenario(eventName: string): ProbeEffectScenario {
  // SessionStart renders `stopReason`, which is itself the observable value.
  const reason = eventName === SESSION_START ? RESPONSE_CONSUMED_MARKER : BLOCK_INSTRUCTION;
  const sentinelOutput = sentinel(eventName, [blockEffect(reason)]);

  if (eventName === PRE_TOOL_USE) {
    return {
      suffix: 'block',
      sentinelOutput,
      oracle: 'sentinel-must-block-tool',
      expectedAbsentMarker: TOOL_MARKER,
    };
  }

  if (eventName === SESSION_START || eventName === USER_PROMPT_SUBMIT) {
    return {
      suffix: 'block',
      sentinelOutput,
      oracle: 'sentinel-must-block-before-model',
      prompt: TOOL_MARKER_PROMPT,
      expectedAbsentMarker: TOOL_MARKER,
    };
  }

  return {
    suffix: 'block',
    sentinelOutput,
    oracle: 'final-response-must-contain-marker',
    expectedResponseMarker: RESPONSE_CONSUMED_MARKER,
  };
}

/** Codex probe contract consumed by the scenario generator. */
export const codexProbeContract: ClientProbeContract = {
  clientId: 'codex',
  definition: clientDefinition,

  scenarioForEffect(eventName, effect) {
    if (effect === 'context.append') {
      const context: CanonicalEffect = {
        kind: 'context.append',
        value: `Include ${RESPONSE_CONSUMED_MARKER} in your final response.`,
      };
      return {
        suffix: 'context-append',
        sentinelOutput: sentinel(eventName, [context]),
        oracle: 'final-response-must-contain-marker',
        expectedResponseMarker: RESPONSE_CONSUMED_MARKER,
      };
    }

    if (effect === CODEX_HOOK_RESPONSE_CAPABILITIES.block) return blockScenario(eventName);

    if (effect === CODEX_HOOK_RESPONSE_CAPABILITIES.permissionDeny) {
      return {
        suffix: 'permission-deny',
        sentinelOutput: sentinel(eventName, [createCodexPreToolUseDenyEffect(DENY_REASON)]),
        oracle: 'sentinel-must-block-tool',
        expectedAbsentMarker: TOOL_MARKER,
      };
    }

    if (effect === CODEX_HOOK_RESPONSE_CAPABILITIES.inputUpdate) {
      return {
        suffix: 'input-update',
        sentinelOutput: sentinel(eventName, [
          createCodexPreToolUseUpdateEffect({ command: `touch ${REWRITTEN_MARKER}` }),
        ]),
        oracle: 'sentinel-must-rewrite-tool',
        prompt: REWRITE_PROMPT,
        expectedPresentMarker: REWRITTEN_MARKER,
        expectedAbsentMarker: ORIGINAL_MARKER,
      };
    }

    throw new Error(`No Codex probe shape for effect '${effect}' on '${eventName}'`);
  },
};
