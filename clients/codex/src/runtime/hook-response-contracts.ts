/** Codex 0.144.1 synchronous hook-response contract. @packageDocumentation */
import type {
  InteractionBlockability,
  ProviderContractCatalogEntry,
  ProviderContributionEnvelope,
} from '@makaio/contracts/client';
import {
  CODEX_HOOK_POST_TOOL_USE,
  CODEX_HOOK_PRE_TOOL_USE,
  CODEX_HOOK_SESSION_START,
  CODEX_HOOK_STOP,
  CODEX_HOOK_USER_PROMPT_SUBMIT,
} from './schemas.js';
import { CODEX_HOOK_RESPONSE_CAPABILITIES } from '../definition.js';

export const CODEX_CLIENT_ID = 'codex';
export const CODEX_CONTRACT_ID = 'openai.codex-hook-response';
export const CODEX_CONTRACT_VERSION = '1.1.0';
export type CodexBlockEffects = Readonly<{ decision: 'block'; reason: string }> & Record<string, unknown>;
export type CodexContextEffects = Readonly<{ additionalContext: string }> & Record<string, unknown>;
export type CodexPermissionDenyEffects = Readonly<{ permissionDecision: 'deny'; permissionDecisionReason: string }> &
  Record<string, unknown>;
/** JSON value accepted by Codex's `serde_json::Value` hook parser. */
export type CodexJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly CodexJsonValue[]
  | { readonly [key: string]: CodexJsonValue };
/**
 * JSON input accepted as a Codex `updated_input` replacement.
 *
 * The pinned Rust hook contract represents the field as `Option<Value>`:
 * a top-level JSON `null` therefore deserializes as an absent value, while
 * nested null values remain valid JSON within a present replacement.
 */
export type CodexUpdatedInput = Exclude<CodexJsonValue, null>;
export type CodexInputUpdateEffects = Readonly<{ permissionDecision: 'allow'; updatedInput: CodexUpdatedInput }> &
  Record<string, unknown>;
export type CodexEffects =
  | CodexBlockEffects
  | CodexContextEffects
  | CodexPermissionDenyEffects
  | CodexInputUpdateEffects;

/**
 * Build a frozen Codex provider envelope.
 * @param effects - Provider-native effect record.
 * @returns A frozen Codex contribution envelope.
 */
function envelope<TEffects extends CodexEffects>(effects: TEffects): ProviderContributionEnvelope<TEffects> {
  return Object.freeze({ clientId: CODEX_CLIENT_ID, contractId: CODEX_CONTRACT_ID, effects: Object.freeze(effects) });
}
/**
 * Builds a SessionStart context response.
 * @param value - Context appended when the session starts.
 * @returns A Codex SessionStart context envelope.
 */
export function createCodexSessionStartContextEffect(value: string): ProviderContributionEnvelope<CodexContextEffects> {
  return envelope({ additionalContext: value });
}
/**
 * Builds a SessionStart stop response.
 * @param reason - Reason for stopping session startup.
 * @returns A Codex SessionStart block envelope.
 */
export function createCodexSessionStartBlockEffect(reason: string): ProviderContributionEnvelope<CodexBlockEffects> {
  return envelope({ decision: 'block', reason });
}
/**
 * Builds a UserPromptSubmit context response.
 * @param value - Context appended to the submitted prompt.
 * @returns A Codex UserPromptSubmit context envelope.
 */
export function createCodexUserPromptSubmitContextEffect(
  value: string,
): ProviderContributionEnvelope<CodexContextEffects> {
  return envelope({ additionalContext: value });
}
/**
 * Builds a UserPromptSubmit block response.
 * @param reason - Reason for blocking the submitted prompt.
 * @returns A Codex UserPromptSubmit block envelope.
 */
export function createCodexUserPromptSubmitBlockEffect(
  reason: string,
): ProviderContributionEnvelope<CodexBlockEffects> {
  return envelope({ decision: 'block', reason });
}
/**
 * Builds a PreToolUse block response.
 * @param reason - Reason for blocking the tool invocation.
 * @returns A Codex PreToolUse block envelope.
 */
export function createCodexPreToolUseBlockEffect(reason: string): ProviderContributionEnvelope<CodexBlockEffects> {
  return envelope({ decision: 'block', reason });
}
/**
 * Builds a PreToolUse deny-permission response.
 * @param reason - Reason for denying the tool invocation.
 * @returns A Codex PreToolUse permission-denial envelope.
 */
