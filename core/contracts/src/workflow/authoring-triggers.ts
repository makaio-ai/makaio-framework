import type { ExtractSubjectPayload, PayloadFilter, SubjectDefinition, TypedPayloadFilter } from '@makaio/core';
import { getFullSubjectForSubjectDefinition } from '@makaio/core';
import { z } from 'zod';
import type { AutomationTriggerParams, DefinedAutomationTrigger } from '../automation-trigger/definition.js';
import { JsonRecordSchema } from '../shared/json-value.js';
import type { JsonValue } from '../shared/json-value.js';
import type { WorkflowAutomationTriggerBinding } from './schemas.js';

// ─────────────────────────────────────────────────────────────
// Built-in automation trigger kinds
// ─────────────────────────────────────────────────────────────

/** Canonical kind of the built-in bus-event automation trigger. */
export const BUS_EVENT_AUTOMATION_TRIGGER_KIND = 'makaio.bus-event';

/** Canonical kind of the built-in cron automation trigger. */
export const CRON_AUTOMATION_TRIGGER_KIND = 'makaio.cron';

/** Timezone applied to a cron binding when the author does not specify one. */
export const DEFAULT_CRON_TIMEZONE = 'UTC';

// ─────────────────────────────────────────────────────────────
// Typed Trigger Wrappers
// ─────────────────────────────────────────────────────────────

/**
 * A persisted workflow trigger binding with a phantom type parameter carrying
 * the payload type its trigger emits.
 *
 * The phantom field exists only in the type system: authoring helpers never
 * write it and `WorkflowAutomationTriggerBindingSchema` strips unknown keys, so
 * the persisted binding stays exactly {@link WorkflowAutomationTriggerBinding}.
 * @typeParam TPayload - The trigger event payload type
 */
export type WorkflowTriggerDef<TPayload> = WorkflowAutomationTriggerBinding & {
  /**
   * Phantom type carrier — never present at runtime.
   * Use `ExtractTriggerPayload<T>` to access this type.
   */
  readonly __payload?: TPayload;
};

/**
 * Extract the payload type from a {@link WorkflowTriggerDef}.
 * @typeParam T - The typed trigger definition
 */
export type ExtractTriggerPayload<T extends WorkflowTriggerDef<unknown>> =
  T extends WorkflowTriggerDef<infer TPayload> ? TPayload : never;

/**
 * Derives the trigger payload union from a tuple of typed trigger definitions.
 * @typeParam TTriggers - Trigger tuple supplied to `defineWorkflow`
 */
export type TriggerPayloadFromTriggers<TTriggers extends readonly WorkflowTriggerDef<unknown>[] | undefined> =
  TTriggers extends readonly WorkflowTriggerDef<unknown>[] ? ExtractTriggerPayload<TTriggers[number]> : never;

/**
 * Consumer-owned event filters shared by every authoring wrapper.
 *
 * These narrow an event **after** the trigger source validated and emitted it,
 * which is why they are not part of any trigger type's parameter schema.
 * @typeParam TPayload - The trigger event payload type
 */
interface TriggerFilterOptions<TPayload> {
  /** Optional structural payload filter (AND semantics). */
  readonly filter?: TypedPayloadFilter<TPayload>;
  /** Optional jexl expression for complex filter conditions. */
  readonly filterExpression?: string;
}

/**
 * Builds the persisted binding produced by every authoring wrapper.
 *
 * Centralizing construction keeps the optional-field spreads and the single
 * widening of the typed filter to its persisted `PayloadFilter` shape in one
 * place. Wrappers pass their own options object straight through as `filters`
 * rather than re-spreading the two optional fields at the call site — the
 * conditional spread belongs to whichever code actually builds the binding, and
 * doing it twice is how the two copies drift when a third filter field appears.
 * @param kind - Canonical automation trigger kind
 * @param params - Detached JSON-safe schema input persisted for activation
 * @param filters - Consumer-owned event filters, read from the wrapper's options
 * @returns The persisted binding carrying the phantom payload type
 * @typeParam TPayload - The trigger event payload type
 */
function createTriggerBinding<TPayload>(
  kind: string,
  params: AutomationTriggerParams,
  filters: TriggerFilterOptions<TPayload>,
): WorkflowTriggerDef<TPayload> {
  return {
    kind,
    params,
    ...(filters.filter !== undefined && {
      // `TypedPayloadFilter` only constrains which keys are addressable; the
      // persisted binding stores the same operators under the untyped record.
      filter: filters.filter as PayloadFilter,
    }),
    ...(filters.filterExpression !== undefined && { filterExpression: filters.filterExpression }),
  };
}

