import type { HandlerEntry, MakaioBusContext } from '../../types/index.js';
import { matchesSubscription } from '../../utils/subscription-matching.js';
import { mergeSortedHandlerArrays } from '../../utils/handler-merging.js';
import type { RequestHandler } from '@makaio/core';

/**
 * Get all handler entries that match the given fullSubjectKey.
 *
 * Iterates through all registered patterns and collects handler entries
 * from patterns that match the fullSubjectKey (exact or wildcard).
 * Returns entries sorted by priority (highest first).
 * @param context - The bus context containing registered request handlers
 * @param fullSubjectKey - Subject to match against
 * @returns Array of all matching handler entries sorted by priority
 */
export function getMatchingHandlerEntries(
  context: MakaioBusContext,
  fullSubjectKey: string,
): Array<HandlerEntry<RequestHandler<unknown, unknown>>> {
  const { requestHandlers } = context;
  const matchingArrays: Array<Array<HandlerEntry<RequestHandler<unknown, unknown>>>> = [];

  for (const [pattern, entries] of requestHandlers) {
    if (matchesSubscription(fullSubjectKey, pattern)) {
      matchingArrays.push(entries);
    }
  }

  return mergeSortedHandlerArrays(matchingArrays);
}

/**
 * Get all handlers that match the given fullSubjectKey.
 *
 * Convenience wrapper around {@link getMatchingHandlerEntries} that strips
 * priority metadata and returns only the handler functions.
 * @param context - The bus context containing registered request handlers
 * @param fullSubjectKey - Subject to match against
 * @returns Array of all matching handlers sorted by priority
 */
export function getMatchingHandlers(
  context: MakaioBusContext,
  fullSubjectKey: string,
): Array<RequestHandler<unknown, unknown>> {
  return getMatchingHandlerEntries(context, fullSubjectKey).map((entry) => entry.handler);
}

/**
 * Get remote handler entries matching the given subject key.
 *
 * Iterates through remoteRequestHandlers with wildcard matching and returns all
 * entries whose pattern matches the full subject key, sorted by priority (highest first).
 *
 * **Tie-breaking:** When two remote entries from different transports share the same
 * priority, they retain their subscription arrival order (Map insertion order) because
 * `Array.prototype.sort` is stable in V8. This ordering is deterministic within a
 * single process lifetime but is not guaranteed to be consistent across restarts.
 * @param context - Bus context containing remote handler registry
 * @param fullSubjectKey - Subject to match against
 * @returns Array of matching remote entries sorted by priority (highest first)
 */
export function getMatchingRemoteEntries(
  context: MakaioBusContext,
  fullSubjectKey: string,
): Array<{ transport: string; priority: number }> {
  const { remoteRequestHandlers } = context;
  const result: Array<{ transport: string; priority: number }> = [];

  for (const [pattern, entries] of remoteRequestHandlers) {
    if (matchesSubscription(fullSubjectKey, pattern)) {
      result.push(...entries);
    }
  }

  // Sort by priority descending (higher runs first)
  result.sort((a, b) => b.priority - a.priority);
  return result;
}
