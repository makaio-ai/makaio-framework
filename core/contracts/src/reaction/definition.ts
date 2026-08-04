import { z } from 'zod';
import { zodSchemaToJsonRecord } from '../shared/zod-json-schema.js';
import { ReactionDescriptorSchema } from './schemas.js';
import type { ReactionDescriptor } from './schemas.js';
import type { ReactionExecutionContext } from './execution.js';

/**
 * Trusted asynchronous Reaction handler.
 *
 * Receives parameters that were already validated against the Reaction's live
 * `parameterSchema` by the dispatching runtime, together with the frozen
 * {@link ReactionExecutionContext} envelope for this invocation.
 * @typeParam TParams - Validated parameter shape for this Reaction.
 * @param parameters - Schema-validated, read-only invocation parameters.
 * @param context - Frozen execution envelope for this invocation.
 * @returns Resolves when the Reaction's side-effects are complete.
 */
export type ReactionHandler<TParams extends Record<string, unknown> = Record<string, unknown>> = (
  parameters: Readonly<TParams>,
  context: ReactionExecutionContext,
) => Promise<void>;

/**
 * Executable Reaction contributed by an extension.
 *
 * This is the type-erased shape stored on contribution surfaces and consumed
 * by the Reaction registry; typed authoring happens through
 * {@link defineReaction}, which erases the parameter type after wiring the
 * live schema and handler together. The live `parameterSchema` and `handler`
 * are function-carrying runtime values and must never be treated as
 * serializable descriptor data — `toDescriptor()` produces the only
 * serializable representation.
 */
export interface ReactionDefinition {
  /**
   * Canonical Reaction kind: `<extension-name>.<reaction-name>`.
   *
   * Namespace ownership (the `<extension-name>.` prefix matching the
   * contributing extension) is enforced by the Reaction registry at
   * contribution time.
   */
  readonly kind: string;
  /** Human-readable description of what this Reaction does when invoked. */
  readonly description: string;
  /**
   * Live Zod schema for the Reaction's invocation parameters.
   *
   * The dispatching runtime validates raw parameters against this schema
   * before invoking {@link handler}.
   */
  readonly parameterSchema: z.ZodType<Record<string, unknown>>;
  /**
   * Trusted executable handler for this Reaction.
   *
   * Invariant: callers MUST pass parameters that were validated with
   * {@link parameterSchema} — the typed inner handler installed by
   * {@link defineReaction} narrows them under that contract.
   */
  readonly handler: ReactionHandler;
  /**
   * Produces the serializable {@link ReactionDescriptor} for this Reaction.
   * @returns Discovery metadata with a derived JSON Schema parameter shape;
   *   never includes the live schema or handler. Each call returns a detached
   *   snapshot owned by the caller; mutating it cannot affect later discovery.
   */
  readonly toDescriptor: () => ReactionDescriptor;
}

/**
 * Options for {@link defineReaction}.
 * @typeParam TParams - Parameter shape validated by `parameterSchema`.
 */
export interface DefineReactionOptions<TParams extends Record<string, unknown>> {
  /**
   * Canonical Reaction kind: `<extension-name>.<reaction-name>`.
   * The Reaction registry enforces the extension-name prefix at contribution time.
   */
  readonly kind: string;
  /** Human-readable description of what this Reaction does when invoked. */
  readonly description: string;
  /** Live Zod schema for the Reaction's invocation parameters. */
  readonly parameterSchema: z.ZodType<TParams>;
  /** Typed handler receiving already-validated read-only parameters. */
  readonly handler: ReactionHandler<TParams>;
}

/**
 * Creates an executable Reaction definition with a live parameter schema, a
 * typed handler, and a serializable descriptor.
 *
 * The returned definition is type-erased for storage on contribution
 * surfaces; the typed `handler` from the options keeps its parameter type
 * internally and is invoked under the invariant that the dispatching runtime
 * validated the parameters with `parameterSchema` first. Definition creation
 * derives serializable discovery metadata — the live schema and handler are
 * never serialized.
 * @typeParam TParams - Parameter shape validated by `parameterSchema`.
 * @param options - Reaction identity, description, live parameter schema, and
 *   typed handler.
 * @returns A type-erased {@link ReactionDefinition} ready for contribution.
 * @throws Error when the Reaction identity or input parameter schema cannot
 *   form a serializable {@link ReactionDescriptorSchema}, enforced fail-fast
 *   at definition time so `toDescriptor()` can never fail discovery.
 * @example
 * ```ts
 * export const notifyReaction = defineReaction({
 *   kind: 'my-extension.notify-owner',
 *   description: 'Notifies the owning user about a host-selected event.',
 *   parameterSchema: z.object({ channel: z.string(), message: z.string() }),
 *   handler: async (parameters, context) => {
 *     await sendNotification(parameters.channel, parameters.message, {
 *       signal: context.signal,
 *     });
 *   },
 * });
 * ```
 */
export function defineReaction<TParams extends Record<string, unknown>>(
  options: DefineReactionOptions<TParams>,
): ReactionDefinition {
  const { kind, description, parameterSchema, handler } = options;
  // Eagerly derive and validate the cached descriptor so successful
  // definitions always remain discoverable. Discovery callers receive clones
  // and cannot mutate this cached value.
  const cachedDescriptor = ReactionDescriptorSchema.parse({
    kind,
    description,
    parameterSchema: zodSchemaToJsonRecord(parameterSchema, 'input'),
  });
  return {
    kind,
    description,
    parameterSchema,
    // Invariant: the dispatching runtime validates parameters with
    // `parameterSchema` before invoking this handler, so erasing the authored
    // parameter type is safe and adds no per-invocation wrapper frame.
    handler: handler as ReactionHandler,
    toDescriptor: (): ReactionDescriptor => structuredClone(cachedDescriptor),
  };
}
