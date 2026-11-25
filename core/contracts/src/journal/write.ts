import type { CallContext, ContributionName } from '@makaio/core';
import type { HostTransaction } from '../host-database/index.js';
import type { ExternalObjectRef } from './external-object-ref.js';
import type { WriteRecordId } from './write-identifiers.js';
import type { JournalWritesPage, JournalWritesRequest, WriteRequest } from './write-schemas.js';

/**
 * Successful outcome of a write. Resolved, not thrown.
 */
export type WriteResult =
  | {
      /** The content was written to the external object. */
      readonly outcome: 'written';
      /** The external object the content was written to. */
      readonly object: ExternalObjectRef;
    }
  | {
      /** The external object already carried this content; nothing was written. */
      readonly outcome: 'unchanged';
      /** The external object that already carries the content. */
      readonly object: ExternalObjectRef;
    }
  | {
      /** A write with a later order was applied already; this one was skipped. */
      readonly outcome: 'outdated';
      /** The external object the later write was applied to. */
      readonly object: ExternalObjectRef;
    };

/**
 * Failed outcome of a write. Resolved, not thrown: `write` resolves with
 * `WriteResult | WriteError`.
 */
export type WriteError =
  | {
      /** The request is invalid. */
      readonly error: 'invalid-request';
      /** Why the request was rejected. */
      readonly reason: string;
    }
  | {
      /** The writer refused the write definitively. */
      readonly error: 'not-written';
      /** Machine-readable refusal code of the writer. */
      readonly code: string;
      /** Why the write was refused. */
      readonly reason: string;
    }
  | {
      /** The write failed for a reason that may pass; it can be retried. */
      readonly error: 'transient';
      /** Why the write failed. */
      readonly reason: string;
    }
  | {
      /** It is not known whether the write took effect. */
      readonly error: 'unresolved';
      /** The write record that awaits resolution. */
      readonly writeRecordId: WriteRecordId;
    }
  | {
      /** A required write participant is inactive. An earlier intent may already have been reconciled. */
      readonly error: 'participant-unavailable';
      /** Name of the write participant that is not active. */
      readonly participant: ContributionName;
    };

/**
 * Input of {@link WritesCapability.readWrites}.
 *
 * With `tx` the read runs inside that transaction.
 */
export type ReadWritesInput = JournalWritesRequest & {
  /** Transaction the read runs in; without it the read runs on its own. */
  readonly tx?: HostTransaction;
};

/**
 * Capability of the journal writes as seen by an extension.
 * Reading and manual resolution use the right for their respective subject, regardless of who owns the record.
 */
export interface WritesCapability {
  /**
   * Performs one write through the writer the request names.
   * Order and checksum are evaluated per writer and key, even when different keys address the same object.
   * An equal order is current and can be applied or returned as unchanged when the checksum matches.
   * A credential resolution failure returns `transient` with reason `credential-unavailable` while the deadline is active.
   * @param call - Context of the calling extension.
   * @param request - The write to perform.
   * @returns The result of the write, or the error; failures are resolved, not thrown.
   */
  write(call: CallContext, request: WriteRequest): Promise<WriteResult | WriteError>;

  /**
   * Reads write records, one page at a time.
   * Use the returned intent ID when submitting a manual resolution for a record.
   * @param call - Context of the calling extension.
   * @param input - What to read, the paging bounds and optionally the transaction to read in.
   * @returns One page of write records.
   */
  readWrites(call: CallContext, input: ReadWritesInput): Promise<JournalWritesPage>;
}
