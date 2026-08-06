import { z } from 'zod';
import { zodSchemaToJsonRecord } from '../shared/zod-json-schema.js';
import {
  AutomationTriggerBindingSchema,
  AutomationTriggerDescriptorSchema,
  AutomationTriggerKindSchema,
} from './schemas.js';
import type { AutomationTriggerDescriptor } from './schemas.js';
import type { JsonValue } from '../shared/json-value.js';

// ---------------------------------------------------------------------------
// Primitive type aliases
// ---------------------------------------------------------------------------

/**
 * JSON-compatible parameter map passed to a trigger's {@link AutomationTriggerType.activate}
 * function.
 */
export type AutomationTriggerParams = Readonly<Record<string, JsonValue>>;

/**
 * JSON-compatible payload produced by a trigger's live event schema and
 * delivered to listeners after an {@link AutomationTriggerActivationContext.emit}
 * call.
 */
export type AutomationTriggerPayload = JsonValue;

/**
 * Cleanup function returned by {@link AutomationTriggerType.activate}.
 *
 * Called by the runtime when the trigger binding is detached or the runtime
 * shuts down. May be synchronous or asynchronous.
 *
 * **Lifecycle ordering invariant:** the runtime aborts the activation
 * {@link AutomationTriggerActivationContext.signal} and then awaits this
 * cleanup. Implementations must be idempotent — the runtime calls this at most
 * once, but implementations should tolerate a double-disposal without error to
 * allow defensive guard callers. Use the returned cleanup as the primary
 * teardown mechanism; use `signal` only for cancelling in-flight async work.
 */
export type AutomationTriggerCleanup = () => void | Promise<void>;

/**
 * Listener registered for automation trigger events.
 *
 * Called each time the active trigger emits via its activation context.
 * @param event - Fully typed trigger event envelope.
 * @returns `void` or a `Promise<void>` to allow async side-effects.
 */
export type AutomationTriggerListener = (event: AutomationTriggerEvent) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Core value types
// ---------------------------------------------------------------------------

/**
 * Serializable reference to an active trigger binding.
 *
 * Stores the canonical trigger {@link kind} and the JSON-safe parameter input
 * that the runtime parses before calling {@link AutomationTriggerType.activate}.
 * Bindings are persisted in workflow definitions; runtime truth is always the
 * live trigger.
 */
export interface AutomationTriggerBinding {
  /** Canonical trigger kind, optionally owned by an npm-scoped extension. */
  readonly kind: string;
  /** JSON-safe parameter schema input for this binding. */
  readonly params: Readonly<Record<string, JsonValue>>;
}

/**
 * Event envelope emitted by an active automation trigger.
 *
 * Produced by the trigger's activation context {@link AutomationTriggerActivationContext.emit}
 * and delivered to registered {@link AutomationTriggerListener}s.
 * @typeParam TPayload - JSON-compatible event payload shape.
 */
export interface AutomationTriggerEvent<TPayload extends JsonValue = JsonValue> {
  /** Canonical trigger kind that emitted this event. */
  readonly kind: string;
  /** Event payload validated by the trigger's live `eventSchema`. */
  readonly payload: Readonly<TPayload>;
  /**
   * UNIX epoch milliseconds when the trigger observed the underlying event.
   *
   * Stamped by the binding runtime when it accepts the emitted value; used for
   * ordering and diagnostics.
   */
  readonly observedAt: number;
  /**
   * Optional propagated correlation identifier.
   *
   * Present when the triggering source carries correlation context
   * (e.g. a webhook request with a trace header).
   */
  readonly correlationId?: string;
}

/**
 * Context supplied to a trigger's {@link AutomationTriggerType.activate} function.
 *
 * Provides the activation's identity, lifecycle management (via `signal`), and
 * the typed emit channel for delivering events to the runtime's event bus.
 * @typeParam TPayloadInput - Input accepted by the trigger's live `eventSchema`.
 *   The runtime parses this value before listeners receive its JSON-safe output.
 */
