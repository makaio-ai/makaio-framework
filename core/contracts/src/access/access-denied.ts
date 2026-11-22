import { z } from 'zod';
import { CallContextRecordSchema, ContributionNameSchema } from '@makaio/core';
import type { ContributionName } from '@makaio/core';
import { SubjectNameSchema } from '../journal/identifiers.js';

/**
 * The place where a denial arose, an open name `<extension>.<name>`.
 */
export type DenialPlace = ContributionName;

/**
 * The eight places of the core where a denial can arise.
 */
export const CoreDenialPlace = {
  /** A verifier chain at a boundary. */
  boundary: 'makaio.boundary',
  /** A connection exchange at a boundary. */
  exchange: 'makaio.exchange',
  /** Sending a message. */
  send: 'makaio.send',
  /** Subscribing. */
  subscribe: 'makaio.subscribe',
  /** Delivering a message to a subscriber. */
  deliver: 'makaio.deliver',
  /** Reading journal entries or a reader. */
  read: 'makaio.read',
  /** A lookup. */
  lookup: 'makaio.lookup',
  /** A question asked by a handler. */
  handler: 'makaio.handler',
} as const;

/** One of the eight places of the core where a denial can arise. */
export type CoreDenialPlace = (typeof CoreDenialPlace)[keyof typeof CoreDenialPlace];

/**
 * A denial as announced by the volatile event that reports it.
 *
 * The schema is deliberately not strict: later fields may be added.
 */
export const AccessDeniedSchema = z.object({
  /** The place where the denial arose. */
  at: ContributionNameSchema,
  /** The serialisable record of the call context of the denied call. */
  ctx: CallContextRecordSchema.optional(),
  /** The right that was asked. */
  right: ContributionNameSchema.optional(),
  /** The subject concerned. */
  subject: SubjectNameSchema.optional(),
  /** Why the call was denied. */
  reason: z.string(),
  /** The verifier or answer source that denied. */
  by: ContributionNameSchema.optional(),
});
/** A denial as announced by the volatile event that reports it. */
export type AccessDenied = z.infer<typeof AccessDeniedSchema>;

/**
 * The data a denied caller gets: a denial without the call context.
 */
export const ForbiddenSchema = AccessDeniedSchema.omit({ ctx: true });
/** The data a denied caller gets. */
export type Forbidden = z.infer<typeof ForbiddenSchema>;

/** Machine-readable code of {@link AccessDeniedError}. */
export const ACCESS_DENIED_ERROR_CODE = 'forbidden';

/**
 * A denial by the core at a subject, before any handler runs.
 *
 * It applies to requests and subscriptions. Business outcomes of an operation
 * are not this error.
 */
export class AccessDeniedError extends Error {
  /** Machine-readable code of the error. */
  public readonly code = ACCESS_DENIED_ERROR_CODE;

  /** The data of the denial, as the denied caller gets it. */
  public readonly data: Forbidden;

  /**
   * @param data - The data of the denial; it is validated against {@link ForbiddenSchema}.
   * @param message - Human-readable error description; defaults to the reason of the denial.
   */
  public constructor(data: Forbidden, message?: string) {
    const parsed = ForbiddenSchema.parse(data);
    super(message ?? parsed.reason);
    this.name = 'AccessDeniedError';
    this.data = parsed;
  }
}
