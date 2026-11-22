import { z } from 'zod';
import type { CallContext } from '@makaio/core';
import type { HostTransaction } from '../host-database/index.js';
import type { JournalEntry } from './entry.js';
import { EntryIdSchema, PositionSchema } from './identifiers.js';
import type { ReaderName, SubjectPattern } from './identifiers.js';

/**
 * Result of a reader handling one journal entry.
 *
 * - `done`: the entry is processed. The optional `commit` runs in the host
 *   transaction that also advances the reader's state, so work written through
 *   `tx` and the new state persist together. It may only do database work of
 *   the host, never a request on the bus. When `commit` returns
 *   `{ state: 'failed' }`, processing of the entry ends as failed and nothing
 *   written through `tx` persists. When `commit` throws, the outcome counts as
 *   `retry`.
 * - `retry`: the entry could not be processed now, or is put back. `notBefore`
 *   is an ISO date-time before which the entry is not handed out again.
 * - `failed`: processing ended for good. The entry stays failed until an
 *   operator requeues it.
 */
export type ReaderOutcome =
  | {
      readonly state: 'done';
      /**
       * Work to do together with advancing the reader's state.
       * @param tx - The host transaction in which the reader's state advances.
       * @returns Nothing on success, or `{ state: 'failed' }` with a reason to end the entry as failed.
       */
      readonly commit?: (tx: HostTransaction) => Promise<void | { readonly state: 'failed'; readonly reason: string }>;
    }
  | { readonly state: 'retry'; readonly reason: string; readonly notBefore?: string }
  | { readonly state: 'failed'; readonly reason: string };

/**
 * A reader as an extension contributes it: processes the journal entries that
 * match its subjects, with a reading state of its own per entry.
 */
export interface ReaderContribution {
  /** Name of the reader, owned by the contributing extension. */
  readonly reader: ReaderName;
  /** What the reader does, for people. */
  readonly description: string;
  /**
   * Which entries concern the reader: an entry is handed out when its subject
   * matches one of the returned patterns. A pure function, read anew for every
   * selection, so the patterns may change at runtime. A change of the patterns
   * resets neither the reading state nor `startAt`.
   * @returns The patterns of the subjects the reader processes.
   */
  subjects(): readonly SubjectPattern[];
  /**
   * Reading state on first activation. `'beginning'` reads the entries that
   * already exist, `'now'` reads only entries recorded afterwards. Absent
   * means `'now'`.
   */
  readonly startAt?: 'beginning' | 'now';
  /**
   * Processes one entry. It runs outside any host transaction; what must
   * persist together with the reading state is returned as `commit` of the
   * `done` outcome.
   * @param call - Context of the call. The caller is the reader's extension; principal and attesting party are those of the entry.
   * @param entry - The entry to process.
   * @param options - Handling options: `deadline` is the ISO date-time by which the handling should be finished.
   * @returns What became of the entry.
   */
  handle(call: CallContext, entry: JournalEntry, options: { readonly deadline: string }): Promise<ReaderOutcome>;
}

/**
 * Reading state of one reader for one entry.
 */
export const ReaderEntryStateSchema = z
  .object({
    /** Identifier of the entry. */
    entryId: EntryIdSchema,
    /** Ordinal of the entry over the whole journal. */
    position: PositionSchema,
    /** Whether the entry is still to be read, was processed, or ended as failed. */
    state: z.enum(['open', 'done', 'failed']),
    /** Why the entry is not done, when the last attempt gave a reason. */
    reason: z.string().optional(),
    /** How often handling of the entry was retried. */
    retries: z.number().int().nonnegative(),
    /** ISO date-time before which the entry is not handed out again. */
    notBefore: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
/** Reading state of one reader for one entry. */
export type ReaderEntryState = z.infer<typeof ReaderEntryStateSchema>;
