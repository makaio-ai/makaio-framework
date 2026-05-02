import type { RequestOptions, MakaioBusContext } from '../types/index.js';
import { NoHandlerError, TimeoutError } from '../errors/index.js';
import type { OptionalResult, SubjectDefinition } from '@makaio/core';
import { nanoid } from 'nanoid';
import { invokeAnyHandlers } from '../utils/invoke-any-handlers.js';
import { getFullSubjectForSubjectDefinition } from '../utils/subject-transformation.js';
import {
  resolveRequestValidation,
  validateRequestPayload,
  validateResponsePayload,
} from '../utils/validate-request-payload.js';
import { awaitWithTimeoutAndSignal } from './request/await-with-timeout-and-signal.js';
import { TimeoutError as pTimeoutError } from 'p-timeout';
import { dispatch } from './request/dispatch.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../types/options.js';

/**
 * Determine whether a request should be dispatched locally only.
 *
 * `transports: []` or an empty Set means "do not route to any transport" —
 * equivalent to local-only. Undefined means "allow any remote transport", and
 * non-empty transport allowlists also remain remote-capable so dispatch can
 * route through the advertised remote handler registry.
 * @param subjectDefinition - Subject definition (checked for `$meta.local`)
 * @param transports - Caller-supplied transport spec from RequestOptions
 * @returns `true` if dispatch must stay local
 */
function resolveLocalOnly(subjectDefinition: SubjectDefinition, transports: RequestOptions['transports']): boolean {
  if (subjectDefinition.$meta.local) return true;
  if (transports === undefined) return false;

  return Array.isArray(transports) ? transports.length === 0 : transports.size === 0;
}

/**
 * Normalize an explicit transport allowlist for dispatch.
 *
 * `undefined` means no explicit routing constraint. Empty inputs mean local-only
 * and are therefore also normalized to `undefined`; the `localOnly` flag already
 * captures that case.
 * @param transports - Caller-supplied transport specification
 * @returns Array of transport names to constrain remote dispatch, or `undefined`
 */
function resolveAllowedTransports(transports: RequestOptions['transports']): Array<string> | undefined {
  if (transports === undefined) {
    return undefined;
  }

  const names = Array.isArray(transports) ? transports : Array.from(transports);
  return names.length > 0 ? names.map(String) : undefined;
}

/**
 * Execute a request and wait for a response.
 * @param context - Makaio bus context
 * @param subjectDefinition - Concrete request subject (wildcards not allowed)
 * @param payload - Request payload
 * @param options - Request options (timeout, correlationId, transports)
 * @returns Response value
 * @see {@link IMakaioBus.request} for full documentation and examples.
 */
export async function request<
  T extends SubjectDefinition,
  Request extends T['$meta']['payload']['request'],
  Response extends T['$meta']['payload']['response'],
>(context: MakaioBusContext, subjectDefinition: T, payload: Request, options?: RequestOptions): Promise<Response> {
  const subjectKey = subjectDefinition.subject;
  const fullSubjectKey = getFullSubjectForSubjectDefinition(subjectDefinition);
  const messageId = options?.messageId ?? nanoid();
  const correlationId = options?.correlationId ?? nanoid();
  const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const signal = options?.signal;

  const validationCtx = resolveRequestValidation(context, fullSubjectKey);
  validateRequestPayload(fullSubjectKey, payload, validationCtx);

  // Invoke __onAny handlers (debugging/testing)
  invokeAnyHandlers(
    context,
    'request',
    subjectKey,
    subjectDefinition.$meta.namespace,
    payload,
    messageId,
    correlationId,
  );

  const localOnly = resolveLocalOnly(subjectDefinition, options?.transports);
  const allowedTransports = resolveAllowedTransports(options?.transports);

  let outcome: Awaited<ReturnType<typeof dispatch>>;
  try {
    const dispatchPromise = dispatch(context, subjectDefinition, payload, {
      allowedTransports,
      correlationId,
      messageId,
      timeout,
      signal,
      localOnly,
    });
    // timeout === 0 disables automatic timeout but still honours AbortSignal.
    outcome = await awaitWithTimeoutAndSignal(dispatchPromise, timeout, signal);
  } catch (error) {
    if (error instanceof pTimeoutError) {
      console.error(`[${correlationId}][${messageId}] Request to "${subjectKey}" timed out after ${timeout}ms`);
      throw new TimeoutError(subjectKey, timeout);
    }
    throw error;
  }

  if (!outcome.handled) {
    throw new NoHandlerError(fullSubjectKey);
  }

  const result = outcome.value;
  validateResponsePayload(fullSubjectKey, result, validationCtx);

  return result as Response;
}

/**
 * Execute a request, returning a discriminated union instead of throwing for missing handlers.
 *
 * Use this when the handler is optional (e.g., optional services like storage).
 * Only NoHandlerError is caught - other errors (timeout, validation, handler errors) propagate.
 * @param context - Makaio bus context
 * @param subjectDefinition - Concrete request subject (wildcards not allowed)
 * @param payload - Request payload
 * @param options - Request options (timeout, correlationId, transports)
 * @returns OptionalResult with `handled: true` and data, or `handled: false` if no handler
 * @see {@link request} for the throwing version
 */
export async function requestOptional<
  T extends SubjectDefinition,
  Request extends T['$meta']['payload']['request'],
  Response extends T['$meta']['payload']['response'],
>(
  context: MakaioBusContext,
  subjectDefinition: T,
  payload: Request,
  options?: RequestOptions,
): Promise<OptionalResult<Response>> {
  try {
    const data = await request<T, Request, Response>(context, subjectDefinition, payload, options);
    return { handled: true, data };
  } catch (e) {
    if (e instanceof NoHandlerError) {
      return { handled: false };
    }
    throw e;
  }
}
