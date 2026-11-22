import { z } from 'zod';
import { isSubjectName, isSubjectPattern } from '@makaio/core';
import type { ContributionName } from '@makaio/core';

/** Schema of a subject name: a non-empty, concrete, addressable subject with no wildcard. */
export const SubjectNameSchema = z.string().refine(isSubjectName, {
  message: 'Subject name must be a non-empty "<namespace>.<subject>" string with no wildcard.',
});

/**
 * Name of an event or request on the bus, declared by exactly one extension
 * (for example `github.pull-request.opened`).
 */
export type SubjectName = z.infer<typeof SubjectNameSchema>;

/**
 * Schema of a pattern that selects subjects. It follows the subscription
 * grammar read by `matchesSubscription`:
 *
 * - `*` alone matches every subject.
 * - A pattern without a star matches exactly that name (a `SubjectName`).
 * - `x.*` matches every subject that starts with `x.`, with any number of
 *   further segments.
 * - `x:*` matches every subject that starts with `x:`, including all child
 *   namespaces.
 *
 * There is no `**` and no star in the middle of a pattern.
 */
export const SubjectPatternSchema = z
  .string()
  .refine(isSubjectPattern, { message: 'Subject pattern must be "*", a subject name, "<prefix>.*", or "<prefix>:*".' });

/** Pattern that selects subjects; see `SubjectPatternSchema` for the grammar. */
export type SubjectPattern = z.infer<typeof SubjectPatternSchema>;

/** Schema of a journal entry identifier: a non-empty string. */
export const EntryIdSchema = z.string().min(1);

/**
 * Identifier of a journal entry. A journal entry is one recorded event and
 * never changes after it was written.
 */
export type EntryId = z.infer<typeof EntryIdSchema>;

/**
 * Name of an inbound edge: the way events of one external system come in
 * (for example `github.webhook`). Owned by the contributing extension like
 * every contribution name.
 */
export type EdgeName = ContributionName;

/**
 * Name of a reader: a contribution that processes entries of the journal with
 * its own reading state.
 */
export type ReaderName = ContributionName;

/**
 * Position of an entry: the monotonically increasing ordinal of an entry over
 * the whole journal.
 */
export const PositionSchema = z.number().int().nonnegative();
/** Position of an entry in the journal. */
export type Position = z.infer<typeof PositionSchema>;
