import {
  SessionSubjects,
  type IMakaioSession,
  type SessionOwnershipContinuationServiceResult,
} from '@makaio/contracts';
import { SessionStorageSubjects } from '../storage/namespace.js';
import type { OwnershipAuthorityContext } from './context.js';

/**
 * Hops the lineage walk will follow before giving up.
 *
 * A compress lineage is a chain of synthesized children, so its depth is
 * bounded by how often a conversation was compacted — small in practice. The
 * bound exists for the pathological shape a walk must survive regardless: a
 * parent cycle written by a broken importer would otherwise spin forever inside
 * an ingestion path.
 */
const MAX_LINEAGE_HOPS = 64;

/**
 * Report that a provider conversation continued, reopening a closed session.
 *
 * A resume or a compaction is direct evidence that the conversation is still in
 * use, which a `closed` row contradicts. `archived` is deliberately **not**
 * reopened: archiving is a deliberate user act with its own restore path, and
 * an observation must not undo a decision.
 *
 * `lastActivityAt` is not refreshed. Activity is what turns produce; a
 * continuation observation says where a conversation lives, not that anything
 * was said in it.
 * @param context - Composed authority context.
 * @param request - The session the continuation was observed for.
 * @returns The row that was acted on and what happened to it.
 */
export async function runContinuation(
  context: OwnershipAuthorityContext,
  request: { sessionId: string },
): Promise<SessionOwnershipContinuationServiceResult> {
  const named = await readSession(context, request.sessionId);
  if (named === null) return { outcome: 'not-found' };

  const lineage = await resolveLineageRoot(context, named);
  if (lineage.kind === 'unresolved') return { outcome: 'unresolved', sessionId: named.sessionId };
  const root = lineage.session;

  if (root.status !== 'closed') return { outcome: 'unchanged', sessionId: root.sessionId };

  // Compare-and-swap, not a read-then-write. The `closed` above is a snapshot,
  // and a continuation is an *observation* racing whatever the user is doing:
  // an archive landing in between would be silently reverted to `active` by an
  // unconditional update, and a deletion would make the write match nothing at
  // all. Both are reported by the same refusal, so the transition is re-read
  // rather than assumed.
  const updated = await context.bus.requestOptional(SessionStorageSubjects.update, {
    sessionId: root.sessionId,
    status: 'active',
    expectedStatus: ['closed'],
  });
  if (!updated.handled || !updated.data.success) return classifyRefusedReopen(context, root.sessionId);

  await context.bus.emit(SessionSubjects.updated, {
    sessionId: root.sessionId,
    changedProperties: ['status'],
  });
  return { outcome: 'reopened', sessionId: root.sessionId };
}

/**
 * Say what happened to a row whose reopen was refused.
 *
 * The refusal alone does not distinguish "someone archived it" from "someone
 * deleted it" — storage reports both as *not applied* rather than guessing — so
 * the row is re-read. Either way nothing was written and nothing is announced:
 * `session.updated` promises a change, and a status this call did not make is
 * not one.
 * @param context - Composed authority context.
 * @param sessionId - Row whose reopen was refused.
 * @returns `not-found` when the row is gone, `unchanged` otherwise.
 */
async function classifyRefusedReopen(
  context: OwnershipAuthorityContext,
  sessionId: string,
): Promise<SessionOwnershipContinuationServiceResult> {
  const current = await readSession(context, sessionId);
  return current === null ? { outcome: 'not-found' } : { outcome: 'unchanged', sessionId };
}

/**
 * Read one session row, degrading an unhandled store to "absent".
 * @param context - Composed authority context.
 * @param sessionId - Row to read.
 * @returns The row, or `null` when it does not exist or cannot be read.
 */
async function readSession(context: OwnershipAuthorityContext, sessionId: string): Promise<IMakaioSession | null> {
  const result = await context.bus.requestOptional(SessionStorageSubjects.get, { sessionId });
  return result.handled ? result.data.session : null;
}

/** Where a continuation may act, or that it may not act anywhere. */
type LineageResolution =
  /** The row carrying the provider identity. */
  | { kind: 'root'; session: IMakaioSession }
  /**
   * The lineage does not lead to a row carrying provider identity: a parent is
   * missing, the chain is longer than the bound, or it loops. Deliberately not
   * "act on what we reached": what a broken walk reaches is a compress child,
   * and reopening one leaves the row that actually holds the conversation
   * closed while advertising that a session was reopened.
   */
  | { kind: 'unresolved' };

/**
 * Walk a compress child up to the row that carries the provider identity.
 *
 * Compaction is **in place** — the provider keeps the same session ID and
 * transcript — so a rebind always resolves to the pre-compaction root, and
 * compress children, which the transcript importer synthesizes, carry no
 * provider identity at all. Provider-session currency and locality therefore
 * live exclusively on the root, and a continuation acts there: reopening a
 * synthesized child would leave the row that actually holds the conversation
 * closed.
 *
 * Non-compress rows are their own root — a fork or a subagent branch is a
 * separate conversation with its own identity, not a view of its parent's.
 *
 * A walk that cannot reach such a row is **unresolved**, never "the last row we
 * saw": every row the walk passes through is a compress child by construction,
 * and those carry no provider identity and are never reopened.
 * @param context - Composed authority context.
 * @param session - The named row.
 * @returns The lineage root, or that the lineage leads to none.
 */
async function resolveLineageRoot(
  context: OwnershipAuthorityContext,
  session: IMakaioSession,
): Promise<LineageResolution> {
  if (session.branchKind !== 'compress') return { kind: 'root', session };
  if (session.rootSessionId !== undefined) {
    const recorded = await readSession(context, session.rootSessionId);
    // A recorded root that is itself a compress child is a broken lineage, not
    // a root: trusting the pointer would reopen a synthesized view.
    return recorded === null || recorded.branchKind === 'compress'
      ? { kind: 'unresolved' }
      : { kind: 'root', session: recorded };
  }

  // No `rootSessionId` recorded: follow the parent chain, which is the same
  // lineage the ancestor query walks, expressed through the bus because the
  // authority holds no database handle of its own.
  let current = session;
  for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop += 1) {
    if (current.parentSessionId === undefined) return { kind: 'unresolved' };
    const parent = await readSession(context, current.parentSessionId);
    if (parent === null) return { kind: 'unresolved' };
    if (parent.branchKind !== 'compress') return { kind: 'root', session: parent };
    current = parent;
  }
  // The bound was reached: a lineage this deep is either pathological or cyclic,
  // and both leave the root unidentified.
  return { kind: 'unresolved' };
}
