import type { CallContext } from '@makaio/core';
import type { EdgeName } from './identifiers.js';
import type { AcceptInput, EntryRecordOutcome, RecordInput } from './record.js';

/**
 * Cursor of one partition of an inbound edge.
 */
export interface EdgeCursorValue {
  /** The partition the cursor belongs to. */
  readonly partition: string;
  /** The cursor value; `null` when nothing was accepted yet for the partition. */
  readonly value: string | null;
}

/**
 * Capability of one inbound edge owned by the calling extension.
 *
 * The caller of an accepted entry is the extension that owns the edge, so no
 * call context is passed.
 */
export interface JournalEdgeCapability {
  /**
   * Accepts a delivery: the core opens a host transaction, records the
   * entries, moves the cursor conditionally and commits. Resolves only after
   * the transaction is closed. A redelivery with the same key and subject
   * yields `known`, even when the payload differs.
   * A delivery arriving during host startup waits for the host to become ready,
   * up to the configured startup wait.
   * @param input - The entries of the delivery and the cursor movement.
   * @returns One outcome per entry, in input order.
   * @throws A `JournalError` with a code of `JournalAcceptErrorCode`, including
   * `key-subject-mismatch` when the key refers to another subject and
   * `accept-during-own-start` when the edge owner awaits acceptance during its
   * own startup. That error names the extension. When the startup wait expires,
   * `accept-startup-timeout` is reported. Neither failure opens a transaction.
   * A rejected delivery writes nothing.
   */
  accept(input: AcceptInput): Promise<EntryRecordOutcome[]>;

  /**
   * Reads the current cursors of this edge.
   * @param partitions - The partitions to read the cursors of.
   * @returns The cursor of each named partition.
   */
  getEdgeCursors(partitions: readonly string[]): Promise<EdgeCursorValue[]>;
}

/**
 * Capability of the journal as seen by an extension.
 */
export interface JournalCapability {
  /**
   * Records entries inside the caller's host transaction (`input.tx`): they
   * persist together with the caller's own change or not at all. Idempotent
   * per (extension, key). A second record with the same key and subject yields
   * `known` without writing, even when the payload differs. The caller of every
   * entry is the recording extension. The principal and attesting party come
   * from `call`.
   * @param call - Context of the calling extension.
   * @param input - The caller's host transaction and the entries to record.
   * @returns One outcome per entry, in input order.
   * @throws A `JournalError` with a code of `JournalRecordErrorCode`, including
   * `record-before-active` during startup, `key-subject-mismatch` when the key
   * refers to another subject, `foreign-transaction` for a token outside this
   * host database facade, and `transaction-finished` for an ended transaction.
   * A rejection marks any live transaction supplied in `input.tx` rollback-only,
   * including one owned by another facade, even when the caller catches the error.
   */
  record(call: CallContext, input: RecordInput): Promise<EntryRecordOutcome[]>;

  /**
   * Returns the capability of one inbound edge owned by this extension.
   * @param name - Name of the inbound edge.
   * @returns The capability of that edge.
   */
  edge(name: EdgeName): JournalEdgeCapability;
}
