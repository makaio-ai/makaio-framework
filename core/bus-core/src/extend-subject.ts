import type { SubjectDefinition } from '@makaio/core';
import type { z } from 'zod';
import type { IMakaioBus, MakaioBusContext } from './types/bus.js';
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
 * Pure declaration of a subject extension.
 *
 * This keeps TypeScript's widened subject inference available to importers
 * without mutating the runtime namespace registry at module import time.
 * The owning package must call {@link DefinedSubjectExtension.register} during
 * its activation lifecycle, after the base namespace has been registered.
 */
export interface DefinedSubjectExtension<SD extends SubjectDefinition, Ext extends SubjectExtension<SD>> {
  /** Subject definition with widened payload inference. */
  readonly subject: ExtendedSubjectDefinition<SD, Ext>;
  /**
   * Register the extension against the runtime bus namespace registry.
   * @param bus - Bus instance whose namespace registry receives the extension.
   * @returns The same subject definition with widened payload inference.
   */
  register(bus: Pick<IMakaioBus, 'extendSubject'>): ExtendedSubjectDefinition<SD, Ext>;
}

/**
 * Declare a subject extension without registering it immediately.
 *
 * Use this for product or extension modules that export typed subjects but
 * cannot safely mutate the namespace registry at import time. Registration
 * remains explicit via the returned `register()` method.
 * @param subject - Base subject definition to widen.
 * @param extension - Additional Zod fields for the subject payload.
 * @returns A declaration containing the widened subject and activation-time registration hook.
 */
export function defineSubjectExtension<SD extends SubjectDefinition, Ext extends SubjectExtension<SD>>(
  subject: SD,
  extension: Ext,
): DefinedSubjectExtension<SD, Ext> {
  const extendedSubject = subject as unknown as ExtendedSubjectDefinition<SD, Ext>;
  return {
    subject: extendedSubject,
    register(bus) {
      return bus.extendSubject(subject, extension);
    },
  };
}

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
