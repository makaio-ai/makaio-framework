import type { JsonValue } from '../shared/json-value.js';
import type { HostTransaction } from '../host-database/index.js';
import type { EdgeName, EntryId, SubjectName } from './identifiers.js';
import type { WitnessedAccount } from './witnessed-account.js';

/**
 * Outcome for one entry handed to the journal.
 *
 * - `recorded`: a new entry was written.
 * - `known`: an entry with the same extension, key, and subject already exists.
 *   Nothing was written and `entryId` names the existing entry, even when the
 *   payload differs. A key for a different subject causes `key-subject-mismatch`.
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
 * - `foreign-transaction`: the value does not belong to the journal's host database
 *   facade. A live transaction from another facade is marked rollback-only.
 * - `transaction-finished`: the transaction from this host database facade already ended.
 * - `record-before-active`: the recording extension has yet to become active.
 * - `key-subject-mismatch`: the extension's key already names an entry for a
 *   different subject, so the caller's transaction fails.
 */
export type JournalRecordErrorCode =
  | 'subject-unknown'
  | 'subject-not-recorded'
  | 'name-not-owned'
  | 'payload-invalid'
  | 'edge-unknown'
  | 'foreign-transaction'
  | 'transaction-finished'
  | 'record-before-active'
  | 'key-subject-mismatch';

/**
 * Why the journal refused to accept a delivery. Includes all
 * {@link JournalRecordErrorCode} values as well as:
 *
 * - `cursor-moved`: the edge's cursor for the partition differs from the expected
 *   value because another process advanced it.
 * - `witnessed-not-owned`: the witnessed account names an extension other than
 *   the edge owner, which can only witness accounts of its own system.
 * - `accept-during-own-start`: `accept` was awaited during the edge owner's own
 *   still-running startup. The error names that extension and no transaction opens.
 * - `accept-startup-timeout`: the host did not finish starting within the delivery's
 *   configured wait. No transaction opens.
 */
export type JournalAcceptErrorCode =
  | JournalRecordErrorCode
  | 'cursor-moved'
  | 'witnessed-not-owned'
  | 'accept-during-own-start'
  | 'accept-startup-timeout';

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
 * One entry of a delivery. The inbound edge is bound to the capability that
 * accepts the delivery.
 */
export type AcceptEntryInput = Omit<RecordEntryInput, 'edge'> & {
  /** The account that acted in the verified delivery, witnessed by the edge owner. */
  readonly witnessed?: WitnessedAccount;
};

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
