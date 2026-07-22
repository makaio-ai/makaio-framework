/**
 * Claude Code hook response provider contracts.
 *
 * Declares only the capabilities proven for pinned Claude Code 2.1.143 in
 * Phase 0 evidence capture.  Every interaction and blockability entry is backed
 * by the fixture manifest at
 * `__tests__/fixtures/hook-contracts/manifest.json`.
 *
 * This module owns three things:
 *
 * 1. **Claude-specific effect types** — `ClaudeCodeToolDecision` and the typed
 *    effects record that provider contribution envelopes carry.
 *
 * 2. **Typed builders** — pure factory functions that construct frozen
 *    `ProviderContributionEnvelope<ClaudeCodePreToolUseEffects>` instances
 *    without requiring callers to know the internal effect shape.
 *
 * 3. **Versioned contract catalog entry** — a
 *    `ProviderContractCatalogEntry` that the runtime registers with
 *    clients-core during provider activation so that contributor validation
 *    and closed-policy checks succeed at extension startup.
 * @packageDocumentation
 */

import type {
  InteractionBlockability,
  ProviderContractCatalogEntry,
  ProviderContributionEnvelope,
} from '@makaio/contracts/client';
import { CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES } from '../definition.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable client identifier for Claude Code. */
const CLIENT_ID = 'claude-code';

/**
 * Stable contract identifier for the Claude Code tool-response contract.
 *
 * Follows the `<vendor>.<domain>` naming convention used by provider
 * contracts across the framework.
 */
export const CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID = 'claude-code.tool-response';

/**
 * Semantic version of the Claude Code tool-response contract.
 *
 * Pinned to the proven capabilities of Claude Code CLI 2.1.143.  Bump this
 * version when future CLI releases expand the native response surface.
 */
export const CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Claude-specific effect types
// ---------------------------------------------------------------------------

/**
 * Native Claude Code permission decision for a PreToolUse hook.
 *
 * - `'allow'` — permit the tool invocation to proceed.
 * - `'deny'`  — block the tool invocation.
 *
 * The string values match the native Claude Code hook output contract
 * exactly as proven in `pre-tool-use-output.json`.
 */
export type ClaudeCodeToolDecision = 'allow' | 'deny';

/**
 * Typed effects record carried inside a
 * `ProviderContributionEnvelope` for PreToolUse interactions.
 *
 * The shape mirrors the native Claude Code `hookSpecificOutput` format:
 * ```json
 * {
 *   "decision": "allow" | "deny",
 *   "reason": "optional reason string"
 * }
 * ```
 */
