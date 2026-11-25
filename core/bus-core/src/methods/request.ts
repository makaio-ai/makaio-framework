import type { RequestOptions, MakaioBusContext, WithReceiveContext } from '../types/index.js';
import { isRequestCancellation, NoHandlerError, TimeoutError } from '../errors/index.js';
import type { CallContext, OptionalResult, PartyRef, SubjectDefinition } from '@makaio/core';
import { enterSend } from '../call-context/send-entry.js';
import { nanoid } from 'nanoid';
import { invokeAnyHandlers } from '../utils/invoke-any-handlers.js';
import { notifyMessageObservers } from '../observability/subject-telemetry-projector.js';
import { getFullSubjectForSubjectDefinition } from '../utils/subject-transformation.js';
import {
  resolveRequestValidation,
  validateRequestPayload,
  validateResponsePayload,
} from '../utils/validate-request-payload.js';
import { awaitWithTimeoutAndSignal } from './request/await-with-timeout-and-signal.js';
import { TimeoutError as pTimeoutError } from 'p-timeout';
import { dispatch } from './request/dispatch.js';
import { requireRequestBudget } from './request/request-budget.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../types/options.js';
import { warnIfUnregistered } from '../utils/warn-unregistered.js';
import { isExplicitLocalOnlyTransportSpec } from './request/normalizeTransportTargets.js';
import { resolveEffectiveTransports } from './resolve-effective-transports.js';

/**
 * Determine whether a request should be dispatched locally only.
 *
 * Checks `$meta.local` (hard invariant), then runs the `defaultTransports`
 * cascade (subject-level → namespace-level) to suppress remote dispatch for
 * `'local-only'` subjects. Explicit caller-supplied transport specs always win.
 * @param context - Bus context for namespace registry access
 * @param subjectDefinition - Subject definition (checked for `$meta.local` and `defaultTransports`)
 * @param fullSubjectKey - Fully-qualified subject key for namespace lookup
 * @param transports - Caller-supplied transport spec from RequestOptions
 * @returns `true` if dispatch must stay local
 */
