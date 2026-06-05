import type { TransportPeerContext } from '@makaio/core';

/**
 * Set of authenticated peer identities that are authorised to request
 * subagent spawning or execution on behalf of a remote caller.
 *
 * Entries are keyed on the `kind:id` pair of the peer (for example
 * `workflow-execution:exec-abc-123`). The empty set denies all remote callers.
 */
export type SpawnDelegationAllowSet = Set<string>;

/**
 * Build the canonical allow-set key from a peer's kind and id.
 * @param kind - Peer kind (e.g. `'workflow-execution'`)
 * @param id - Peer identifier
 * @returns Key string used in a {@link SpawnDelegationAllowSet}
 */
function peerKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Determine whether a remote peer is authorised to request subagent
 * spawning / execution on this node.
 *
 * Workflow execution peers are authorised by identity because they represent
 * the runner that owns the workflow agent step. Other peer kinds are
 * authorised only when their `kind:id` pair matches the explicit allow-set.
 * @param peer - Authenticated peer context from the incoming transport message.
 * @param allowSet - Allow-set configured for this SubagentService instance.
 * @returns `true` when the peer may delegate spawn/execute requests.
 */
export function isPeerAuthorizedToDelegate(
  peer: TransportPeerContext | undefined,
  allowSet: SpawnDelegationAllowSet,
): boolean {
  if (peer?.authenticated !== true) {
    return false;
  }
  if (!peer.id) {
    return false;
  }
  if (peer.kind === 'workflow-execution') {
    return true;
  }
  if (allowSet.size === 0) {
    return false;
  }
  return allowSet.has(peerKey(peer.kind, peer.id));
}