export function createCodexPreToolUseDenyEffect(
  reason: string,
): ProviderContributionEnvelope<CodexPermissionDenyEffects> {
  return envelope({ permissionDecision: 'deny', permissionDecisionReason: reason });
}
/**
 * Builds additional model context for PreToolUse.
 * @param value - Context appended before the tool invocation.
 * @returns A Codex PreToolUse context envelope.
 */
export function createCodexPreToolUseContextEffect(value: string): ProviderContributionEnvelope<CodexContextEffects> {
  return envelope({ additionalContext: value });
}
/**
 * Builds a PreToolUse allowed input update.
 * @param updatedInput - JSON value that replaces the native tool input.
 * @returns A Codex PreToolUse input-update envelope.
 */
export function createCodexPreToolUseUpdateEffect(
  updatedInput: CodexUpdatedInput,
): ProviderContributionEnvelope<CodexInputUpdateEffects> {
  return envelope({ permissionDecision: 'allow', updatedInput });
}
/**
 * Builds a PostToolUse context response.
 * @param value - Context appended after the tool invocation.
 * @returns A Codex PostToolUse context envelope.
 */
export function createCodexPostToolUseContextEffect(value: string): ProviderContributionEnvelope<CodexContextEffects> {
  return envelope({ additionalContext: value });
}
/**
 * Builds a PostToolUse block response.
 * @param reason - Reason for blocking after the tool invocation.
 * @returns A Codex PostToolUse block envelope.
 */
export function createCodexPostToolUseBlockEffect(reason: string): ProviderContributionEnvelope<CodexBlockEffects> {
  return envelope({ decision: 'block', reason });
}
/**
 * Builds a Stop block response.
 * @param reason - Reason for requesting another turn.
 * @returns A Codex Stop block envelope.
 */
export function createCodexStopBlockEffect(reason: string): ProviderContributionEnvelope<CodexBlockEffects> {
  return envelope({ decision: 'block', reason });
}

export const CODEX_RESPONSE_CAPABILITIES = Object.freeze([
  'context.append',
  CODEX_HOOK_RESPONSE_CAPABILITIES.block,
  CODEX_HOOK_RESPONSE_CAPABILITIES.permissionDeny,
  CODEX_HOOK_RESPONSE_CAPABILITIES.inputUpdate,
]);
export const CODEX_SUPPORTED_INTERACTIONS = Object.freeze([
  CODEX_HOOK_SESSION_START,
  CODEX_HOOK_USER_PROMPT_SUBMIT,
  CODEX_HOOK_PRE_TOOL_USE,
  CODEX_HOOK_POST_TOOL_USE,
  CODEX_HOOK_STOP,
  ...CODEX_RESPONSE_CAPABILITIES,
]);
export const CODEX_INTERACTION_BLOCKABILITY: readonly InteractionBlockability[] = Object.freeze(
  CODEX_SUPPORTED_INTERACTIONS.map((interaction) =>
    Object.freeze({
      interaction,
      blockable:
        interaction === CODEX_HOOK_RESPONSE_CAPABILITIES.block ||
        interaction === CODEX_HOOK_RESPONSE_CAPABILITIES.permissionDeny ||
        interaction === CODEX_HOOK_RESPONSE_CAPABILITIES.inputUpdate ||
        interaction === CODEX_HOOK_SESSION_START ||
        interaction === CODEX_HOOK_USER_PROMPT_SUBMIT ||
        interaction === CODEX_HOOK_PRE_TOOL_USE ||
        interaction === CODEX_HOOK_POST_TOOL_USE ||
        interaction === CODEX_HOOK_STOP,
    }),
  ),
);

/**
 * Determine whether a runtime value is losslessly representable as JSON.
 * @param value - Runtime value to inspect.
 * @param ancestors - Objects already visited on the current recursion path.
 * @returns Whether the value is an acyclic JSON value.
 */
function isJsonValue(value: unknown, ancestors: ReadonlySet<object> = new Set()): value is CodexJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;

  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, nextAncestors));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry, nextAncestors));
}

type CodexEffectKind = 'context' | 'block' | 'deny' | 'update';

