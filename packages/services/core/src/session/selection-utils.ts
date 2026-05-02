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
