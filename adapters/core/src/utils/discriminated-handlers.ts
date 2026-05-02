import type { SubjectDefinition, ExtractSubjectPayload } from '@makaio/core';
import type { AgentContext } from '../agent/types.js';

// ============================================================================
// Emit Function Type
// ============================================================================

/**
 * Type-safe emit function for discriminated handlers.
 * Each call is validated at compile time to ensure payload matches subject.
 *
 * The emit function signature matches AIAgent.emitGlobal, allowing handlers
 * to emit events without knowing whether they're running in live agent context
 * or log import context.
 */
export type TypedEmitFn = <S extends SubjectDefinition>(
  subject: S,
  payload: Omit<ExtractSubjectPayload<S>, keyof AgentContext>,
) => void | Promise<void>;

/**
 * Synchronous variant of TypedEmitFn.
 * Use with processDiscriminatedItemsSync to enforce sync handlers at compile time.
 */
export type SyncTypedEmitFn = <S extends SubjectDefinition>(
  subject: S,
  payload: Omit<ExtractSubjectPayload<S>, keyof AgentContext>,
) => void;

// ============================================================================
// Handler Types
// ============================================================================

/**
 * Handler function that receives narrowed payload and typed emit.
 * @typeParam TPayload - The narrowed payload type (discriminated union member)
 * @typeParam TEmit - The emit function type (defaults to TypedEmitFn)
 */
export type DiscriminatedHandler<TPayload, TEmit extends TypedEmitFn = TypedEmitFn> = (
  payload: TPayload,
  emit: TEmit,
) => void | Promise<void>;

/**
 * Synchronous handler that cannot return a Promise.
 * Use with processDiscriminatedItemsSync to catch async handlers at compile time.
 */
export type SyncDiscriminatedHandler<TPayload> = (payload: TPayload, emit: SyncTypedEmitFn) => void;

/**
 * Handlers map with discriminator-narrowed payload types.
 *
 * Each key is a possible value of the discriminator property,
 * and each handler receives the narrowed payload type for that discriminator value.
 * @typeParam TPayload - The full discriminated union type
 * @typeParam TDiscriminator - The property key used to discriminate union members
 */
export type DiscriminatedHandlersMap<
  TPayload extends Record<string, unknown>,
  TDiscriminator extends keyof TPayload & string,
> = {
  [K in TPayload[TDiscriminator] & string]?: DiscriminatedHandler<Extract<TPayload, { [P in TDiscriminator]: K }>>;
};

/**
 * Synchronous handlers map for compile-time async prevention.
 * Use with defineDiscriminatedHandlersSync and processDiscriminatedItemsSync.
 */
export type SyncDiscriminatedHandlersMap<
  TPayload extends Record<string, unknown>,
  TDiscriminator extends keyof TPayload & string,
> = {
  [K in TPayload[TDiscriminator] & string]?: SyncDiscriminatedHandler<Extract<TPayload, { [P in TDiscriminator]: K }>>;
};

// ============================================================================
// Configuration Type
// ============================================================================

/**
 * Configuration returned by defineDiscriminatedHandlers.
 *
 * Encapsulates the discriminator key and handler map for use with
 * processDiscriminatedItems.
 * @typeParam TPayload - The full discriminated union type
 * @typeParam TDiscriminator - The property key used to discriminate union members
 */
export interface DiscriminatedHandlersConfig<
  TPayload extends Record<string, unknown>,
  TDiscriminator extends keyof TPayload & string,
> {
  discriminator: TDiscriminator;
  handlers: DiscriminatedHandlersMap<TPayload, TDiscriminator>;
}

/**
 * Synchronous configuration for compile-time async prevention.
 * Use with defineDiscriminatedHandlersSync and processDiscriminatedItemsSync.
 */
export interface SyncDiscriminatedHandlersConfig<
  TPayload extends Record<string, unknown>,
  TDiscriminator extends keyof TPayload & string,
