import { isDeepStrictEqual } from 'node:util';
import type { CredentialResolution, HostDatabase, Secret } from '@makaio/contracts';
import {
  ExternalObjectRefSchema,
  type ExternalObjectRef,
  type FindExistingOutcome,
  type JournalResolveWriteRequest,
  type JournalResolveWriteResponse,
  type WriteError,
  type WriteRequest,
  type WriteResult,
  type WriteState,
  type WriteTarget,
  type WriterOutcome,
} from '@makaio/contracts/journal';
import type { CallContext } from '@makaio/core';
import { externalIdentity, WriteStore, writeView } from './storage/write-store.js';
import type { JournalWriteRow, StoredWriteIntent } from './storage/write-schema.js';
import { type RegisteredWriter, WriteContributionProcessor } from './write-contributions.js';
import {
  completedIntent,
  newIntent,
  WriteDeadlineExpired,
  WriteParticipantFailed,
  WriteParticipantUnavailable,
  WriteTransitions,
} from './write-transitions.js';

type Outcome = WriteResult | WriteError;

interface Attempt {
  readonly writer: RegisteredWriter;
  readonly credential: Secret;
  readonly deadline: number;
}

const IN_PROGRESS = { error: 'transient', reason: 'in-progress' } as const;
const TRANSITION_FAILED = { error: 'transient', reason: 'write-transition-failed' } as const;
const DEADLINE_EXPIRED = { error: 'transient', reason: 'write-deadline-expired' } as const;
const LOOKUP_FAILED = { error: 'transient', reason: 'write-lookup-failed' } as const;
const NOT_FOUND = { error: 'transient', reason: 'write-not-found' } as const;
const TARGET_MISMATCH = { error: 'invalid-request', reason: 'key-target-mismatch' } as const;

/**
 * Translate transactional failures without exposing contributor errors.
 * @param error - Failure from preparation or transactional commit.
 * @returns Typed failure for the caller.
 */
function transitionFailure(error: unknown): WriteError {
  if (error instanceof WriteDeadlineExpired) return DEADLINE_EXPIRED;
  return error instanceof WriteParticipantUnavailable
    ? { error: 'participant-unavailable', participant: error.participant }
    : TRANSITION_FAILED;
}

/**
 * Reject a result that would change an intent's target identity.
 * @param target - Target recorded before dispatch.
 * @param candidate - Reported object.
 * @param owner - Owner of the writer contribution.
 * @returns The object when it matches the intended target.
 */
function acceptedObject(
  target: WriteTarget,
  candidate: ExternalObjectRef,
  owner: string,
): ExternalObjectRef | undefined {
  const parsed = ExternalObjectRefSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const object = parsed.data;
  if ('existing' in target) return externalIdentity(object) === externalIdentity(target.existing) ? object : undefined;
  return object.extension === owner &&
    object.site === target.create.site &&
    object.objectType === target.create.objectType
    ? object
    : undefined;
}

/**
 * Determine the actual operation of the new intent.
 * @param request - Validated request.
 * @param row - Current row, when one exists.
 * @returns Target, or undefined if the key is already tied to a different object.
 */
function targetFor(request: WriteRequest, row?: JournalWriteRow): WriteTarget | undefined {
  const { target } = request;
  if (!row) return target;
  if ('existing' in target) {
    return row.object && externalIdentity(target.existing) === externalIdentity(row.object)
      ? { existing: row.object }
      : undefined;
  }
  const bound = row.intent.keyTarget;
  if ('existing' in bound) return undefined;
  const { site, objectType, parent } = bound.create;
  const nextParent = target.create.parent;
  if (
    target.create.site !== site ||
    target.create.objectType !== objectType ||
    (parent && externalIdentity(parent)) !== (nextParent && externalIdentity(nextParent))
  ) {
    return undefined;
  }
  return row.object ? { existing: row.object } : bound;
}

/**
 * Return a result that requires no new attempt.
 * @param request - Validated request.
 * @param row - Latest state of the write.
 * @returns The shortcut result, when applicable.
 */
