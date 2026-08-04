import { z } from 'zod';
import { AdapterSessionCurrencyStateSchema, type AdapterSessionCurrencyState } from './primitives.js';

/**
 * Enforce that a currency pair names a provider session exactly when it claims one.
 *
 * `currentAdapterSessionId` and `currentAdapterSessionIdState` are two columns
 * carrying one fact — which provider session, if any, a resume attach may target
 * right now. Both storage rows that carry the pair back it with a CHECK
 * constraint, so a pair that violates this rule is rejected by the SQL backends
 * and must be rejected here too, or the in-memory backend would silently accept
 * a state the durable backends cannot represent.
 *
 * This is the *total-pair* rule, and the only one there is: currency is never
 * written a half at a time, because the two columns are one value. The
 * `storage:sessionOwnership` seam is the sole writer and always presents both.
 * @param value - Candidate currency pair
 * @param ctx - Zod refinement context
 */
export function validateCurrencyPairing(
  value: {
    currentAdapterSessionId: string | null;
    currentAdapterSessionIdState: AdapterSessionCurrencyState;
  },
  ctx: z.RefinementCtx,
): void {
  const { currentAdapterSessionId: id, currentAdapterSessionIdState: state } = value;
  if ((state === 'confirmed') === (id !== null)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['currentAdapterSessionId'],
    message: "currentAdapterSessionId must be a string exactly when currentAdapterSessionIdState is 'confirmed'",
  });
}

/**
 * The writable half of an adapter-session currency: where the provider
 * conversation lives now, as a single value.
 *
 * The immutable origin identity is deliberately absent — a currency write moves
 * the resume target, it never rewrites where the session came from.
 */
export const AdapterSessionCurrencyTargetSchema = z
  .object({
    /**
     * Provider-confirmed session ID that carries the conversation, or `null`
     * when the state carries no confirmed ID.
     */
    currentAdapterSessionId: z.string().nullable(),
    /** {@inheritDoc AdapterSessionCurrencyStateSchema} */
    currentAdapterSessionIdState: AdapterSessionCurrencyStateSchema,
  })
  .superRefine(validateCurrencyPairing);

/** {@inheritDoc AdapterSessionCurrencyTargetSchema} */
export type AdapterSessionCurrencyTarget = z.infer<typeof AdapterSessionCurrencyTargetSchema>;

/**
 * The full provider-native resume state of one row — the currency trias.
 *
 * Both the session row and the agent row carry the same three facts, and both
 * resolve a resume target from them by the same rule, so the shape and its
 * resolver are declared once here:
 *
 * - `adapterSessionId` — the **immutable origin identity** (import key,
 *   write-once). It records where the provider conversation came from.
 * - `currentAdapterSessionId` + `currentAdapterSessionIdState` — the
 *   **currency**: where the provider conversation is now.
 *
 * Reading a resume target from any two of these fields in isolation is how the
 * origin/currency split gets re-broken; use
 * {@link resolveResumableAdapterSessionId}.
 */
export const AdapterSessionCurrencySnapshotSchema = z
  .object({
    /** Immutable origin identity of the provider session; `null` when never known. */
    adapterSessionId: z.string().nullable(),
    /** {@inheritDoc AdapterSessionCurrencyTargetSchema} */
    currentAdapterSessionId: z.string().nullable(),
    /** {@inheritDoc AdapterSessionCurrencyStateSchema} */
    currentAdapterSessionIdState: AdapterSessionCurrencyStateSchema,
  })
  .superRefine(validateCurrencyPairing);

/** {@inheritDoc AdapterSessionCurrencySnapshotSchema} */
export type AdapterSessionCurrencySnapshot = z.infer<typeof AdapterSessionCurrencySnapshotSchema>;

/**
 * Resolve the provider session a resume attach may legitimately target.
 *
 * The total mapping of the currency trias, and the only sanctioned way to turn
 * one into a resume target:
 * - `inherited` — the conversation never moved, so the origin identity is still
 *   the valid currency.
 * - `confirmed` — `currentAdapterSessionId` supersedes the origin identity.
 * - `moved` — the conversation left the origin and the provider has not
 *   confirmed a successor, so **nothing** is resumable; callers degrade to
 *   fresh-with-history rather than resuming a session the provider abandoned.
 * @param snapshot - Currency trias of a session or agent row
 * @returns Provider session ID to resume, or `null` when no resume is legitimate
 */
export function resolveResumableAdapterSessionId(snapshot: AdapterSessionCurrencySnapshot): string | null {
  switch (snapshot.currentAdapterSessionIdState) {
    case 'inherited':
      return snapshot.adapterSessionId;
    case 'confirmed':
      return snapshot.currentAdapterSessionId;
    case 'moved':
      return null;
  }
}
