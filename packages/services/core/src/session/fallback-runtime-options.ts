import type { AdapterRuntimeOptions } from '@makaio/contracts';

/**
 * Runtime options preserved across a VirtualModel fallback hop.
 *
 * These fields are extracted from the original `agent.attach` or `adapter.startAgent`
 * payload and re-applied to the fallback attach so the replacement agent
 * inherits the same execution environment (cwd, tool restrictions, system prompt).
 *
 * `allowedDirectories` is intentionally excluded — directory restrictions are
 * resolved at attach time and must not be blindly forwarded across adapter hops.
 */
export type FallbackRuntimeOptions = Pick<
  AdapterRuntimeOptions,
  'cwd' | 'systemPrompt' | 'allowedTools' | 'disallowedTools'
>;

/**
 * Picks fallback-relevant runtime options from an object that carries
 * `AdapterRuntimeOptions`-compatible fields.
 *
 * Covers both `adapter.startAgent` payloads (which merge `AdapterRuntimeOptionsSchema`
 * at the top level) and caller-extracted `agent` sub-objects from
 * `session.agent.attach` payloads (which carry the same fields on `AgentSelectionBase`).
 *
 * Only defined fields are included — omitted keys are not forwarded to avoid
 * overwriting adapter or schema defaults with `undefined`.
 * @param payload - Object carrying the runtime option fields
 * @returns Sparse runtime options object used for fallback attach
 */
export function pickFallbackRuntimeOptions(
  payload: Partial<Pick<AdapterRuntimeOptions, 'cwd' | 'systemPrompt' | 'allowedTools' | 'disallowedTools'>>,
): FallbackRuntimeOptions {
  return {
    ...(payload.cwd !== undefined && { cwd: payload.cwd }),
    ...(payload.systemPrompt !== undefined && { systemPrompt: payload.systemPrompt }),
    ...(payload.allowedTools !== undefined && { allowedTools: payload.allowedTools }),
    ...(payload.disallowedTools !== undefined && { disallowedTools: payload.disallowedTools }),
  };
}
