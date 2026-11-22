import { z } from 'zod';
import { SubjectNameSchema, SubjectPatternSchema } from '../journal/identifiers.js';
import { JsonValueSchema } from '../shared/json-value.js';
import type { RightName } from './right.js';

/**
 * The right the core declares for sending a subject.
 */
export const SUBJECT_SEND_RIGHT = 'makaio.subject.send' satisfies RightName;

/**
 * The right the core declares for subscribing to a subject.
 */
export const SUBJECT_SUBSCRIBE_RIGHT = 'makaio.subject.subscribe' satisfies RightName;

/**
 * The context of a question about the right to send a subject.
 */
export const SubjectSendRightContextSchema = z
  .object({
    /** The subject sent or delivered. */
    subject: SubjectNameSchema,
    /** The payload, when the answer may depend on it. */
    payload: JsonValueSchema.optional(),
    /** Present only when the question is asked while rules are checked at load time; it carries the catalog context of that check. */
    check: JsonValueSchema.optional(),
  })
  .strict();
/** The context of a question about the right to send a subject. */
export type SubjectSendRightContext = z.infer<typeof SubjectSendRightContextSchema>;

/**
 * The context of a question about the right to subscribe to a subject. It
 * names exactly one target: a delivered `subject` or a subscription `pattern`.
 */
export const SubjectSubscribeRightContextSchema = z.union([
  z
    .object({
      /** The subject delivered to the subscriber. */
      subject: SubjectNameSchema,
      /** Not allowed together with `subject`: a question names exactly one target. */
      pattern: z.never().exactOptional(),
      /** The payload, when the answer may depend on it. */
      payload: JsonValueSchema.optional(),
      /** Present only when the question is asked while rules are checked at load time; it carries the catalog context of that check. */
      check: JsonValueSchema.optional(),
    })
    .strict(),
  z
    .object({
      /** Not allowed together with `pattern`: a question names exactly one target. */
      subject: z.never().exactOptional(),
      /** The pattern of a subscription, in the bus subscription grammar. */
      pattern: SubjectPatternSchema,
      /** The payload, when the answer may depend on it. */
      payload: JsonValueSchema.optional(),
      /** Present only when the question is asked while rules are checked at load time; it carries the catalog context of that check. */
      check: JsonValueSchema.optional(),
    })
    .strict(),
]);
/** The context of a question about the right to subscribe to a subject. */
export type SubjectSubscribeRightContext = z.infer<typeof SubjectSubscribeRightContextSchema>;