function settledResult(request: WriteRequest, row?: JournalWriteRow): WriteResult | undefined {
  if (!row?.appliedObject) return undefined;
  const { appliedObject: object, appliedOrder, checksum } = row;
  if (request.order !== undefined && appliedOrder !== null && request.order < appliedOrder)
    return { outcome: 'outdated', object };
  if (request.checksum !== undefined && request.checksum === checksum) {
    return { outcome: 'unchanged', object };
  }
  return undefined;
}

/**
 * Compare the public inputs in their persisted JSON form. The key and writer already match the loaded row.
 * @param request - Current write request.
 * @param intent - Persisted write input.
 * @returns Whether the current request can reuse the recovered intent's result.
 */
function matchesIntent(request: WriteRequest, intent: StoredWriteIntent): boolean {
  // Older intents only have the effective target, which may differ from the requested target.
  if (intent.requestTarget === undefined) return false;
  const { key: _key, writer: _writer, ...input } = request;
  const { requestTarget: target, content, checksum, order, credential, participant } = intent;
  const current: unknown = JSON.parse(JSON.stringify(input));
  const persisted: unknown = { target, content, checksum, order, credential, participant };
  return isDeepStrictEqual(current, JSON.parse(JSON.stringify(persisted)));
}

/** Durable workflow for one external write and its reconciliation. */
export class ExternalWriteJournal {
  public readonly store: WriteStore;
  private readonly transitions: WriteTransitions;

  /**
   * @param host - Database facade shared with write participants.
   * @param contributions - Registry of live writers, participants and credential resolver.
   */
  public constructor(
    host: HostDatabase,
    private readonly contributions: WriteContributionProcessor,
  ) {
    this.store = new WriteStore(host);
    this.transitions = new WriteTransitions(this.store, contributions);
  }

  /**
   * Start a new attempt or reconcile the existing one.
   * @param owner - Extension whose capability is used.
   * @param call - Authorized call context.
   * @param request - Validated write request.
   * @param deadline - Writer deadline in epoch milliseconds.
   * @returns Business outcome of the operation.
   */
  public async write(owner: string, call: CallContext, request: WriteRequest, deadline: number): Promise<Outcome> {
    const writer = this.contributions.writer(request.writer);
    if (!writer) return { error: 'invalid-request', reason: 'unknown-writer' };
    const row = await this.store.load(request);
    // An explicit update needs a confirmed object binding. Retry the original create to recover that binding.
    if (!targetFor(request, row)) return TARGET_MISMATCH;
    const target = request.target;
    const objectType = 'create' in target ? target.create.objectType : target.existing.objectType;
    if (
      !writer.contribution.objectTypes.includes(objectType) ||
      !writer.accepts(request.content) ||
      ('existing' in target && target.existing.extension !== writer.owner)
    ) {
      return { error: 'invalid-request', reason: 'writer-target-or-content-invalid' };
    }
    if (row?.state === 'intended' && row.leaseUntil <= Date.now()) {
      return this.resume(owner, call, request, row, writer, deadline);
    }
    return this.start(owner, call, request, writer, deadline, row);
  }

  /**
   * Open a fresh intent before invoking the writer.
   * @param owner - Extension whose capability is used.
   * @param call - Authorized context.
   * @param request - Validated write request.
   * @param writer - The requested writer.
   * @param deadline - Writer deadline.
   * @param before - Prior record at this key, if any.
   * @returns Business outcome of the attempt.
   */
  private async start(
    owner: string,
    call: CallContext,
    request: WriteRequest,
    writer: RegisteredWriter,
    deadline: number,
    before?: JournalWriteRow,
  ): Promise<Outcome> {
    const target = targetFor(request, before);
    if (!target) return TARGET_MISMATCH;
    if (before?.state === 'unresolved') return { error: 'unresolved', writeRecordId: before.writeRecordId };
    if (before?.state === 'intended') return IN_PROGRESS;
    const settled = settledResult(request, before);
    if (settled) return settled;

    const row = newIntent({ request, target, owner, writerOwner: writer.owner, call, leaseUntil: deadline, before });
    const attempt = await this.prepareAttempt(call, row.intent, writer, deadline);
    if ('error' in attempt) return attempt;
    try {
      if (!(await this.transitions.commit(call, before, row))) return IN_PROGRESS;
    } catch (error) {
      return transitionFailure(error);
    }
    return this.dispatch(call, row, attempt);
  }

