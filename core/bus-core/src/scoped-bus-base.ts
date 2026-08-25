/**
 * Shared base interface for namespace-scoped bus variants.
 *
 * Declares the 7 core methods common to both {@link ScopedBus} and
 * {@link IFilteredBus}: `on`, `intercept`, `once` (two overloads), `emit`,
 * `request`, and `requestOptional`, plus the `namespace` property.
 *
 * Both `ScopedBus` and `IFilteredBus` extend this interface and add their
 * own unique members on top.
 */

import type { EmitOptions, InterceptOptions, OnOptions, RequestOptions } from './types/index.js';
import type { InterceptorHandler } from './types/interceptor.js';
import type { OnceOptions } from './methods/once.js';
import type {
  ContextForSubjectDefinition,
  HandlerForSubjectDefinition,
  OptionalResult,
  ScopedSubjectDefinition,
} from '@makaio/core';

/**
 * Minimal shared surface common to {@link ScopedBus} and {@link IFilteredBus}.
 *
 * The dispatching methods carry the same option bags as the unscoped bus.
 * Scoping and filtering are properties of a *subscription*, not of a message:
 * an option that decides where a message goes — `transports` above all — must
 * mean the same thing however the caller reached the bus. Declaring the options
 * here is what makes that a checked contract rather than a convention each
 * wrapper is free to forget, and a caller holding one of these buses can state
 * routing that a caller holding the root bus could always state.
 * @typeParam Namespace - The namespace domain string (e.g. `'adapter:codex-mcp'`)
 */
export interface IScopedBusBase<Namespace extends string> {
  readonly namespace: Namespace;

  /**
   * Register an event or request handler.
   * @param subject - Subject definition to listen on
   * @param handler - Handler function to invoke
   * @param options - Optional subscription options (filter, priority, etc.)
   * @returns Unsubscribe function
   */
  on<Subject extends ScopedSubjectDefinition<Namespace>>(
    subject: Subject,
    handler: HandlerForSubjectDefinition<Subject>,
    options?: OnOptions,
  ): () => void;

  /**
   * Register an interceptor that runs BEFORE handlers.
   * @param subject - Subject definition to intercept
   * @param handler - Interceptor handler function
   * @param options - Optional intercept options (filter, priority, etc.)
   * @returns Unsubscribe function
   */
  intercept<Subject extends ScopedSubjectDefinition<Namespace>>(
    subject: Subject,
    handler: InterceptorHandler<Subject['$meta']['payload']>,
    options?: InterceptOptions,
  ): () => void;

  /**
   * Register a one-time handler (callback version).
   * @param subject - Subject definition to listen on once
   * @param handler - Handler function invoked at most once
   * @returns Unsubscribe function
   */
  once<Subject extends ScopedSubjectDefinition<Namespace>>(
    subject: Subject,
    handler: HandlerForSubjectDefinition<Subject>,
  ): () => void;

  /**
   * Wait for an event (promise version).
   * @param subject - Subject definition to await
   * @param options - Optional filter and timeout options
   * @returns Promise resolving to the event context
   */
  once<Subject extends ScopedSubjectDefinition<Namespace>>(
    subject: Subject,
    options?: OnceOptions<Subject>,
  ): Promise<ContextForSubjectDefinition<Subject>>;

  /**
   * Emit an event.
   * @param subject - Subject definition to emit on
   * @param payload - Event payload matching the subject schema
   * @param options - Optional emit options (message ids, transports)
   * @returns Promise resolving when all handlers have been notified
   */
  emit<Subject extends ScopedSubjectDefinition<Namespace>>(
    subject: Subject,
    payload: Subject['$meta']['payload'],
    options?: EmitOptions,
  ): Promise<void>;

  /**
   * Make a request (throws if no handler is registered).
   * @param subject - Subject definition for the request
   * @param payload - Request payload matching the subject schema
   * @param options - Optional request options (timeout, signal, transports)
   * @returns Promise resolving to the response payload
   */
  request<Subject extends ScopedSubjectDefinition<Namespace>>(
    subject: Subject,
    payload: Subject['$meta']['payload']['request'],
    options?: RequestOptions,
  ): Promise<Subject['$meta']['payload']['response']>;

  /**
   * Make an optional request (returns `OptionalResult` instead of throwing
   * when no handler is registered).
   * @param subject - Subject definition for the request
   * @param payload - Request payload matching the subject schema
   * @param options - Optional request options (timeout, signal, transports)
   * @returns Promise resolving to an `OptionalResult` wrapper
   */
  requestOptional<Subject extends ScopedSubjectDefinition<Namespace>>(
    subject: Subject,
    payload: Subject['$meta']['payload']['request'],
    options?: RequestOptions,
  ): Promise<OptionalResult<Subject['$meta']['payload']['response']>>;
}
