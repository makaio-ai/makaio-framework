import { CoreDenialPlace, type AccessDeniedError, type DenialPlace } from '@makaio/contracts/access';
import type { JournalEntry, Origin, SubjectName } from '@makaio/contracts/journal';
import type { JsonValue } from '@makaio/contracts';
import {
  RightDenialReason,
  SUBJECT_SEND_RIGHT,
  SUBJECT_SUBSCRIBE_RIGHT,
  type RightAnswer,
  type RightName,
  type RightQuestion,
} from '@makaio/contracts/rights';
import type { CallContext, ContributionName, Party } from '@makaio/core';

/** Host authority for reading from, and resuming work using, the journal. */
export interface JournalReaderAuthority {
  /** Resolve an uncached question over a stored row. */
  readonly resolve: (question: RightQuestion) => Promise<RightAnswer>;
  /** Publish a local access diagnostic. */
  readonly deny: (
    place: DenialPlace,
    denial: { right?: RightName; subject?: SubjectName; reason: string; by?: ContributionName },
  ) => AccessDeniedError;
  /** Bind the stored principal and attestation to work on behalf of the reader. */
  readonly bindCall: (caller: Party, origin: Origin) => CallContext;
}

/**
 * Resolve a host-local question and fail closed on resolver errors.
 * @param authority - Shared host resolver.
 * @param question - The right and context to check.
 * @returns The settled access decision.
 */
async function resolve(authority: JournalReaderAuthority, question: RightQuestion): Promise<RightAnswer> {
  try {
    return await authority.resolve(question);
  } catch {
    return { granted: false, reason: RightDenialReason.resolutionFailed };
  }
}

/**
 * Authorize a single recorded row, publishing the outcome of a refusal locally.
 * @param authority - Shared host resolver and diagnostic sink.
 * @param call - The identity to authorize.
 * @param entry - Stored row whose subject and payload form the right's context.
 * @returns The access decision, including any reason needed for retry.
 */
export async function resolveReadAccess(
  authority: JournalReaderAuthority,
  call: CallContext,
  entry: JournalEntry,
): Promise<RightAnswer> {
  const right = SUBJECT_SUBSCRIBE_RIGHT;
  const { subject, payload } = entry;
  const answer = await resolve(authority, { call, right, context: { subject, payload } });
  // A source sees the stored payload and may include it in its diagnostic fields.
  if (!answer.granted) authority.deny(CoreDenialPlace.read, { right, subject, reason: 'access-denied' });
  return answer;
}

/**
 * Authorize a reader-state query or reprocess request.
 * @param authority - Shared host resolver and diagnostic sink.
 * @param call - Caller of the request.
 * @param subject - Canonical request subject.
 * @param payload - Reader selection or entry requested for reprocessing.
 */
export async function requireReaderRequest(
  authority: JournalReaderAuthority,
  call: CallContext,
  subject: SubjectName,
  payload: JsonValue,
): Promise<void> {
  const right = SUBJECT_SEND_RIGHT;
  const answer = await resolve(authority, { call, right, context: { subject, payload } });
  if (!answer.granted) {
    throw authority.deny(CoreDenialPlace.send, { right, subject, reason: answer.reason, by: answer.by });
  }
}