  /**
   * Recover an expired intent with its stored input.
   * @param owner - Extension whose capability is used.
   * @param call - Authorized retry context.
   * @param request - Current write request.
   * @param row - Persisted intent.
   * @param writer - The live writer.
   * @param deadline - Deadline of this recovery call.
   * @returns The result of the current request.
   */
  private async resume(
    owner: string,
    call: CallContext,
    request: WriteRequest,
    row: JournalWriteRow,
    writer: RegisteredWriter,
    deadline: number,
  ): Promise<Outcome> {
    if (row.intent.owner !== owner || row.intent.writerOwner !== writer.owner)
      return { error: 'invalid-request', reason: 'intent-owner-mismatch' };
    const attempt = await this.prepareAttempt(call, row.intent, writer, deadline);
    if ('error' in attempt) return attempt;
    const recovered = await this.reconcile(call, row, attempt);
    if (!('outcome' in recovered) && recovered.error !== 'unresolved' && recovered !== NOT_FOUND) return recovered;
    if (matchesIntent(request, row.intent)) return recovered;
    return this.start(owner, call, request, writer, deadline, await this.store.load(request));
  }

  /**
   * Resolve the active participant and a credential using the writer's extension identity.
   * @param call - Original operation context.
   * @param intent - Stored intent input.
   * @param writer - Writer to which the credential is delivered.
   * @param deadline - Deadline for the external callback.
   * @returns Prepared attempt or typed refusal.
   */
  private async prepareAttempt(
    call: CallContext,
    intent: StoredWriteIntent,
    writer: RegisteredWriter,
    deadline: number,
  ): Promise<Attempt | WriteError> {
    const participant = intent.participant?.name;
    if (participant && !this.contributions.participant(intent.owner, participant)) {
      return { error: 'participant-unavailable', participant };
    }
    if (deadline <= Date.now()) return DEADLINE_EXPIRED;
    const resolver = this.contributions.credentialResolver();
    let result: CredentialResolution | undefined;
    try {
      result = await resolver?.resolve(call, { ...intent.credential, requester: writer.owner });
    } catch {
      result = undefined;
    }
    if (deadline <= Date.now()) return DEADLINE_EXPIRED;
    if (!result?.success) return { error: 'transient', reason: 'credential-unavailable' };
    return { writer, credential: result.value, deadline };
  }

  /**
   * Invoke the external writer after the intent transaction commits.
   * @param call - Authorized context.
   * @param row - Committed intent.
   * @param attempt - Active contributions and credential.
   * @returns Business outcome.
   */
  private async dispatch(call: CallContext, row: JournalWriteRow, attempt: Attempt): Promise<Outcome> {
    if (this.contributions.writer(row.writer) !== attempt.writer) {
      return this.finish(call, row, 'released', { error: 'transient', reason: 'writer-unavailable' });
    }
    const { target, content } = structuredClone(row.intent);
    const common = {
      content,
      intentId: row.intentId,
      credential: attempt.credential,
      deadline: new Date(attempt.deadline).toISOString(),
    };
    if (attempt.deadline <= Date.now()) return this.finish(call, row, 'released', DEADLINE_EXPIRED);
    let outcome: WriterOutcome;
    try {
      outcome = await attempt.writer.contribution.write(
        'create' in target
          ? { ...common, mode: 'create', create: target.create }
          : { ...common, mode: 'update', object: target.existing },
      );
    } catch {
      return this.reconcile(call, row, attempt);
    }
    if (outcome?.notWritten) {
      const { retryable, code, reason } = outcome.notWritten;
      return retryable
        ? this.finish(call, row, 'released', { error: 'transient', reason })
        : this.finish(call, row, 'not-written', { error: 'not-written', code, reason });
    }
    const object = outcome?.written ? acceptedObject(target, outcome.written, attempt.writer.owner) : undefined;
    return object
      ? this.finish(call, row, 'written', { outcome: 'written', object }, object)
      : this.reconcile(call, row, attempt);
  }

