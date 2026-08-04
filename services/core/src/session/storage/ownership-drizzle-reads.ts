/**
 * The classifying reads of the `storage:sessionOwnership` Drizzle handlers.
 *
 * None of these decide anything. Every operation in `ownership-drizzle-handler.ts`
 * writes first and carries its whole authority in the write's own predicate;
 * these lookups run only *after* a write matched no row, to name which of the
 * modeled refusals it was. Keeping them apart from the operations is what makes
 * that rule visible: a read used to *grant* authority would have to move back
 * into the statement it authorizes.
 * @packageDocumentation
 */
import { and, eq } from 'drizzle-orm';
import type { SessionOwnershipClaimRequest } from '@makaio/contracts';
import type { AgentRow, ClaimRow, OwnershipTables, OwnershipTransaction } from './ownership-drizzle-rows.js';

/**
 * Read the claim currently holding an ownership key.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param payload - Claim request naming the ownership key.
 * @returns The holding row, or `undefined` when the key is free.
 */
export async function readClaimByKey(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  payload: SessionOwnershipClaimRequest,
): Promise<ClaimRow | undefined> {
  const { adapterSessionClaims } = tables;
  const [row] = await tx
    .select()
    .from(adapterSessionClaims)
    .where(
      and(
        eq(adapterSessionClaims.machineId, payload.machineId),
        eq(adapterSessionClaims.adapterId, payload.adapterId),
        eq(adapterSessionClaims.providerSessionId, payload.providerSessionId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Read the claim carrying a generation's token.
 *
 * `uniq_adapter_session_claims_token` makes the token a key of its own, so this
 * is a lookup rather than a scan: a generation is named once, and the row it
 * names is the only place its authority can be checked against.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param claimToken - Generation token to look up.
 * @returns The claim row, or `undefined` when no claim carries the token.
 */
export async function readClaimByToken(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  claimToken: string,
): Promise<ClaimRow | undefined> {
  const { adapterSessionClaims } = tables;
  const [row] = await tx
    .select()
    .from(adapterSessionClaims)
    .where(eq(adapterSessionClaims.claimToken, claimToken))
    .limit(1);
  return row;
}

/**
 * Read one agent row.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param agentId - Agent to read.
 * @returns The agent row, or `undefined` when it does not exist.
 */
export async function readAgent(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  agentId: string,
): Promise<AgentRow | undefined> {
  const { agents } = tables;
  const [row] = await tx.select().from(agents).where(eq(agents.agentId, agentId)).limit(1);
  return row;
}

/**
 * Read a session's lead designation.
 * @param tx - Open transaction.
 * @param tables - Dialect-resolved session storage tables.
 * @param sessionId - Session to read.
 * @returns The lead agent, `null` when the session names none, `undefined` when
 *   the session does not exist.
 */
export async function readLeadAgentId(
  tx: OwnershipTransaction,
  tables: OwnershipTables,
  sessionId: string,
): Promise<string | null | undefined> {
  const { sessions } = tables;
  const [row] = await tx
    .select({ leadAgentId: sessions.leadAgentId })
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId))
    .limit(1);
  return row === undefined ? undefined : (row.leadAgentId ?? null);
}