export interface AutomationTriggerActivationContext<TPayloadInput = JsonValue> {
  /**
   * Canonical sharing key of the activation this context belongs to.
   *
   * Supplied by the runtime, which derived it from `<kind>` and the parsed,
   * canonicalized parameters — the same key that decides which bindings share this
   * activation. A trigger that has to name its activation to a collaborator (a
   * scheduler being handed a job, a log line attributing a failure) reports this
   * value instead of re-deriving one, which is what keeps a trigger's notion of
   * its own identity from drifting from the runtime's.
   *
   * **Not a unique index over time:** the runtime may briefly hold a retiring and
   * a fresh activation of the same key, so a collaborator must key its own state
   * on the activation it was handed, not on this string.
   */
  readonly bindingKey: string;
  /**
   * Abort signal that is aborted when the trigger binding is detached or the
   * runtime shuts down.
   *
   * **Lifecycle ordering invariant:** the runtime aborts this signal first,
   * then awaits the {@link AutomationTriggerCleanup} returned by
   * {@link AutomationTriggerType.activate}. Implementations should use
   * `signal` only for cancelling in-flight async work (e.g. passing it to
   * `fetch`). Use the returned cleanup as the primary teardown mechanism for
   * releasing subscriptions or handles.
   */
  readonly signal: AbortSignal;
  /**
   * Emits a trigger event to the runtime's event bus.
   * @param payload - Event payload input validated and transformed by the
   *   trigger's live `eventSchema`.
   * @param metadata - Optional envelope metadata to attach to the emitted event.
   * @returns Resolves when the event has been accepted by the bus.
   */
  readonly emit: (payload: TPayloadInput, metadata?: { readonly correlationId?: string }) => Promise<void>;
}

/**
 * Handle representing a currently active trigger subscription.
 *
 * Returned by the trigger registry's `subscribe` method. Callers retain this
 * to detach the subscription cleanly.
 */
