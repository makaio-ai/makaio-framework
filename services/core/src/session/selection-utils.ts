/**
 * Shared string-normalization helpers for agent/adapter selection fields.
 *
 * Centralizes the single source of truth for treating blank or whitespace-only
 * strings the same as absent values across all orchestration layers.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterRuntimeSubjects } from '../adapter-runtime/namespace.js';

/**
 * Normalize a selection string field by trimming whitespace and coercing
 * blank strings to `undefined`.
 *
 * Used wherever adapter/agent selection strings are read from wire payloads to
 * ensure callers cannot accidentally pass whitespace-only values as meaningful
 * adapter names or IDs.
 * @param value - Candidate string value from a selection payload field
 * @returns Trimmed non-empty string, or `undefined` when the input is absent
 * or contains only whitespace
 */
export function normalizeSelectionString(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** What a caller may know about the instance a selection named, once normalized. */
export interface NamedSelectionInstance {
  /** Instance the selection named, or `undefined` when it named none. */
  readonly adapterId: string | undefined;
  /** Machine the selection named, or `undefined` when it named none. */
  readonly machineId: string | undefined;
}

/** Session identity and the prefix a caller's own messages carry. */
export interface SelectionRefusalContext {
  /** Session the selection was submitted for, for the refusal message. */
  readonly sessionId: string;
  /** Prefix of the caller's own error messages; include the trailing space. */
  readonly errorPrefix: string;
}

/**
 * Explain why a selection naming one half of the instance/machine pair must be
 * refused rather than served.
 *
 * **One rule, every path that reads the pair.** An instance ID is a one-way hash
 * of `(machineId, adapterName)`, so the two halves are only ever honest together:
 *
 * - **A machine and no instance** cannot be served, because resolving an instance
 *   without one named derives it for the runtime doing the resolving. Honouring
 *   the name is not what that derivation does, and ignoring it starts the agent
 *   here while the caller believes it chose a host.
 * - **An instance and no machine** cannot be completed, because the derivation
 *   cannot be inverted. Filling the gap with the resolving runtime's own machine
 *   files every ownership act under a key no other actor computes — it collides
 *   with nothing, so it protects nothing, while the runtime that really owns the
 *   instance claims the same provider session beside it.
 *
 * **Stated once, thrown by each caller in its own error form**, because the paths
 * that read the pair do not share one: a start refuses with a typed start error, an
 * attach with its own handler error. Returning the reason rather than throwing it
 * is what lets the rule be one rule without making the paths converge on an error
 * type none of them owns.
 *
 * **Needed as well as the selection schema**, whose two refinements forbid both
 * shapes: payload validation returns early in production builds and in-process
 * callers reach these paths with an unparsed selection, so the schema is a guard
 * against *writing* such a caller while this is what an existing one meets.
 *
 * **No path is exempt, including the one that looked like it had a softer answer.**
 * An attach used to serve a named instance with no machine as a locality degrade,
 * on the grounds that a fresh-with-history conversation is still worth offering.
 * The degraded attach still starts, and its settlement still files the confirmed
 * provider session under the resolving runtime's machine while the dispatch
 * addressed the named instance — so the softer answer was the mis-key, taken one
 * step later.
 * @param named - Normalized instance and machine the selection named
 * @param context - Session identity and the prefix of the caller's own messages
 * @returns The refusal, or `undefined` when the selection named both halves or neither
 */
export function describeHalfNamedInstanceRefusal(
  named: NamedSelectionInstance,
  context: SelectionRefusalContext,
): string | undefined {
  const { sessionId, errorPrefix } = context;
  if (named.adapterId === undefined) {
    if (named.machineId === undefined) return undefined;
    return `${errorPrefix}agent selection named machine ${named.machineId} without an adapter instance on it (sessionId=${sessionId}); an instance resolved without one named is derived for the runtime that resolves it, so the named machine would be read by nothing`;
  }
  if (named.machineId !== undefined) return undefined;
  return `${errorPrefix}agent selection named adapter instance ${named.adapterId} without its machine (sessionId=${sessionId}); an instance ID cannot be inverted, so its ownership acts have no namespace`;
}

/**
 * Resolve the canonical `adapterName` for a given deterministic `adapterId`,
 * rejecting when the caller-supplied name does not match the subsystem lookup.
 *
 * The adapter runtime owns reverse lookup for deterministic IDs, including
 * remote-machine IDs that still identify a known adapter type.
 * @param bus - Bus instance used to query the adapter runtime reverse lookup
 * @param adapterId - Adapter instance identifier to look up
 * @param explicitAdapterName - Caller-supplied name to validate against storage;
 * `undefined` skips the mismatch check
 * @param errorPrefix - Prefix prepended to thrown error messages (include trailing space)
 * @returns Canonical adapter name resolved by the adapter runtime
 */
export async function resolveAdapterNameById(
  bus: IMakaioBus,
  adapterId: string,
  explicitAdapterName: string | undefined,
  errorPrefix: string,
): Promise<string> {
  const { adapterName } = await bus.request(AdapterRuntimeSubjects.resolveName, { adapterId });
  if (explicitAdapterName && adapterName !== explicitAdapterName) {
    throw new Error(`${errorPrefix}adapterName "${explicitAdapterName}" does not match adapterId "${adapterId}"`);
  }
  return adapterName;
}