function resolveLocalOnly(
  context: MakaioBusContext,
  subjectDefinition: SubjectDefinition,
  fullSubjectKey: string,
  transports: RequestOptions['transports'],
): boolean {
  if (subjectDefinition.$meta.local) return true;
  const effective = resolveEffectiveTransports(context, subjectDefinition, fullSubjectKey, transports);
  return isExplicitLocalOnlyTransportSpec(effective);
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

type InternalRequestOptions = RequestOptions & Pick<WithReceiveContext, 'transport'>;

/**
 * Send a request on behalf of a carrier and wait for a response.
 *
 * This is the entry for SENDS: it enters through {@link enterSend}, which turns
 * the call context the sender passed into the context the message carries
 * (caller is the carrier, principal and attestation come from `call`) and
 * reports the use of an own context. Contexts of messages that were
 * already received enter through {@link requestWithMintedCall} instead.
 * @param context - Makaio bus context
 * @param carrier - Carrier of the sending bus instance
 * @param call - Call context the sender passed
 * @param subjectDefinition - Concrete request subject (wildcards not allowed)
 * @param payload - Request payload
 * @param options - Request options (timeout, correlationId, transports)
 * @returns Response value
 * @throws InvalidCallContextError When `call` was not minted by the core
 * @throws ForeignOwnContextError When `call` belongs to another carrier or bus context
 * @see {@link IMakaioBus.request} for full documentation and examples.
 */
export async function request<
  T extends SubjectDefinition,
  Request extends T['$meta']['payload']['request'],
  Response extends T['$meta']['payload']['response'],
>(
  context: MakaioBusContext,
  carrier: PartyRef,
  call: CallContext,
  subjectDefinition: T,
  payload: Request,
  options?: InternalRequestOptions,
): Promise<Response> {
  const sent = enterSend(call, context, carrier, getFullSubjectForSubjectDefinition(subjectDefinition));
  return requestWithMintedCall<T, Request, Response>(context, sent, subjectDefinition, payload, options);
}

/**
 * Execute a request whose call context already exists and wait for a response.
 *
 * This is the entry for contexts that are already minted: the context a send
 * derived in {@link request}. It neither derives nor checks the carrier.
 * @param context - Makaio bus context
 * @param call - Minted call context the message carries
 * @param subjectDefinition - Concrete request subject (wildcards not allowed)
 * @param payload - Request payload
 * @param options - Request options (timeout, correlationId, transports)
 * @returns Response value
 */
export async function requestWithMintedCall<
  T extends SubjectDefinition,
  Request extends T['$meta']['payload']['request'],
  Response extends T['$meta']['payload']['response'],
>(
  context: MakaioBusContext,
  call: CallContext,
  subjectDefinition: T,
  payload: Request,
  options?: InternalRequestOptions,
): Promise<Response> {
  const subjectKey = subjectDefinition.subject;
  const fullSubjectKey = getFullSubjectForSubjectDefinition(subjectDefinition);

  warnIfUnregistered(context, subjectDefinition, fullSubjectKey);

  const messageId = options?.messageId ?? nanoid();
  const correlationId = options?.correlationId ?? nanoid();
  // Budgets are validated before any work starts: an invalid one would reject
  // here only once dispatch, and with it a remote hop, was already under way.
  const timeout = requireRequestBudget('timeout', options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const readinessTimeout =
    options?.readinessTimeout === undefined
      ? undefined
      : requireRequestBudget('readinessTimeout', options.readinessTimeout);
  const signal = options?.signal;
  const localOnly = resolveLocalOnly(context, subjectDefinition, fullSubjectKey, options?.transports);

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

  // Notify production-capable message observers (fire-and-forget)
  notifyMessageObservers(context, {
    type: 'request',
    namespace: subjectDefinition.$meta.namespace,
    subject: subjectKey,
    payload,
    messageId,
    correlationId,
    transport: options?.transport,
    caller: { kind: call.caller.kind, id: call.caller.id },
    principal: { kind: call.principal.kind, id: call.principal.id },
    localOnly,
  });

  const allowedTransports = resolveAllowedTransports(options?.transports);

  // Mint the absolute deadline once at the request entry point. Every local and
  // remote handler in the dispatch chain observes this same value. timeout === 0
  // disables the deadline (no-timeout semantics).
  const deadline = timeout > 0 ? Date.now() + timeout : undefined;

  let outcome: Awaited<ReturnType<typeof dispatch>>;
  try {
    const dispatchPromise = dispatch(context, subjectDefinition, payload, {
      call,
      allowedTransports,
      correlationId,
      messageId,
      idempotencyKey: options?.idempotencyKey,
      timeout,
      readinessTimeout,
      signal,
      localOnly,
      deadline,
    });
    // timeout === 0 disables automatic timeout but still honours AbortSignal.
    outcome = await awaitWithTimeoutAndSignal(dispatchPromise, timeout, signal);
  } catch (error) {
    if (error instanceof pTimeoutError && !isRequestCancellation(error, signal)) {
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
 * Only missing-handler failures are caught; caller cancellation reasons (even a
 * NoHandlerError), timeouts, validation and handler errors propagate.
 * @param context - Makaio bus context
 * @param carrier - Carrier of the sending bus instance
 * @param call - Call context the sender passed
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
  carrier: PartyRef,
  call: CallContext,
  subjectDefinition: T,
  payload: Request,
  options?: RequestOptions,
): Promise<OptionalResult<Response>> {
  try {
    const data = await request<T, Request, Response>(context, carrier, call, subjectDefinition, payload, options);
    return { handled: true, data };
  } catch (e) {
    if (e instanceof NoHandlerError && !isRequestCancellation(e, options?.signal)) {
      return { handled: false };
    }
    throw e;
  }
}