export interface AutomationTriggerSubscription {
  /** Stable key identifying this binding instance. */
  readonly bindingKey: string;
  /**
   * Detaches the subscription, stopping the trigger and releasing resources.
   * @returns Resolves when the trigger cleanup is complete.
   */
  readonly detach: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Registry-boundary types
// ---------------------------------------------------------------------------

/**
 * Type-erased automation trigger stored in the registry.
 *
 * This is the shape that contribution processors and the trigger registry
 * consume after generic types are erased. Typed authoring happens through
 * {@link DefinedAutomationTrigger} and {@link defineAutomationTrigger}.
 *
 * The live `paramsSchema`, `eventSchema`, and `activate` are function-carrying
 * runtime values and must never be included in serializable descriptor
 * metadata — {@link createAutomationTriggerDescriptor} produces the only
 * serializable representation.
 */
export interface AutomationTriggerType {
  /** Canonical trigger kind, optionally owned by an npm-scoped extension. */
  readonly kind: string;
  /** Human-readable label shown in the Builder UI. */
  readonly label: string;
  /** Human-readable description of what this trigger emits and when. */
  readonly description: string;
  /** Categorization tags for grouping triggers in the Builder UI. */
  readonly categories: readonly string[];
  /**
   * Live Zod schema for the trigger's activation parameters.
   *
   * The runtime validates binding params against this schema before calling
   * {@link activate}.
   */
  readonly paramsSchema: z.ZodType<Record<string, JsonValue>>;
  /**
   * Live Zod schema for the trigger's emitted event payload.
   *
   * The activation context validates emitted payloads against this schema
   * before delivering them to listeners.
   *
   * The activation context accepts the schema's input type. The runtime parses
   * each emitted value exactly once and delivers the schema's JSON-compatible
   * output to listeners, so transforms may change the payload shape.
   */
  readonly eventSchema: z.ZodType<JsonValue>;
  /**
   * Activates the trigger with the supplied binding parameters.
   *
   * Called by the runtime after validating `params` through {@link paramsSchema}.
   * The implementation must return a cleanup function that stops the trigger
   * when called.
   * Declared as a readonly **property** rather than a method so that
   * `strictFunctionTypes` checks its parameters contravariantly: a trigger that
   * declares narrower `params` than the registry-boundary contract (for example
   * `params: { repo: string }` alongside `paramsSchema: z.object({})`) must not
   * type-check as an `AutomationTriggerType`. Method shorthand would make the
   * parameters bivariant and silently admit that mismatch.
   * @param context - Activation context with lifecycle signal and emit channel.
   * @param params - Schema-validated binding parameters.
   * @returns Cleanup function called on trigger deactivation.
   */
  readonly activate: (
    context: AutomationTriggerActivationContext<unknown>,
    params: AutomationTriggerParams,
  ) => Promise<AutomationTriggerCleanup>;
}

// ---------------------------------------------------------------------------
// Typed authoring interface
// ---------------------------------------------------------------------------

/**
 * Typed automation trigger definition authored by an extension.
 *
 * Preserves typed `paramsSchema`, `eventSchema`, and `activate` through the
 * authoring surface before generics are erased to {@link AutomationTriggerType}
 * at the registry boundary. Extensions declare triggers using
 * {@link defineAutomationTrigger}, which validates and caches the descriptor
 * at definition time.
 * @typeParam TParamsSchema - Live Zod schema for the parameter shape.
 * @typeParam TEventSchema - Live Zod schema for the emitted event payload.
 */
export interface DefinedAutomationTrigger<
  TParamsSchema extends z.ZodType<AutomationTriggerParams>,
  TEventSchema extends z.ZodType<AutomationTriggerPayload>,
> extends Omit<AutomationTriggerType, 'paramsSchema' | 'eventSchema' | 'activate'> {
  /** Live Zod schema for the trigger's activation parameters. */
  readonly paramsSchema: TParamsSchema;
  /**
   * Live Zod schema for the trigger's emitted event payload.
   *
   * Schema input is accepted by the typed emit channel; schema output must be
   * JSON-compatible for listener delivery.
   */
  readonly eventSchema: TEventSchema;
  /**
   * Activates the trigger with the supplied typed binding parameters.
   * @param context - Activation context with typed emit channel.
   * @param params - Schema-validated binding parameters matching `TParamsSchema`.
   * @returns Cleanup function called on trigger deactivation.
   */
  readonly activate: (
    context: AutomationTriggerActivationContext<z.input<TEventSchema>>,
    params: z.output<TParamsSchema>,
  ) => Promise<AutomationTriggerCleanup>;
}

// ---------------------------------------------------------------------------
// Descriptor source — minimal structural type for createAutomationTriggerDescriptor
// ---------------------------------------------------------------------------

/**
 * Minimal trigger-like shape required to produce an
 * {@link AutomationTriggerDescriptor}.
 *
 * Both {@link AutomationTriggerType} and
 * {@link DefinedAutomationTrigger} satisfy this interface because descriptor
 * production only requires the presentation fields and the two live schemas —
 * not the `activate` function.
 */
interface AutomationTriggerDescriptorSource {
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly categories: readonly string[];
  readonly paramsSchema: z.ZodType<AutomationTriggerParams>;
  readonly eventSchema: z.ZodType<AutomationTriggerPayload>;
}

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * WeakMap cache keyed on trigger objects.
 *
 * Populated eagerly by {@link defineAutomationTrigger} so that subsequent
 * calls from the runtime never recompute the descriptor and can never fail.
 */
const descriptorCache = new WeakMap<object, AutomationTriggerDescriptor>();

/**
 * Creates a validated, serializable {@link AutomationTriggerDescriptor} from a
 * trigger definition.
 *
 * This is the only supported path for producing serializable trigger
 * metadata. Extensions do NOT implement a `toDescriptor()` method — the
 * framework derives the descriptor from the live schemas to guarantee that
 * Builder metadata cannot drift from runtime truth.
 *
 * Results are cached on the trigger object and returned as detached clones so
 * mutations by callers never affect subsequent discovery.
 * @param trigger - Trigger definition or type-erased registry entry.
 * @returns A detached {@link AutomationTriggerDescriptor} snapshot.
 * @throws When the trigger's `kind` fails {@link AutomationTriggerKindSchema}
 *   or either schema cannot be projected to JSON Schema.
 */
export function createAutomationTriggerDescriptor(
  trigger: AutomationTriggerDescriptorSource,
): AutomationTriggerDescriptor {
  const cached = descriptorCache.get(trigger);
  if (cached !== undefined) return structuredClone(cached);

  const eventSchema = zodSchemaToJsonRecord(trigger.eventSchema, 'output');
  const descriptor = AutomationTriggerDescriptorSchema.parse({
    kind: trigger.kind,
    label: trigger.label,
    description: trigger.description,
    categories: trigger.categories,
    parameterSchema: zodSchemaToJsonRecord(trigger.paramsSchema, 'input'),
    eventSchema,
    workflowCompatible: eventSchema.type === 'object',
  });

  descriptorCache.set(trigger, descriptor);
  return structuredClone(descriptor);
}

// ---------------------------------------------------------------------------
// Authoring helper
// ---------------------------------------------------------------------------

/**
 * Defines a typed automation trigger and validates it at definition time.
 *
 * The returned definition is the typed authoring representation; it preserves
 * typed `paramsSchema`, `eventSchema`, and `activate` until the caller erases
 * generics to {@link AutomationTriggerType} at the registry boundary.
 *
 * Validation steps performed eagerly:
 * 1. {@link AutomationTriggerKindSchema} rejects invalid kind formats.
 * 2. {@link createAutomationTriggerDescriptor} validates that both schemas can
 *    be projected to JSON Schema and caches the result, so discovery never fails.
 * @typeParam TParamsSchema - Live Zod schema for the parameter shape.
 * @typeParam TEventSchema - Live Zod schema for the emitted event payload.
 * @param definition - Full typed trigger definition authored by the extension.
 * @returns The same `definition` object, frozen and type-preserved for the
 *   contribution surface. The returned object is shallowly frozen so that
 *   mutations to `label`, schemas, or other fields after definition time cannot
 *   silently diverge from the eagerly cached descriptor.
 * @throws When `kind` is not a valid canonical trigger kind string, or when either
 *   schema cannot be projected to a JSON-safe JSON Schema record.
 * @example
 * ```ts
 * export const profileChangedTrigger = defineAutomationTrigger({
 *   kind: 'makaio.profile-changed',
 *   label: 'Profile Changed',
 *   description: 'Fires when the authenticated user profile changes.',
 *   categories: ['Identity'],
 *   paramsSchema: z.object({}),
 *   eventSchema: z.object({ userId: z.string() }),
 *   activate: async (ctx) => {
 *     // Prefer returning a cleanup function as the primary teardown mechanism.
 *     // Use ctx.signal only for cancelling in-flight async work.
 *     const off = bus.on('profile.changed', (e) => {
 *       void ctx.emit({ userId: e.userId });
 *     });
 *     // Return the cleanup — the runtime awaits it after aborting ctx.signal.
 *     return off;
 *   },
 * });
 * ```
 */
export function defineAutomationTrigger<
  TParamsSchema extends z.ZodType<AutomationTriggerParams>,
  TEventSchema extends z.ZodType<AutomationTriggerPayload>,
>(
  definition: DefinedAutomationTrigger<TParamsSchema, TEventSchema>,
): DefinedAutomationTrigger<TParamsSchema, TEventSchema> {
  // Fail-fast: validate the kind format before caching anything.
  AutomationTriggerKindSchema.parse(definition.kind);
  // Fail-fast: derive and cache the descriptor so discovery never throws later.
  createAutomationTriggerDescriptor(definition);
  // Freeze shallowly so post-definition mutations to label/schemas cannot
  // silently drift from the eagerly cached descriptor stored in descriptorCache.
  return Object.freeze(definition);
}

// ---------------------------------------------------------------------------
// Compile-time guard
// ---------------------------------------------------------------------------

// Compile-time guard: ensure AutomationTriggerBindingSchema output remains assignable to the
// canonical AutomationTriggerBinding interface. If this line fails to compile, the schema and
// interface have drifted — reconcile both before proceeding.
// The `_` prefix marks this as intentionally unused; 'satisfies' produces a type error if the
// condition evaluates to false, making the drift immediately visible during type-checking.
const _bindingSchemaGuard = true satisfies z.output<
  typeof AutomationTriggerBindingSchema
> extends AutomationTriggerBinding
  ? true
  : false;

// ---------------------------------------------------------------------------
// Erasure seam
// ---------------------------------------------------------------------------

/**
 * Erases the typed generics on a {@link DefinedAutomationTrigger} to the
 * registry-boundary {@link AutomationTriggerType}.
 *
 * **How the erasure compiles.** `DefinedAutomationTrigger.activate` accepts the
 * narrow `z.output<TParamsSchema>` while `AutomationTriggerType.activate`
 * accepts the wide `AutomationTriggerParams`. Both are readonly properties, so
 * `strictFunctionTypes` compares them contravariantly and correctly rejects the
 * narrow signature as a direct assignment — that strictness is deliberate: it
 * is what stops a hand-written trigger from declaring narrower `params` than its
 * own `paramsSchema` produces. The erasure is therefore expressed as an
 * overload: this public signature accepts the typed definition, while the
 * implementation signature below is the wide {@link AutomationTriggerType}, so
 * the widening happens in the signature relation rather than through a type
 * assertion. Keeping the erasure here means no extension author casts — or even
 * mentions the erased type — at their own call site.
 *
 * **Why the erasure is safe at runtime.** The binding runtime parses binding
 * parameters through `paramsSchema` (and projects them through the shared JSON
 * schemas) before calling `activate`, and parses every emitted payload through
 * `eventSchema` before fanning it out to listeners. The narrow typed signature
 * is therefore only ever invoked with values its own schema produced.
 *
 * **Object identity is preserved:** the returned value IS the same object
 * reference. The {@link descriptorCache} WeakMap in
 * {@link createAutomationTriggerDescriptor} is keyed on object identity; a
 * spread copy would defeat the definition-time descriptor caching and break the
 * fail-fast guarantee that discovery can never throw.
 * @typeParam TParamsSchema - Live Zod schema for the parameter shape.
 * @typeParam TEventSchema - Live Zod schema for the emitted event payload.
 * @param definition - A typed trigger definition produced by
 *   {@link defineAutomationTrigger}.
 * @returns The same object reference, widened to {@link AutomationTriggerType}.
 */
export function toAutomationTriggerType<
  TParamsSchema extends z.ZodType<AutomationTriggerParams>,
  TEventSchema extends z.ZodType<AutomationTriggerPayload>,
>(definition: DefinedAutomationTrigger<TParamsSchema, TEventSchema>): AutomationTriggerType;
/**
 * Wide implementation signature of the erasure seam.
 *
 * Not callable with the typed definition directly — only the overload above is
 * visible to callers. It exists so the returned value needs no assertion.
 * @param definition - The already-erased trigger.
 * @returns The same object reference.
 */
export function toAutomationTriggerType(definition: AutomationTriggerType): AutomationTriggerType {
  return definition;
}
