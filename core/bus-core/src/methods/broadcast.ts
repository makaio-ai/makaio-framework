import type { RequestOptions, MakaioBusContext, WithReceiveContext } from '../types/index.js';
import type { RequestContext, RequestHandler, SubjectDefinition, TransportReceiveContext } from '@makaio/core';
import { nanoid } from 'nanoid';
import { getMatchingHandlers } from './request/getMatchingHandlers.js';
import { getFullSubjectForSubjectDefinition } from '../utils/subject-transformation.js';
import { getReadyTransports } from '../utils/transport.js';
import { normalizeTransportTargets } from './request/normalizeTransportTargets.js';
import { invokeAnyHandlers } from '../utils/invoke-any-handlers.js';
import { TimeoutError as pTimeoutError } from 'p-timeout';
import { TimeoutError } from '../errors/index.js';
import { awaitWithTimeoutAndSignal } from './request/await-with-timeout-and-signal.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../types/options.js';
import {
  resolveRequestValidation,
  validateRequestPayload,
  validateResponsePayload,
} from '../utils/validate-request-payload.js';
import type { RequestValidationContext } from '../utils/validate-request-payload.js';

type InternalBroadcastOptions = RequestOptions & WithReceiveContext;

/**
 * Result from a single handler in a broadcast.
 * @typeParam T - Response payload type
 */
export interface BroadcastResult<T> {
  /** Handler identifier (set via ctx.identify() in handler, or 'anonymous' if not set) */
  nodeId: string;
  /** Response payload from the handler */
  payload: T;
}

/**
 * Extended request context for broadcast handlers.
 * Adds identify() method to tag responses with a node identifier.
 */
export interface BroadcastContext<Request, Response> extends RequestContext<Request, Response> {
  /**
   * Identify this handler for broadcast aggregation.
   * Call before setResult() to tag the response with a nodeId.
   * @param nodeId - Unique identifier for this handler/node
   */
  identify: (nodeId: string) => void;
}

/**
 * Create a broadcast-aware context that captures results with identity.
 * @param payload - The request payload
 * @param messageId - Unique message identifier
 * @param correlationId - Correlation ID for tracing
 * @param onResult - Callback invoked when a handler sets its result
 * @param transport - Trusted context supplied by the receiving transport
 * @returns A request context for broadcast handlers
 */
function createBroadcastContext<P, R>(
  payload: P,
  messageId: string,
  correlationId: string,
  onResult: (nodeId: string, result: R) => void,
  transport?: TransportReceiveContext,
): RequestContext<P, R> {
  let nodeId = 'anonymous';
  let resultSet = false;
  let resultValue: R | undefined;

  const context: BroadcastContext<P, R> = {
    isRequest: true,
    payload,
    messageId,
    correlationId,
    transport,
    get result() {
      return resultValue;
    },
    identify: (id: string) => {
      nodeId = id;
    },
    // First setResult wins in broadcast: each handler produces one result entry.
    // Use extendResult to accumulate fields incrementally.
    setResult: (value: R) => {
      if (!resultSet) {
        resultSet = true;
        resultValue = value;
        onResult(nodeId, value);
      }
    },
    // onResult() is called once to push a reference into the results array.
    // After that, Object.assign mutates the same object in place so the
    // already-pushed entry in results reflects the accumulated fields.
    // The distributive conditional type is intentional: R is constrained to
    // objects at compile time (Zod response schemas are always z.object).
    // Broadcast response validation happens after each handler completes so
    // incremental extendResult() calls are validated as one final response.
    extendResult: (extension: [R] extends [Record<string, unknown>] ? Partial<R> : never) => {
      if (resultSet) {
        Object.assign(resultValue as Record<string, unknown>, extension);
      } else {
        resultValue = { ...extension } as R;
        resultSet = true;
        onResult(nodeId, resultValue);
      }
    },
    next: async () => {
      // In broadcast mode, next() is a no-op since we don't chain handlers
    },
    replacePayload: () => {
      // In broadcast mode, replacePayload() is a no-op since we don't chain handlers
    },
  };

  return context;
}

interface LocalBroadcastHandlerOptions<Request> {
  payload: Request;
  messageId: string;
  correlationId: string;
  subjectKey: string;
  fullSubjectKey: string;
  transport?: TransportReceiveContext;
  validationCtx: RequestValidationContext;
}

/**
 * Execute one local broadcast handler and return its validated final results.
 * @param handler - Broadcast handler to execute
 * @param options - Handler execution context and validation config
 * @returns Results produced by this handler, or an empty array when it fails
 */
async function executeLocalBroadcastHandler<Request, Response>(
  handler: RequestHandler<unknown, unknown>,
  options: LocalBroadcastHandlerOptions<Request>,
): Promise<Array<BroadcastResult<Response>>> {
  const handlerResults: Array<BroadcastResult<Response>> = [];
  const handlerContext = createBroadcastContext<Request, Response>(
    options.payload,
    options.messageId,
    options.correlationId,
    (nodeId, result) => {
      handlerResults.push({ nodeId, payload: result });
    },
    options.transport,
  );

  try {
    await handler(handlerContext as RequestContext<unknown, unknown>);
  } catch (error) {
    console.error(
      `[${options.correlationId}][${options.messageId}] Broadcast handler error for "${options.subjectKey}":`,
      error,
    );
    return [];
  }

  for (const result of handlerResults) {
    validateResponsePayload(options.fullSubjectKey, result.payload, options.validationCtx);
  }
  return handlerResults;
}