const EVENT_EFFECTS: Readonly<Record<string, ReadonlySet<CodexEffectKind>>> = Object.freeze({
  [CODEX_HOOK_SESSION_START]: new Set<CodexEffectKind>(['context', 'block']),
  [CODEX_HOOK_USER_PROMPT_SUBMIT]: new Set<CodexEffectKind>(['context', 'block']),
  [CODEX_HOOK_PRE_TOOL_USE]: new Set<CodexEffectKind>(['context', 'block', 'deny', 'update']),
  [CODEX_HOOK_POST_TOOL_USE]: new Set<CodexEffectKind>(['context', 'block']),
  [CODEX_HOOK_STOP]: new Set<CodexEffectKind>(['block']),
});

/**
 * Classify an exact provider-native Codex effects record.
 * @param effects - Provider-native effects to classify.
 * @returns The recognized effect kind, or `undefined` for an invalid shape.
 */
function classifyEffects(effects: Record<string, unknown>): CodexEffectKind | undefined {
  const keys = Object.keys(effects);
  if (keys.length === 1 && typeof effects.additionalContext === 'string') return 'context';
  if (keys.length !== 2) return undefined;
  if (effects.decision === 'block' && typeof effects.reason === 'string' && effects.reason.trim() !== '')
    return 'block';
  if (
    effects.permissionDecision === 'deny' &&
    typeof effects.permissionDecisionReason === 'string' &&
    effects.permissionDecisionReason.trim() !== ''
  )
    return 'deny';
  if (
    effects.permissionDecision === 'allow' &&
    'updatedInput' in effects &&
    // Contributors are runtime data, so preserve the native `Option<Value>`
    // invariant even though the typed builder rejects a top-level null.
    effects.updatedInput !== null &&
    isJsonValue(effects.updatedInput)
  )
    return 'update';
  return undefined;
}

/**
 * Extract and validate the provider-native effects record.
 * @param output - Contributor response to inspect.
 * @returns The effects record, `undefined` for an empty response, or a diagnostic string.
 */
function extractEffects(output: unknown): Record<string, unknown> | string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output !== 'object' || Array.isArray(output)) return 'Contributor response must be an object or undefined';
  const response = output as Record<string, unknown>;
  if (Object.keys(response).some((key) => key !== 'providerEnvelope'))
    return 'Codex provider responses may contain only providerEnvelope';
  if (response.providerEnvelope === undefined) return undefined;
  if (
    typeof response.providerEnvelope !== 'object' ||
    response.providerEnvelope === null ||
    Array.isArray(response.providerEnvelope)
  )
    return 'providerEnvelope must be an object';
  const envelope = response.providerEnvelope as Record<string, unknown>;
  const unsupportedField = Object.keys(envelope).find(
    (key) => key !== 'clientId' && key !== 'contractId' && key !== 'effects',
  );
  if (unsupportedField !== undefined) return `Unsupported Codex providerEnvelope field '${unsupportedField}'`;
  if (envelope.clientId !== CODEX_CLIENT_ID || envelope.contractId !== CODEX_CONTRACT_ID)
    return 'providerEnvelope clientId and contractId must target the Codex contract';
  if (typeof envelope.effects !== 'object' || envelope.effects === null || Array.isArray(envelope.effects))
    return 'providerEnvelope.effects must be an object';
  return envelope.effects as Record<string, unknown>;
}
/**
 * Validate a provider response against the event-specific Codex parser surface.
 * @param output - Contributor response to validate.
 * @param ctx - Current provider validation context.
 * @returns `true` when valid, otherwise a diagnostic string.
 */
function validateCodexContractOutput(output: unknown, ctx: Record<string, unknown>): true | string {
  const effects = extractEffects(output);
  if (effects === undefined) return true;
  if (typeof effects === 'string') return effects;
  const effectKind = classifyEffects(effects);
  if (effectKind !== undefined && EVENT_EFFECTS[String(ctx.eventName)]?.has(effectKind)) return true;
  return `Unsupported Codex response effects for '${String(ctx.eventName)}'`;
}
export const codexProviderContractCatalog: ProviderContractCatalogEntry = Object.freeze({
  clientId: CODEX_CLIENT_ID,
  contractId: CODEX_CONTRACT_ID,
  version: CODEX_CONTRACT_VERSION,
  supportedInteractions: CODEX_SUPPORTED_INTERACTIONS,
  blockability: CODEX_INTERACTION_BLOCKABILITY,
  validate: validateCodexContractOutput,
});
