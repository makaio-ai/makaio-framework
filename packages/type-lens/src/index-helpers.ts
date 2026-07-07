import type { IndexEdgeRecord, ScopeIndexRecord } from './index-types.js';

/**
 * Append an edge to outgoing and incoming maps of a scope index.
 *
 * Creates the bucket array on first use so callers never need to
 * pre-initialise the map entries.
 * @param outgoing - Map from source symbol ID to outgoing edges.
 * @param incoming - Map from target symbol ID to incoming edges.
 * @param edge - The edge to append.
 */
export function appendEdge(
  outgoing: ScopeIndexRecord['outgoing'],
  incoming: ScopeIndexRecord['incoming'],
  edge: IndexEdgeRecord,
): void {
  const outBucket = outgoing.get(edge.fromSymbolId) ?? [];
  outBucket.push(edge);
  outgoing.set(edge.fromSymbolId, outBucket);

  const inBucket = incoming.get(edge.toSymbolId) ?? [];
  inBucket.push(edge);
  incoming.set(edge.toSymbolId, inBucket);
}