export interface ClaudeCodePreToolUseEffects extends Record<string, unknown> {
  /** Permission decision: allow or deny the tool invocation. */
  readonly decision: ClaudeCodeToolDecision;
  /**
   * Human-readable reason for the decision.
   *
   * When present, forwarded to the Claude Code CLI as
   * `permissionDecisionReason` in the native output.
   */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Typed builders
// ---------------------------------------------------------------------------

/**
 * Build a provider contribution envelope that approves a PreToolUse.
 * @param reason - Optional human-readable reason for the approval.
 * @returns Frozen provider contribution envelope with an `allow` decision.
 */
export function createApproveEffect(reason?: string): ProviderContributionEnvelope<ClaudeCodePreToolUseEffects> {
  return Object.freeze({
    clientId: CLIENT_ID,
    contractId: CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID,
    effects: Object.freeze({
      decision: 'allow' as const,
      ...(reason !== undefined && { reason }),
    }),
  });
}

/**
 * Build a provider contribution envelope that denies a PreToolUse.
 * @param reason - Optional human-readable reason for the denial.
 * @returns Frozen provider contribution envelope with a `deny` decision.
 */
export function createDenyEffect(reason?: string): ProviderContributionEnvelope<ClaudeCodePreToolUseEffects> {
  return Object.freeze({
    clientId: CLIENT_ID,
    contractId: CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID,
    effects: Object.freeze({
      decision: 'deny' as const,
      ...(reason !== undefined && { reason }),
    }),
  });
}

// ---------------------------------------------------------------------------
// Blockability map
// ---------------------------------------------------------------------------

/**
 * Blockability metadata for every interaction supported by the Claude Code
 * tool-response contract.
 *
 * Only `PreToolUse` is blockable — proven by the Phase 0 manifest.  The
 * The namespaced approve and deny capabilities map to the PreToolUse event
 * and inherit its blockability. `context.append` is a canonical effect and is not
 * independently blockable.
 */
const BLOCKABILITY: readonly InteractionBlockability[] = Object.freeze([
  Object.freeze({ interaction: 'PreToolUse', blockable: true }),
  Object.freeze({ interaction: CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES.approve, blockable: true }),
  Object.freeze({ interaction: CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES.deny, blockable: true }),
  Object.freeze({ interaction: 'context.append', blockable: false }),
]);

// ---------------------------------------------------------------------------
// Supported interactions
// ---------------------------------------------------------------------------

/**
 * Interactions supported by the Claude Code tool-response contract.
 *
 * These names must match the namespaced `responseCapabilities` declared in
 * the client definition plus canonical `context.append` and the event name
 * (PreToolUse) so both event-name and capability selectors resolve
 * correctly during contributor activation validation.
 */
const SUPPORTED_INTERACTIONS: readonly string[] = Object.freeze([
  'PreToolUse',
  CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES.approve,
  CLAUDE_CODE_HOOK_RESPONSE_CAPABILITIES.deny,
  'context.append',
]);

// ---------------------------------------------------------------------------
// Contract validator
// ---------------------------------------------------------------------------

/**
 * Extract and validate a Claude Code provider effects record.
 * @param output - Raw callback output to inspect.
 * @returns The effects record, `undefined` for an empty response, or a diagnostic string.
 */
function extractToolResponseEffects(output: unknown): Record<string, unknown> | string | undefined {
  if (output === null || output === undefined) return undefined;
  if (typeof output !== 'object' || Array.isArray(output)) return 'Contributor response must be an object or undefined';

  const response = output as Record<string, unknown>;
  const unsupportedField = Object.keys(response).find((key) => key !== 'providerEnvelope');
  if (unsupportedField !== undefined) return `Unsupported Claude Code provider response field '${unsupportedField}'`;
  if (response.providerEnvelope === undefined) return undefined;
  if (
    typeof response.providerEnvelope !== 'object' ||
    response.providerEnvelope === null ||
    Array.isArray(response.providerEnvelope)
  )
    return 'providerEnvelope must be an object';

  const envelope = response.providerEnvelope as Record<string, unknown>;
  const unsupportedEnvelopeField = Object.keys(envelope).find(
    (key) => key !== 'clientId' && key !== 'contractId' && key !== 'effects',
  );
  if (unsupportedEnvelopeField !== undefined)
    return `Unsupported Claude Code providerEnvelope field '${unsupportedEnvelopeField}'`;
  if (envelope.clientId !== CLIENT_ID) return `providerEnvelope.clientId must be '${CLIENT_ID}'`;
  if (envelope.contractId !== CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID)
    return `providerEnvelope.contractId must be '${CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID}'`;
  if (typeof envelope.effects !== 'object' || envelope.effects === null || Array.isArray(envelope.effects))
    return 'providerEnvelope.effects must be an object';
  return envelope.effects as Record<string, unknown>;
}

/**
 * Validate the exact Claude Code PreToolUse effects shape.
 * @param effects - Provider-native effects to validate.
 * @returns `true` when valid, otherwise a diagnostic string.
 */
function validateToolResponseEffects(effects: Record<string, unknown>): true | string {
  const unsupportedEffect = Object.keys(effects).find((key) => key !== 'decision' && key !== 'reason');
  if (unsupportedEffect !== undefined) return `Unsupported Claude Code PreToolUse effect '${unsupportedEffect}'`;
  if (effects.decision !== 'allow' && effects.decision !== 'deny')
    return `Invalid decision '${String(effects.decision)}'; expected 'allow' or 'deny'`;
  if (effects.reason !== undefined && typeof effects.reason !== 'string')
    return `Invalid reason type '${typeof effects.reason}'; expected string`;
  return true;
}

/**
 * Validate a contributor's provider envelope effects against the Claude Code
 * tool-response contract schema.
 *
 * Accepts envelopes whose `effects` carry a valid `decision` field
 * (`'allow'` or `'deny'`) and an optional `reason` string.  Rejects
 * anything else to prevent malformed native output from reaching the
 * Claude Code CLI.
 * @param output - Raw callback output to validate.
 * @returns `true` when valid, or a string describing the validation error.
 */
function validateToolResponseOutput(output: unknown): true | string {
  const effects = extractToolResponseEffects(output);
  if (effects === undefined) return true;
  return typeof effects === 'string' ? effects : validateToolResponseEffects(effects);
}

// ---------------------------------------------------------------------------
// Contract catalog entry
// ---------------------------------------------------------------------------

/**
 * Versioned provider contract catalog entry for Claude Code tool responses.
 *
 * Register this entry with `ClientHookProviderContractRegistry` during
 * provider activation so that:
 * - Contributors referencing the namespaced approve/deny capabilities or canonical `context.append`
 *   capabilities pass activation-time validation.
 * - Contributors with `failurePolicy: 'closed'` pass blockability checks
 *   for the `PreToolUse` interaction.
 * - Runtime envelope validation catches malformed native output before it
 *   reaches the Claude Code CLI.
 */
export const claudeCodeToolResponseContract: ProviderContractCatalogEntry = Object.freeze({
  clientId: CLIENT_ID,
  contractId: CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_ID,
  version: CLAUDE_CODE_TOOL_RESPONSE_CONTRACT_VERSION,
  supportedInteractions: SUPPORTED_INTERACTIONS,
  blockability: BLOCKABILITY,
  validate: validateToolResponseOutput,
});
