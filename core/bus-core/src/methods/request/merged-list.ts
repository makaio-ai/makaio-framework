/**
 * Construction of the priority-ordered list dispatch walks.
 *
 * Local handler entries and remote transport pointers are merged into one list so a
 * handler calling `ctx.next()` advances across both kinds in strict priority order.
 * These helpers are pure with respect to dispatch: they read registry state and shape
 * the list, but never execute an entry.
 */

import type { MakaioBusContext } from '../../types/index.js';
import type { HandlerEntry } from '../../types/handler-entry.js';
import type { RequestHandler } from '@makaio/core';

/** A merged entry for a local handler. */
export type LocalEntry = HandlerEntry<RequestHandler<unknown, unknown>> & { kind: 'local' };

/** A merged entry for a remote transport pointer. */
export type RemoteEntry = { transport: string; priority: number; kind: 'remote' };

/**
 * A remote entry whose transport an earlier hop of the same walk already reached.
 *
 * It is never sent: that hop ran the peer's whole chain below its cursor. It stays in the
 * walk as a priority boundary, because {@link resolveRemoteCursor} derives a later hop's
 * cursor from the entry preceding it, and the covered priority is part of what the walk
 * has already passed.
 */
export type CoveredEntry = { transport: string; priority: number; kind: 'covered' };

/** Union of the entries used in the merged dispatch list. */
export type MergedEntry = LocalEntry | RemoteEntry | CoveredEntry;

/**
 * Build a merged, priority-sorted list of local handler entries and remote transport
 * entries.
 *
 * Sorted by priority descending. Local entries win ties over remote entries so that
 * equal-priority local handlers run before remote hops, avoiding unnecessary network
 * round-trips. Relative order within local entries and within remote entries at the
 * same priority is preserved (stable sort).
 * @param localEntries - Local handler entries, already sorted by priority descending
 * @param remoteEntries - Remote transport entries
 * @returns Merged array ordered by priority descending (local beats remote on ties)
 */
export function buildMergedList(
  localEntries: ReadonlyArray<HandlerEntry<RequestHandler<unknown, unknown>>>,
  remoteEntries: ReadonlyArray<{ transport: string; priority: number }>,
): MergedEntry[] {
  const merged: MergedEntry[] = [
    ...localEntries.map((e): LocalEntry => ({ ...e, kind: 'local' })),
    ...remoteEntries.map((e): RemoteEntry => ({ ...e, kind: 'remote' })),
  ];

  // Stable sort: descending priority, local entries precede remote entries on ties.
  merged.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (a.kind === 'local' && b.kind === 'remote') return -1;
    if (a.kind === 'remote' && b.kind === 'local') return 1;
    return 0;
  });

  return merged;
}

/**
 * Apply an explicit transport allowlist to remote entries.
 *
 * When the allowlist is present but no advertised handlers have arrived yet,
 * synthesize one remote entry per allowed transport so dispatch can still route
 * to the requested peer. This closes the subscribe-propagation race for callers
 * that explicitly constrain transport routing.
 * @param context - Bus context used to resolve current transport registrations
 * @param remoteEntries - Advertised remote entries for the subject
 * @param allowedTransports - Optional explicit transport allowlist
 * @returns Filtered or synthesized remote entries
 */
export function resolveRemoteEntries(
  context: MakaioBusContext,
  remoteEntries: ReadonlyArray<{ transport: string; priority: number }>,
  allowedTransports?: ReadonlyArray<string>,
): Array<{ transport: string; priority: number }> {
  if (!allowedTransports || allowedTransports.length === 0) {
    return [...remoteEntries];
  }

  const allowed = new Set(allowedTransports);
  const filtered = remoteEntries.filter((entry) => allowed.has(entry.transport));
  if (filtered.length > 0) {
    return filtered;
  }

  const unique = [...new Set(allowedTransports)];
  return unique
    .filter((transportName) => {
      const transport = context.transportRegistry.getTransport(transportName);
      if (!transport) return false;
      return transport.isReady?.() !== false;
    })
    .map((transport) => ({ transport, priority: 0 }));
}

/**
 * Resolve the index in `merged` where this node's chain begins.
 *
 * Without a priority cursor the chain starts at the head. With a cursor from an
 * originating transport hop, it starts at the first entry strictly below that
 * priority so this node picks up where the sender left off.
 * @param merged - Merged, priority-descending dispatch list
 * @param cursor - Priority cursor from an originating hop, or `undefined`
 * @returns Start index, or `-1` when every entry is at or above the cursor
 */