> {
  discriminator: TDiscriminator;
  handlers: SyncDiscriminatedHandlersMap<TPayload, TDiscriminator>;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Factory to create typed discriminated handlers.
 *
 * This function provides compile-time validation that handlers receive
 * correctly narrowed payload types based on the discriminator value.
 * @param discriminator - The property key used to discriminate union members
 * @param handlers - Map of discriminator values to handler functions
 * @returns Configuration object for use with processDiscriminatedItems
 * @example
 * ```typescript
 * // Define handlers with full type safety
 * const handlers = defineDiscriminatedHandlers<BetaContentBlock, 'type'>('type', {
 *   text: (block, emit) => {
 *     // block is narrowed to BetaTextBlock
 *     emit(AgentSubjects.message, { content: block.text });
 *   },
 *   thinking: (block, emit) => {
 *     // block is narrowed to BetaThinkingBlock
 *     emit(AgentSubjects.reasoning, { content: block.thinking });
 *   },
 *   tool_use: (block, emit) => {
 *     // block is narrowed to BetaToolUseBlock
 *     emit(AgentSubjects.tool.use, {
 *       toolName: block.name,
 *       args: block.input,
 *       toolCallId: block.id,
 *     });
 *   },
 * });
 * ```
 */
export function defineDiscriminatedHandlers<
  TPayload extends Record<string, unknown>,
  TDiscriminator extends keyof TPayload & string = keyof TPayload & string,
>(
  discriminator: TDiscriminator,
  handlers: DiscriminatedHandlersMap<TPayload, TDiscriminator>,
): DiscriminatedHandlersConfig<TPayload, TDiscriminator> {
  return { discriminator, handlers };
}

/**
 * Factory for sync-only handlers with compile-time async prevention.
 *
 * Use this instead of defineDiscriminatedHandlers when handlers will be
 * used with processDiscriminatedItemsSync. Async handlers will cause
 * compile-time errors rather than runtime errors.
 * @param discriminator - Property key used to discriminate payload types
 * @param handlers - Map of discriminator values to sync handler functions
 * @returns Config object for processDiscriminatedItemsSync
 */
export function defineDiscriminatedHandlersSync<
  TPayload extends Record<string, unknown>,
  TDiscriminator extends keyof TPayload & string = keyof TPayload & string,
>(
  discriminator: TDiscriminator,
  handlers: SyncDiscriminatedHandlersMap<TPayload, TDiscriminator>,
): SyncDiscriminatedHandlersConfig<TPayload, TDiscriminator> {
  return { discriminator, handlers };
}

// ============================================================================
// Processing Function
// ============================================================================

/**
 * Process items through discriminated handlers.
 *
 * Iterates over items (or processes single item), reads discriminator,
 * and calls appropriate handler with typed emit. Items without a matching
 * handler are silently skipped.
 * @param items - Single item or array of items to process
 * @param config - Handler configuration from defineDiscriminatedHandlers
 * @param emit - Typed emit function (can be emitGlobal, collection push, etc.)
 * @example
 * ```typescript
 * // Agent usage - emit directly
 * await processDiscriminatedItems(
 *   content,
 *   CONTENT_BLOCK_HANDLERS,
 *   (subject, payload) => this.emitGlobal(subject, payload),
 * );
 *
 * // Importer usage - collect events with enrichment
 * const events: NormalizedEvent[] = [];
 * await processDiscriminatedItems(
 *   content,
 *   CONTENT_BLOCK_HANDLERS,
 *   (subject, payload) => {
 *     events.push({ subject, payload: { ...basePayload, ...payload } });
 *   },
 * );
 * ```
 */
export async function processDiscriminatedItems<
  TPayload extends Record<string, unknown>,
  TDiscriminator extends keyof TPayload & string,
>(
  items: TPayload | TPayload[],
  config: DiscriminatedHandlersConfig<TPayload, TDiscriminator>,
  emit: TypedEmitFn,
): Promise<void> {
  const itemArray = Array.isArray(items) ? items : [items];

  for (const item of itemArray) {
    const discriminatorValue = item[config.discriminator] as TPayload[TDiscriminator] & string;
    const handler = config.handlers[discriminatorValue];

    if (handler) {
      await handler(item as Extract<TPayload, { [P in TDiscriminator]: typeof discriminatorValue }>, emit);
    }
  }
}

/**
 * Synchronous variant of processDiscriminatedItems.
 *
 * Two usage modes:
 * 1. With SyncDiscriminatedHandlersConfig: Full compile-time async prevention
 * 2. With DiscriminatedHandlersConfig: Runtime-only async detection (for shared handlers)
 * @param items - Single item or array of items to process
 * @param config - Handler configuration (sync or async)
 * @param emit - Synchronous emit function
 * @throws Error if a handler returns a Promise
 */
export function processDiscriminatedItemsSync<
  TPayload extends Record<string, unknown>,
  TDiscriminator extends keyof TPayload & string,
>(
  items: TPayload | TPayload[],
  config: SyncDiscriminatedHandlersConfig<TPayload, TDiscriminator>,
  emit: SyncTypedEmitFn,
): void;
/**
 * Overload for shared handlers defined with defineDiscriminatedHandlers.
 * Provides runtime-only async detection (no compile-time safety).
 * @param items - Single item or array of items to process
 * @param config - Discriminated handlers config from defineDiscriminatedHandlers
 * @param emit - Typed emit function for publishing events
 */
export function processDiscriminatedItemsSync<
  TPayload extends Record<string, unknown>,
  TDiscriminator extends keyof TPayload & string,
>(
  items: TPayload | TPayload[],
  config: DiscriminatedHandlersConfig<TPayload, TDiscriminator>,
  emit: SyncTypedEmitFn,
): void;
export function processDiscriminatedItemsSync<
  TPayload extends Record<string, unknown>,
  TDiscriminator extends keyof TPayload & string,
>(
  items: TPayload | TPayload[],
  config:
    | SyncDiscriminatedHandlersConfig<TPayload, TDiscriminator>
    | DiscriminatedHandlersConfig<TPayload, TDiscriminator>,
  emit: SyncTypedEmitFn,
): void {
  const itemArray = Array.isArray(items) ? items : [items];

  for (const item of itemArray) {
    const discriminatorValue = item[config.discriminator] as TPayload[TDiscriminator] & string;
    const handler = config.handlers[discriminatorValue];

    if (handler) {
      const result = handler(item as Extract<TPayload, { [P in TDiscriminator]: typeof discriminatorValue }>, emit);
      if (result instanceof Promise) {
        throw new Error(
          `processDiscriminatedItemsSync: Handler for '${discriminatorValue}' returned a Promise. ` +
            `Use processDiscriminatedItems (async) instead, or ensure all handlers are synchronous.`,
        );
      }
    }
  }
}
