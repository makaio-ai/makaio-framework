import type { CallContext, CallContextRecord } from '@makaio/core';
import type { ExternalObjectRef, WriteRequest, WriteState, WriteTarget } from '@makaio/contracts/journal';
import type { JournalWriteRow } from './storage/write-schema.js';
import { externalIdentity, WriteStore, writeView } from './storage/write-store.js';
import type { WriteContributionProcessor } from './write-contributions.js';

/** The named participant stopped before a transition could commit. */
export class WriteParticipantUnavailable extends Error {
  /** @param participant - Name stored with the intent. */
  public constructor(public readonly participant: string) {
    super('Write participant unavailable.');
  }
}

/** The participant rejected the proposed transition. */
export class WriteParticipantFailed extends Error {
  /** @param cause - Internal error from the participant. */
  public constructor(cause: unknown) {
    super('Write participant rejected the transition.', { cause });
  }
}

/**
 * Classify participant failures separately from storage and lifecycle failures.
 * @param work - One participant callback.
 * @returns The prepared participant work or its committed result.
 */
async function runParticipant<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new WriteParticipantFailed(error);
  }
}

interface NewIntent {
  readonly request: WriteRequest;
  readonly target: WriteTarget;
  readonly owner: string;
  readonly writerOwner: string;
  readonly call: CallContext;
  readonly leaseUntil: number;
  readonly before?: JournalWriteRow;
}

/** The current call expired before a recovery could release the intent. */
export class WriteDeadlineExpired extends Error {}

/**
 * Reject a guarded transition once its caller's deadline has expired.
 * @param deadline - Deadline on an external result that permits release.
 */
function checkDeadline(deadline: number | undefined): void {
  if (deadline !== undefined && deadline <= Date.now()) throw new WriteDeadlineExpired();
}

/** Participant lookup and transition storage. */
export class WriteTransitions {
  /**
   * @param store - Storage for transactional changes.
   * @param contributions - Active write participants.
   */
  public constructor(
    private readonly store: WriteStore,
    private readonly contributions: WriteContributionProcessor,
  ) {}

  /**
   * Prepare and persist one transition.
   * @param call - Call causing the transition.
   * @param before - Expected current row.
   * @param after - Proposed row.
   * @param releaseDeadline - Deadline of the external attempt that permits a release.
   * @returns Whether the change won the conditional update and committed.
   */
  public async commit(
    call: CallContext,
    before: JournalWriteRow | undefined,
    after: JournalWriteRow,
    releaseDeadline?: number,
  ): Promise<boolean> {
    const data = after.intent.participant;
    if (!data) {
      return this.store.change(
        before,
        after,
        releaseDeadline === undefined
          ? undefined
          : async () => {
              checkDeadline(releaseDeadline);
            },
      );
    }
    const current = () => this.contributions.participant(after.intent.owner, data.name);
    const participant = current();
    if (!participant) throw new WriteParticipantUnavailable(data.name);
    const prepared = await runParticipant(() =>
      participant.prepare(
        call,
        structuredClone({
          record: writeView(after),
          intentId: after.intentId,
          from: before?.state ?? null,
          to: after.state,
          data: data.data,
        }),
      ),
    );
    checkDeadline(releaseDeadline);
    return this.store.change(before, after, async (tx) => {
      checkDeadline(releaseDeadline);
      if (current() !== participant) throw new WriteParticipantUnavailable(data.name);
      await runParticipant(() => prepared.commit(tx));
      checkDeadline(releaseDeadline);
      if (current() !== participant) throw new WriteParticipantUnavailable(data.name);
    });
  }
}

/**
 * Build a new intent for the stable record of this key.
 * @param input - Admission inputs and optional previous record.
 * @returns An intended row ready for a conditional transition.
 */
export function newIntent({
  request,
  target,
  owner,
  writerOwner,
  call,
  leaseUntil,
  before,
}: NewIntent): JournalWriteRow {
  const { key, writer, ...input } = request;
  const startedAt = Date.now();
  const object = 'existing' in target ? target.existing : null;
  const parent = ('create' in request.target ? request.target.create.parent : object?.parent) ?? before?.parent ?? null;
  const { caller, principal, attestedBy } = call;
  const ctx: CallContextRecord = { caller, principal, ...(attestedBy && { attestedBy }) };
  const { appliedObject, checksum, appliedOrder } = before ?? {
    appliedObject: null,
    checksum: null,
    appliedOrder: null,
  };
  return {
    writeRecordId: before?.writeRecordId ?? crypto.randomUUID(),
    writer,
    key,
    createdAt: before?.createdAt ?? startedAt,
    state: 'intended',
    version: crypto.randomUUID(),
    leaseUntil,
    intentId: crypto.randomUUID(),
    intent: {
      ...input,
      target,
      keyTarget: before?.intent.keyTarget ?? request.target,
      requestTarget: request.target,
      owner,
      writerOwner,
      startedAt,
    },
    ctx,
    object,
    appliedObject,
    objectKey: object && externalIdentity(object),
    parent,
    parentKey: parent && externalIdentity(parent),
    checksum,
    appliedOrder,
  };
}

/**
 * Record a confirmed object and restore the pre-intent target on release.
 * @param row - Current row.
 * @param state - Next durable state.
 * @param object - Confirmed object, when the intent actually took effect.
 * @returns The resulting row.
 */
export function completedIntent(row: JournalWriteRow, state: WriteState, object?: ExternalObjectRef): JournalWriteRow {
  const { target, keyTarget } = row.intent;
  const released = state === 'released' && object === undefined;
  const nextObject = released ? (row.appliedObject ?? ('existing' in target ? target.existing : null)) : object;
  const requestedParent = 'create' in keyTarget ? keyTarget.create.parent : keyTarget.existing.parent;
  const parent = (released ? requestedParent : row.parent) ?? nextObject?.parent ?? null;
  return {
    ...row,
    state,
    version: crypto.randomUUID(),
    ...(nextObject !== undefined && {
      object: nextObject,
      objectKey: nextObject && externalIdentity(nextObject),
      parent,
      parentKey: parent && externalIdentity(parent),
    }),
    ...(object &&
      (state === 'written' || state === 'resolved') && {
        appliedObject: object,
        checksum: row.intent.checksum ?? null,
        appliedOrder: row.intent.order ?? null,
      }),
  };
}
