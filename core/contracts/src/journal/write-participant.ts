import type { CallContext, ContributionName } from '@makaio/core';
import type { HostTransaction } from '../host-database/index.js';
import type { JsonValue } from '../shared/json-value.js';
import type { IntentId } from './write-identifiers.js';
import type { WriteRecordView, WriteState } from './write-schemas.js';

/**
 * One state change of a write, as handed to a write participant.
 */
export type WriteStateChange = {
  /** The write record after the transition. */
  readonly record: WriteRecordView;
  /** Identifier of the write intent. */
  readonly intentId: IntentId;
  /** The state before the transition; `null` only when the intent is created. */
  readonly from: WriteState | null;
  /** The state after the transition. */
  readonly to: WriteState;
  /** The participant data stored unchanged with the intent. */
  readonly data: JsonValue;
};

/**
 * The database work a write participant has prepared for one state change.
 */
export type WriteParticipantCommit = {
  /**
   * Performs the prepared database work. Only database work through the
   * transaction's query context is allowed here.
   * @param tx - The transaction the state change runs in.
   */
  commit(tx: HostTransaction): Promise<void>;
};

/**
 * Contribution of a write participant: code that takes part in the state
 * changes of writes that name it.
 *
 * The core runs `commit` and the conditional state change atomically; a throw
 * leaves the state unchanged. The participant is called only on state changes:
 * `intended` when the intent is created, `written` on a confirmed or found
 * write, `not-written` on a definitive refusal, `unresolved` when the lookup
 * cannot decide, `resolved` on a manual "found", `released` on a manual "not
 * written". A write that returns `unchanged` because the checksum already
 * matches changes no state and does not call it; a recovery that finds the
 * object and moves the record to `written` calls it, even though that write
 * also returns `unchanged`.
 */
export interface WriteParticipantContribution {
  /** Name the write requests use to address this participant. */
  readonly name: ContributionName;

  /**
   * Prepares the database work for one state change.
   * @param call - Context of the call that causes the state change.
   * @param change - The state change.
   * @returns The prepared work; the core commits it together with the state change.
   * @throws Any error; the state then stays unchanged.
   */
  prepare(call: CallContext, change: WriteStateChange): Promise<WriteParticipantCommit>;
}