/**
 * Binds a defined automation trigger to a workflow, preserving the trigger's
 * emitted payload type for `ctx.trigger` inference.
 *
 * Params are validated at authoring time, so an invalid binding fails where the
 * workflow is declared. The detached JSON-safe schema input is persisted; the
 * runtime applies defaults and transforms exactly once when it activates the
 * trigger.
 * @param definition - The automation trigger contributed by an extension
 * @param options - Activation params plus consumer-owned event filters
 * @returns A typed workflow trigger binding
 * @typeParam TParamsSchema - Live Zod schema for the trigger's parameters
 * @typeParam TEventSchema - Live Zod schema for the trigger's emitted event
 * @example
 * ```typescript
 * const trigger = AutomationWorkflowTrigger(GithubPullRequestOpenedTrigger, {
 *   params: { repository: 'makaio-ai/makaio' },
 *   filterExpression: "payload.baseRef == 'develop'",
 * });
 * ```
 */
export function AutomationWorkflowTrigger<
  TParamsSchema extends z.ZodType<AutomationTriggerParams>,
  TEventSchema extends z.ZodType<Record<string, JsonValue>>,
>(
  definition: DefinedAutomationTrigger<TParamsSchema, TEventSchema>,
  options: {
    /** Trigger-type parameters, validated against `definition.paramsSchema`. */
    readonly params: z.input<TParamsSchema>;
  } & TriggerFilterOptions<z.output<TEventSchema>>,
): WorkflowTriggerDef<z.output<TEventSchema>> {
  const persistedParams = JsonRecordSchema.parse(options.params);
  definition.paramsSchema.parse(persistedParams);
  return createTriggerBinding<z.output<TEventSchema>>(definition.kind, persistedParams, options);
}

/**
 * Creates a bus-event workflow trigger that fires when a typed subject emits
 * a matching message.
 * @param options - Trigger configuration options
 * @returns A typed workflow trigger binding for {@link BUS_EVENT_AUTOMATION_TRIGGER_KIND}
 * @typeParam S - The subject definition being subscribed to
 * @example
 * ```typescript
 * const trigger = BusEventWorkflowTrigger({
 *   subject: GitNamespace.subjects.checkout,
 *   filter: { isNewWorktree: true },
 * });
 * ```
 */
export function BusEventWorkflowTrigger<S extends SubjectDefinition>(
  options: ExtractSubjectPayload<S> extends readonly unknown[]
    ? never
    : ExtractSubjectPayload<S> extends Record<string, JsonValue>
      ? {
          /** The bus subject to subscribe to. */
          readonly subject: S;
        } & TriggerFilterOptions<ExtractSubjectPayload<S>>
      : never,
): WorkflowTriggerDef<ExtractSubjectPayload<S>> {
  return createTriggerBinding<ExtractSubjectPayload<S>>(
    BUS_EVENT_AUTOMATION_TRIGGER_KIND,
    { subject: getFullSubjectForSubjectDefinition(options.subject) },
    options,
  );
}

/**
 * Cron trigger payload — injected into `context.trigger` at execution time.
 */
export interface CronTriggerPayload {
  /** UNIX epoch milliseconds of the scheduled occurrence that fired. */
  readonly scheduledFor: number;
}

/**
 * Canonical parameter shape of a cron automation trigger binding.
 *
 * Shared by the authoring wrapper and the built-in `makaio.cron` trigger's
 * `paramsSchema`, because the timezone default is load-bearing: it is applied
 * before the canonical binding key is computed, so two bindings meaning the same
 * moment — one naming `UTC` explicitly, one omitting it — must normalise
 * identically on both sides of the seam. Two copies of this schema would let the
 * key fork.
 *
 * Presence and non-emptiness are checked here so a binding that could never
 * schedule fails where the workflow is declared. Expression *validity* stays a
 * runtime concern: the cron parser lives in the trigger's host-selected scheduler
 * and is deliberately not a dependency of the contracts package, so the trigger's
 * scheduler remains the single authority on which expressions are legal.
 */
export const CronAutomationTriggerParamsSchema = z.object({
  /** Cron expression; non-empty, otherwise no schedule can be derived. */
  schedule: z.string().min(1),
  /** IANA timezone; non-empty, defaulted before the binding is persisted. */
  timezone: z.string().min(1).default(DEFAULT_CRON_TIMEZONE),
});

/**
 * Creates a cron-based workflow trigger.
 * @param options - Trigger configuration options
 * @returns A typed workflow trigger binding for {@link CRON_AUTOMATION_TRIGGER_KIND}
 * @throws When `schedule` is empty, or when `timezone` is present but empty.
 */
export function CronWorkflowTrigger(options: {
  /** Cron expression (e.g. `'0 9 * * 1'`). */
  readonly schedule: string;
  /** IANA timezone string; defaults to {@link DEFAULT_CRON_TIMEZONE}. */
  readonly timezone?: string;
}): WorkflowTriggerDef<CronTriggerPayload> {
  // No consumer-owned filters: a cron firing carries only the occurrence it
  // served, so there is nothing meaningful to filter it on.
  return createTriggerBinding<CronTriggerPayload>(
    CRON_AUTOMATION_TRIGGER_KIND,
    CronAutomationTriggerParamsSchema.parse(options),
    {},
  );
}