export function resolveStartIndex(merged: ReadonlyArray<MergedEntry>, cursor: number | undefined): number {
  return cursor !== undefined ? merged.findIndex((entry) => entry.priority < cursor) : 0;
}

/**
 * Mark every remote entry a walk from `startIndex` would reach for a transport it already
 * reached earlier in the same walk as {@link CoveredEntry}.
 *
 * A peer advertises one entry per priority it serves, but a remote hop delegates the
 * receiver's entire chain below the cursor. The first entry of a transport in the walk
 * therefore covers all of its later entries, and sending one of those would re-run the
 * receiver's lower handlers — the re-sent remote hop the "No retry, ever" contract in
 * `readiness-gate.ts` forbids, whether the first hop exhausted its chain or failed.
 *
 * Covered entries are marked rather than removed: removing one would erase the priority
 * boundary {@link resolveRemoteCursor} reads for the next hop, so a later transport would
 * receive a cursor above priorities the walk already passed and could run a handler out
 * of priority order.
 *
 * Entries before `startIndex` are never walked and are kept unchanged.
 * @param merged - Merged, priority-descending dispatch list
 * @param startIndex - Index where this node's walk begins
 * @returns The list this node walks, index-aligned with `merged`, with at most one sendable
 *   remote entry per transport from `startIndex` on
 */
export function markCoveredRemoteHops(merged: ReadonlyArray<MergedEntry>, startIndex: number): MergedEntry[] {
  const reachedTransports = new Set<string>();
  return merged.map((entry, index) => {
    if (index < startIndex || entry.kind !== 'remote') return entry;
    if (reachedTransports.has(entry.transport)) {
      return { transport: entry.transport, priority: entry.priority, kind: 'covered' };
    }
    reachedTransports.add(entry.transport);
    return entry;
  });
}

/**
 * Find the first entry at or after `index` that the walk executes.
 *
 * Covered entries are only cursor boundaries, so the walk passes over them without
 * executing anything. Passing them in this loop, rather than one dispatch step per
 * entry, keeps the call stack flat: a peer advertising thousands of priorities leaves
 * thousands of consecutive covered entries after its single hop, and a synchronous
 * step per entry would exhaust the stack before a lower-priority fallback is reached.
 * @param merged - The list being walked, as returned by {@link markCoveredRemoteHops}
 * @param index - Position to start searching from
 * @returns The executable entry with its index, or `undefined` when the walk is exhausted
 */
export function nextExecutableEntry(
  merged: ReadonlyArray<MergedEntry>,
  index: number,
): { entry: LocalEntry | RemoteEntry; index: number } | undefined {
  for (let position = index; position < merged.length; position += 1) {
    const entry = merged[position];
    if (entry.kind !== 'covered') return { entry, index: position };
  }
  return undefined;
}

/**
 * Resolve the priority cursor sent to a remote hop.
 *
 * Equal-priority adjustment: when the preceding entry shares the same priority as this
 * remote entry (e.g. local:100 → remote:100, or remoteA:300 → remoteB:300), the base
 * cursor would exclude equal-priority handlers on the receiver because dispatch uses a
 * strict `< cursor`. Incrementing by 1 includes them, which is safe because priorities
 * are integers — no handler can exist between N and N+1. The bump applies to both
 * local-to-remote and remote-to-remote ties; without it the second remote transport
 * would receive a cursor equal to its own priority and skip its handlers.
 *
 * The preceding entry may be a {@link CoveredEntry}: its priority was passed by the walk
 * even though it was not sent, so it bounds the cursor like any executed entry.
 *
 * When nothing preceded (`nextIndex < 2`), the incoming cursor is forwarded unchanged
 * so the remote continues from where the originating node left off. The result never
 * exceeds the incoming cursor: when the remote entry is the first one this node walks,
 * its predecessor lies before the start index — skipped, at or above the incoming
 * cursor — and must not widen the range the originating walk already passed.
 * @param merged - Full merged list being walked
 * @param nextIndex - Index of the step after the remote entry being sent
 * @param entryPriority - Priority of the remote entry being sent
 * @param incomingCursor - Cursor this node was entered with, if any
 * @returns Cursor the receiving node should start its own dispatch from
 */
export function resolveRemoteCursor(
  merged: ReadonlyArray<MergedEntry>,
  nextIndex: number,
  entryPriority: number,
  incomingCursor: number | undefined,
): number | undefined {
  if (nextIndex < 2) return incomingCursor;
  const base = merged[nextIndex - 2].priority;
  const cursor = base === entryPriority ? base + 1 : base;
  return incomingCursor === undefined ? cursor : Math.min(cursor, incomingCursor);
}