  /**
   * Reconcile a potentially executed intent by querying the external system.
   * @param call - Authorized context.
   * @param row - Intent to recover.
   * @param attempt - Active contributions and credential.
   * @returns Recovered or unresolved outcome.
   */
  private async reconcile(call: CallContext, row: JournalWriteRow, attempt: Attempt): Promise<Outcome> {
    if (this.contributions.writer(row.writer) !== attempt.writer) {
      return { error: 'transient', reason: 'writer-unavailable' };
    }
    const { target, content } = structuredClone(row.intent);
    const input = {
      intentId: row.intentId,
      target,
      content,
      credential: attempt.credential,
      deadline: new Date(attempt.deadline).toISOString(),
    };
    if (attempt.deadline <= Date.now()) return DEADLINE_EXPIRED;
    let result: FindExistingOutcome | undefined;
    try {
      result = await attempt.writer.contribution.findExisting(input);
    } catch {
      result = undefined;
    }
    if (!result) return attempt.deadline <= Date.now() ? DEADLINE_EXPIRED : LOOKUP_FAILED;
    const object =
      result.found && result.absent === undefined && result.undecidable === undefined
        ? acceptedObject(target, result.found, attempt.writer.owner)
        : undefined;
    if (object) return this.finish(call, row, 'written', { outcome: 'unchanged', object }, object);
    if (result.absent === true && result.found === undefined && result.undecidable === undefined) {
      if (attempt.deadline <= Date.now()) return DEADLINE_EXPIRED;
      return this.finish(call, row, 'released', NOT_FOUND, undefined, attempt.deadline);
    }
    return this.finish(call, row, 'unresolved', { error: 'unresolved', writeRecordId: row.writeRecordId });
  }

  /**
   * Commit the outcome only if the same intent is still active.
   * @param call - Authorized context.
   * @param row - Expected current row.
   * @param state - Resulting state.
   * @param outcome - Outcome to return after commit.
   * @param object - Confirmed object, when applicable.
   * @param releaseDeadline - Deadline that bounds a release based on an external result.
   * @returns Business outcome or a retryable persistence failure.
   */
  private async finish(
    call: CallContext,
    row: JournalWriteRow,
    state: WriteState,
    outcome: Outcome,
    object?: ExternalObjectRef,
    releaseDeadline?: number,
  ): Promise<Outcome> {
    try {
      const committed = await this.transitions.commit(call, row, completedIntent(row, state, object), releaseDeadline);
      return committed ? outcome : IN_PROGRESS;
    } catch (error) {
      if (state === 'written' && error instanceof WriteParticipantFailed) {
        // Retain the confirmed object. Keep the committed intent when its
        // participant also refuses the separate transition to unresolved.
        return this.finish(call, row, 'unresolved', { error: 'unresolved', writeRecordId: row.writeRecordId }, object);
      }
      return transitionFailure(error);
    }
  }

  /**
   * Resolve an unresolved or expired intent through its original participant.
   * @param call - Authorized operator context.
   * @param request - Manual decision and the reviewed record and intent identifiers.
   * @returns The committed disposition or refusal.
   */
  public async resolve(call: CallContext, request: JournalResolveWriteRequest): Promise<JournalResolveWriteResponse> {
    const row = await this.store.load(request);
    if (!row) return { success: false, code: 'not-found' };
    if (row.intentId !== request.intentId) return { success: false, code: 'stale-intent' };
    const expiredIntent = row.state === 'intended' && row.leaseUntil <= Date.now();
    if (row.state !== 'unresolved' && !expiredIntent) return { success: false, code: 'not-unresolved' };
    const { resolution } = request;
    const object =
      'found' in resolution ? acceptedObject(row.intent.target, resolution.found, row.intent.writerOwner) : undefined;
    if ('found' in resolution && !object) throw new RangeError('Resolution does not match the stored write target.');
    const next = completedIntent(row, object ? 'resolved' : 'released', object);
    try {
      // The conditional update checks the loaded version before committing any participant work.
      if (!(await this.transitions.commit(call, row, next))) return { success: false, code: 'stale-intent' };
    } catch (error) {
      if (error instanceof WriteParticipantUnavailable) return { success: false, code: 'participant-unavailable' };
      throw error;
    }
    return { success: true, record: writeView(next) };
  }
}