/**
 * Execute a broadcast request to ALL local handlers AND transports, collecting all responses.
 *
 * Unlike `request()` which uses a middleware chain and returns the first result,
 * `broadcast()` executes all handlers in parallel and aggregates their responses.
 *
 * Use for discovery patterns where multiple nodes may respond (e.g., fs.listSources).
 *
 * **Handler Usage:**
 * Handlers should call `ctx.identify(nodeId)` before `ctx.setResult()` to tag their response.
 * If `identify()` is not called, the response is tagged as 'anonymous'.
 * @param context - Makaio bus context
 * @param subjectDefinition - Request subject (must be a request-type subject, not event)
 * @param payload - Request payload (typed from subject definition)
 * @param options - Request options (timeout, correlationId, transports)
 * @returns Array of \{ nodeId, payload \} responses from all handlers and transports
 * @example
 * ```typescript
 * // Handler identifies itself
 * MakaioBus.on(FileSystemSubjects.listSources, (ctx) => \{
 *   ctx.identify?.(nodeId); // Optional but recommended for broadcast subjects
 *   ctx.setResult(\{ sources: [\{ nodeId, label: 'Local' \}] \});
 * \});
 *
 * // Broadcast collects all responses from local handlers AND remote transports
 * const results = await MakaioBus.broadcast(FileSystemSubjects.listSources, \{\});
 * // results: [
 * //   \{ nodeId: 'local', payload: \{ sources: [...] \} \},
 * //   \{ nodeId: 'remote', payload: \{ sources: [...] \} \},
 * // ]
 *
 * // Aggregate sources from all nodes
 * const allSources = results.flatMap(r => r.payload.sources);
 * ```
 */
export async function broadcast<
  T extends SubjectDefinition,
  Request extends T['$meta']['payload']['request'],
  Response extends T['$meta']['payload']['response'],
>(
  context: MakaioBusContext,
  subjectDefinition: T,
  payload: Request,
  options?: InternalBroadcastOptions,
): Promise<BroadcastResult<Response>[]> {
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
    'broadcast',
    subjectKey,
    subjectDefinition.$meta.namespace,
    payload,
    messageId,
    correlationId,
  );

  // Collect results from all sources
  const results: BroadcastResult<Response>[] = [];

  // Find all local handlers matching this subject
  const handlers = getMatchingHandlers(context, fullSubjectKey);

  // Unfiltered by default — subscription filtering can silently exclude valid
  // respondents when subscriptions are populated lazily (e.g., WorkerTransport
  // accumulates subscriptions after init, causing broadcast subjects not in
  // the set to be silently dropped).
  //
  // Explicit path (options.transports provided): the caller knows the target(s),
  // so normalizeTransportTargets applies their specification directly. This is
  // critical for handleBroadcastMessage which passes transports:[] to suppress
  // transport dispatch during relay (local-only execution).
  const transportTargets =
    options?.transports === undefined
      ? subjectDefinition.$meta.local
        ? []
        : getReadyTransports(context).map(({ transport }) => transport)
      : normalizeTransportTargets(context, options.transports, subjectDefinition);

  const localPromises = handlers.map(async (handler) => {
    const handlerResults = await executeLocalBroadcastHandler<Request, Response>(handler, {
      payload,
      messageId,
      correlationId,
      subjectKey,
      fullSubjectKey,
      transport: options?.transport,
      validationCtx,
    });
    results.push(...handlerResults);
  });

  // Execute transport broadcasts in parallel (each transport returns array of results)
  const transportPromises = transportTargets.map(async (transport) => {
    try {
      const transportResults = await transport.send(
        {
          type: 'broadcast',
          subject: subjectKey,
          namespace: subjectDefinition.$meta.namespace,
          payload,
          correlationId,
          messageId,
          timeout,
        },
        timeout,
      );

      // Transport returns array of { nodeId, payload } from all remote handlers
      for (const result of transportResults) {
        validateResponsePayload(fullSubjectKey, result.payload, validationCtx);
        results.push({ nodeId: result.nodeId, payload: result.payload as Response });
      }
    } catch (error) {
      // Transport errors are logged but don't fail the broadcast
      console.error(`[${correlationId}][${messageId}] Broadcast transport error for "${subjectKey}":`, error);
    }
  });

  try {
    await awaitWithTimeoutAndSignal(Promise.all([...localPromises, ...transportPromises]), timeout, signal);
  } catch (error) {
    if (error instanceof pTimeoutError) {
      throw new TimeoutError(subjectKey, timeout);
    }
    throw error;
  }

  return results;
}
