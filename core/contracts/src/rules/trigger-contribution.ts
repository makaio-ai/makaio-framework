import type { ZodType } from 'zod';
import type { SubjectName, SubjectPattern } from '../journal/identifiers.js';
import type { Condition } from '../shared/condition.js';
import type { JsonSchema, JsonValue } from '../shared/json-value.js';
import type { TriggerKind } from './identifiers.js';

/**
 * A trigger as an extension contributes it.
 *
 * A trigger is only a projection: it translates a journal entry or a message
 * into facts and carries no active part. The core never calls anything on a
 * trigger that starts a source; an active source (schedule, poll) is an
 * extension that records messages and derives its own timers from
 * `ctx.rules.triggers()`.
 */
export interface TriggerContribution {
  /** Kind of trigger. */
  readonly kind: TriggerKind;
  /** Human-readable description of the trigger. */
  readonly description: string;
  /** Fixed Zod schema of the trigger's parameters; absent means the trigger takes none. */
  readonly params?: ZodType;
  /**
   * Subjects this trigger fires from, for fixed parameters. A pure function;
   * `ruleTriggers()` and `validateRules` use this same derivation. For a catalog
   * read, undefined parameters ask for the default patterns or an empty list.
   * @param params - The trigger's fixed parameters.
   * @returns The subject patterns the trigger fires from.
   */
  subjects(params: JsonValue | undefined): SubjectPattern[];
  /**
   * JSON schema of the facts this trigger produces; may depend on the fixed
   * parameters and on the host's catalog context.
   * @param params - The trigger's fixed parameters.
   * @param catalogContext - Context forwarded by the host for catalog derivation.
   * @returns JSON schema of the produced facts.
   */
  facts(params: JsonValue | undefined, catalogContext: JsonValue | undefined): JsonSchema;
  /**
   * Parameters as a condition over `$event`; a pure function. Absent means
   * parameters filter nothing.
   * @param params - The trigger's fixed parameters.
   * @returns Condition that narrows which occasions the parameters admit.
   */
  expand?(params: JsonValue): Condition;
  /**
   * Translates a recorded entry or a received message into facts. A pure
   * function; `null` means the trigger does not fire for this message.
   * @param message - Subject and payload of the entry or message.
   * @returns Facts of the occasion, or `null` when the trigger does not fire.
   */
  toFacts(message: { readonly subject: SubjectName; readonly payload: JsonValue }): Record<string, JsonValue> | null;
}
