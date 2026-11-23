import { isInProcessCaller, MAKAIO_JOB_RUN_PARTY_KIND, type CallContext } from '@makaio/core';

/**
 * Set of caller identities that are authorised to request subagent
 * spawning or execution on behalf of a remote caller.
 *
 * Entries are keyed on the `kind:id` pair of the caller (for example
 * `makaio.machine:node-abc-123`). The empty set denies all remote callers
 * except job runs, which are authorised by their kind.
 */
export type SpawnDelegationAllowSet = Set<string>;

/**
 * Build the canonical allow-set key from a caller's kind and id.
 * @param kind - Caller party kind (e.g. `'makaio.machine'`)
 * @param id - Caller identifier
 * @returns Key string used in a {@link SpawnDelegationAllowSet}
 */
function callerKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Determine whether the caller of a handled message is authorised to request
 * subagent spawning / execution on this node.
 *
 * In-process callers and job runs are authorised by kind: a job run is the
 * registered worker that owns the agent step, and its caller is derived from
 * the login of the transport, never from the message. Other callers are
 * authorised only when their `kind:id` pair matches the explicit allow-set.
 * @param call - Call context of the handled message.
 * @param allowSet - Allow-set configured for this SubagentService instance.
 * @returns `true` when the caller may delegate spawn/execute requests.
 */
export function isCallerAuthorizedToDelegate(call: CallContext, allowSet: SpawnDelegationAllowSet): boolean {
  if (isInProcessCaller(call)) {
    return true;
  }
  if (call.caller.kind === MAKAIO_JOB_RUN_PARTY_KIND) {
    return true;
  }
  if (allowSet.size === 0) {
    return false;
  }
  return allowSet.has(callerKey(call.caller.kind, call.caller.id));
}
