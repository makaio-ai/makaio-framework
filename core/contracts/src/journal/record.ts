import type { JsonValue } from '../shared/json-value.js';
import type { HostTransaction } from '../host-database/index.js';
import type { EdgeName, EntryId, SubjectName } from './identifiers.js';
import type { WitnessedAccount } from './witnessed-account.js';

/**
 * Outcome for one entry handed to the journal.
 *
 * - `recorded`: a new entry was written.
 * - `known`: an entry with the same key of the same extension already exists;
 *   nothing was written and `entryId` names the existing entry, even when the
 *   payload differs.
 */
export type EntryRecordOutcome =
  | { readonly status: 'recorded'; readonly entryId: EntryId }
  | { readonly status: 'known'; readonly entryId: EntryId };

/**
 * Why the journal refused to record an entry.
 *
 * - `subject-unknown`: the subject is not declared by any active extension.
 * - `subject-not-recorded`: the subject is not a recorded event.
 * - `name-not-owned`: the subject belongs to another extension.
 * - `payload-invalid`: the payload violates the schema of the subject.
 * - `edge-unknown`: the named edge is not an edge of the recording extension.
 * - `witnessed-not-owned`: the witnessed account names another extension (an
 *   extension only witnesses accounts of its own system).
 */
export type JournalRecordErrorCode =
  | 'subject-unknown'
  | 'subject-not-recorded'
  | 'name-not-owned'
  | 'payload-invalid'
  | 'edge-unknown'
  | 'witnessed-not-owned';

/**
 * Why the journal refused to accept a delivery: the codes of recording plus
 * `cursor-moved`, meaning the cursor of the edge for the partition is no
 * longer at the expected value because another process already accepted
 * further.
 */
export type JournalAcceptErrorCode = JournalRecordErrorCode | 'cursor-moved';

/** One entry handed to the journal for recording. */
export interface RecordEntryInput {
  /** Name of the event to record; it must belong to the recording extension. */
  readonly subject: SubjectName;
  /** Payload, checked against the schema of the subject. */
  readonly payload: JsonValue;
  /** Key against duplicates, unique per extension. */
  readonly key: string;
  /** Key that fixes the order among entries. */
  readonly orderKey?: string;
  /** The inbound edge of the recording extension that accepted the entry. */
  readonly edge?: EdgeName;
  /**
   * The witnessed account the entry stands for. Only valid when the caller of
   * the handler is an account that a verifier of the recording extension
   * delivered at its own route.
   */
  readonly witnessed?: WitnessedAccount;
}

/**
 * Input of recording entries.
 *
 * Recording happens inside the caller's host transaction; the entries become
 * visible when that transaction commits.
 */
export interface RecordInput {
  /** The caller's host transaction. */
  readonly tx: HostTransaction;
  /** The entries to record. */
  readonly entries: readonly RecordEntryInput[];
}

/**
 * One entry of a delivery accepted through an inbound edge. Like
 * `RecordEntryInput`, but without the edge: the edge is bound to the
 * capability that accepts the delivery.
 */
export type AcceptEntryInput = Omit<RecordEntryInput, 'edge'>;

/**
 * Input of accepting a delivery through an inbound edge.
 */
export interface AcceptInput {
  /** The entries of the delivery. */
  readonly entries: readonly AcceptEntryInput[];
  /**
   * State of a poll or stream after this delivery. It is written
   * conditionally, only if the edge's cursor for `partition` still equals
   * `from`, together with the entries or not at all.
   */
  readonly cursor?: {
    /** The partition of the poll or stream the cursor belongs to. */
    readonly partition: string;
    /** The cursor value the delivery started from, `null` for the first delivery. */
    readonly from: string | null;
    /** The cursor value after this delivery. */
    readonly to: string;
  };
}
