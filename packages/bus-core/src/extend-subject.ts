import type { SubjectDefinition } from '@makaio/core';
import type { z } from 'zod';
import type { MakaioBusContext } from './types/bus.js';
import { getFullSubjectForSubjectDefinition } from './utils/subject-transformation.js';

/**
 * Additional fields to add to a request subject's request and/or response schemas.
 * Omit either key to leave that side unchanged.
 */
export interface RequestSubjectExtension {
  request?: Record<string, z.ZodType>;
  response?: Record<string, z.ZodType>;
}

/**
 * Additional fields to add to an event subject's payload schema.
 */
export type EventSubjectExtension = Record<string, z.ZodType>;

/**
 * Infers the correct extension shape based on whether the subject is a request or event.
 */
export type SubjectExtension<SD extends SubjectDefinition> = SD['$meta']['isRequest'] extends true
  ? RequestSubjectExtension
  : EventSubjectExtension;

type ExtendWithInput<Original, Ext extends Record<string, z.ZodType>> = Omit<Original, keyof Ext> & {
  [K in keyof Ext as undefined extends z.input<Ext[K]> ? never : K]: z.input<Ext[K]>;
} & {
  [K in keyof Ext as undefined extends z.input<Ext[K]> ? K : never]?: z.input<Ext[K]>;
};

type ExtendWithInfer<Original, Ext extends Record<string, z.ZodType>> = Omit<Original, keyof Ext> & {
  [K in keyof Ext as undefined extends z.infer<Ext[K]> ? never : K]: z.infer<Ext[K]>;
} & {
  [K in keyof Ext as undefined extends z.infer<Ext[K]> ? K : never]?: z.infer<Ext[K]>;
};

type ExtendedRequestPayload<OrigPayload, Ext extends RequestSubjectExtension> = {
  request: Ext['request'] extends Record<string, z.ZodType>
    ? ExtendWithInput<OrigPayload extends { request: infer R } ? R : never, Ext['request']>
    : OrigPayload extends { request: infer R }
      ? R
      : never;
  response: Ext['response'] extends Record<string, z.ZodType>
    ? ExtendWithInfer<OrigPayload extends { response: infer R } ? R : never, Ext['response']>
    : OrigPayload extends { response: infer R }
      ? R
      : never;
};

/**
 * A SubjectDefinition with overridden `$meta.payload` — preserves all other metadata.
 */
export type ExtendedSubjectDefinition<SD extends SubjectDefinition, Ext extends SubjectExtension<SD>> = {
  subject: SD['subject'];
  $meta: {
    namespace: SD['$meta']['namespace'];
    isRequest: SD['$meta']['isRequest'];
    local: SD['$meta']['local'];
    channel: SD['$meta']['channel'];
    payload: SD['$meta']['isRequest'] extends true
      ? Ext extends RequestSubjectExtension
        ? ExtendedRequestPayload<SD['$meta']['payload'], Ext>
        : SD['$meta']['payload']
      : Ext extends Record<string, z.ZodType>
        ? ExtendWithInfer<SD['$meta']['payload'], Ext>
        : SD['$meta']['payload'];
  };
};

/**
 * Extend a registered bus subject's schema with additional fields.
 *
 * Called on the bus context directly. Adds new fields to the Zod schema for
 * dev-mode validation and widens the TypeScript payload type. Successive calls
 * accumulate fields — two packages can independently extend the same subject
 * with different field names. If two extensions add the same field name,
 * the later call's definition wins (Zod `.extend()` semantics).
 *
 * The returned value is the same runtime object — only the TypeScript type widens.
 * @param context - Bus context containing the namespace registry
 * @param subject - The SubjectDefinition to extend
 * @param extensions - Additional Zod fields to add
 * @returns The same SubjectDefinition with wider TypeScript types
 */
export function extendSubjectImpl<SD extends SubjectDefinition, Ext extends SubjectExtension<SD>>(
  context: MakaioBusContext,
  subject: SD,
  extensions: Ext,
): ExtendedSubjectDefinition<SD, Ext> {
  const fullKey = getFullSubjectForSubjectDefinition(subject);
  context.namespaceRegistry.extendSubjectSchema(
    fullKey,
    extensions as z.ZodRawShape | { request?: z.ZodRawShape; response?: z.ZodRawShape },
  );
  // Runtime object is unchanged — only the TypeScript type widens.
  // The double cast is unavoidable: SD and ExtendedSubjectDefinition
  // share no structural overlap that TS can verify statically.
  return subject as unknown as ExtendedSubjectDefinition<SD, Ext>;
}
