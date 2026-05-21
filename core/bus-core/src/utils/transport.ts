import type {
  BusMessage,
  BusRequestMessage,
  BusTransport,
  BusTransportError,
  MakaioBusContext,
} from '../types/index.js';
import type { BusTransportKeys } from '../registries/transport-registry.js';
import { NoHandlerError, NO_HANDLER_ERROR_CODE } from '../errors/index.js';

/**
 * Detects a "no handler" error for a specific request subject.
 *
 * Works for both in-process {@link NoHandlerError} instances and deserialized
 * errors that carry a `code` + `subject` after a transport round-trip.
 * The `subject` field is preserved by transport error serialization, so no
 * fragile message-string matching is needed.
 * @param error - Error from a relayed request or transport response
 * @param fullSubject - Full request subject key (namespace.subject)
 * @returns True when the error indicates no local handler for this subject
 */
export function isNoHandlerErrorForSubject(error: unknown, fullSubject: string): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof NoHandlerError) return error.subject === fullSubject;
  const typed = error as Error & { code?: string; subject?: string };
  if (typed.code === NO_HANDLER_ERROR_CODE) {
    return typed.subject === fullSubject;
  }
  return false;
}

/**
 * Extracts the full subject key from a bus message.
 *
 * Combines the namespace and subject into the full subject key format
 * (namespace.subject) used for handler lookups and subscription matching.
 * Returns null if the message doesn't contain the required fields.
 * @param message - Bus message (event or request)
 * @returns Full subject key in format "namespace.subject", or null if fields are missing
 * @example
 * ```typescript
 * const message: BusMessage = {
 *   type: 'event',
 *   subject: 'log',
 *   namespace: 'adapter',
 *   payload: { message: 'Hello' },
 *   messageId: 'msg-123',
 * };
 *
 * const fullSubject = getSubjectFromBusMessage(message);
 * // Returns: "adapter.log"
 * ```
 */
export function getSubjectFromBusMessage(message: BusMessage): string | null {
  return 'subject' in message && 'namespace' in message ? `${message.namespace}.${message.subject}` : null;
}

/**
 * Locale-independent string comparator for deterministic transport ordering.
 * @param a - First string
 * @param b - Second string
 * @returns Negative if a precedes b, positive if a follows b, zero if equal
 */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Returns all registered transports except `exclude`, sorted by name.
 *
 * Uses locale-independent string comparison for deterministic ordering
 * across environments. Shared by both the outbound request path and the
 * inbound relay path to keep ordering rules in one place.
 * @param context - Bus context containing the transport registry
 * @param exclude - Optional transport name to exclude (e.g., message source)
 * @returns Deterministically ordered `{ name, transport }` pairs
 */
export function getSortedTransports(
  context: MakaioBusContext,
  exclude?: BusTransportKeys,
): Array<{ name: BusTransportKeys; transport: BusTransport }> {
  return context.transportRegistry
    .names()
    .filter((name) => name !== exclude)
    .sort((a, b) => compareStrings(String(a), String(b)))
    .map((name) => ({ name, transport: context.transportRegistry.getTransport(name) }))
    .filter((entry): entry is { name: BusTransportKeys; transport: BusTransport } => entry.transport !== undefined);
}

/**
 * Returns ready transports — sorted transports filtered to those whose
 * `isReady()` check does not return `false`.
 *
 * Used on outbound send paths (request, broadcast) and RPC relay to skip
 * transports that have not yet established end-to-end connectivity (e.g.,
 * the E2E relay transport before the session key is established).
 *
 * The `!== false` predicate preserves backward compatibility: transports that
 * do not implement `isReady()` are treated as always ready.
 * @param context - Bus context containing the transport registry
 * @param exclude - Optional transport name to exclude (e.g., message source for relay)
 * @returns Deterministically ordered `{ name, transport }` pairs for ready transports
 */
export function getReadyTransports(
  context: MakaioBusContext,
  exclude?: BusTransportKeys,
): Array<{ name: BusTransportKeys; transport: BusTransport }> {
  return getSortedTransports(context, exclude).filter(({ transport }) => transport.isReady?.() !== false);
}

/**
 * Top-level Error fields and fields already serialized as dedicated
 * {@link BusTransportError} properties — excluded from the generic `data` bag.
 */
const SKIP_PROPS = new Set(['message', 'name', 'stack', 'cause', 'subject', 'code']);

/**
 * Serialize an unknown error into a structured {@link BusTransportError} for wire transmission.
 *
 * Extracts `code`, `subject`, and all own enumerable properties from the
 * structured source error (i.e. `error.cause` when it is an `Error`, otherwise
 * `error` itself) into `BusTransportError.data`, so the receiving side can
 * reconstruct a rich error via {@link deserializeTransportError} without fragile
 * message-string matching.
 *
 * Standard `Error` fields (`message`, `name`, `stack`, `cause`), the already
 * top-level `subject` and `code` fields, as well as functions, `undefined`,
 * `bigint`, and `symbol` values are excluded from `data`.
 * @param error - Any thrown value
 * @returns Structured error payload safe for JSON serialization
 */
export function serializeError(error: unknown): BusTransportError {
  if (!(error instanceof Error)) {
    return { message: typeof error === 'string' ? error : 'Unknown error' };
  }

  const result: BusTransportError = { message: error.message };
  const structuredSource = error.cause instanceof Error ? error.cause : error;
  const codeSource = 'code' in error ? error : structuredSource;

  if ('code' in codeSource && typeof codeSource.code === 'string') {
    result.code = codeSource.code;
  }

  // Preserve subject for NoHandlerError so isNoHandlerErrorForSubject can
  // match after a serialize → deserialize round-trip without string matching.
  // Prefer the wrapper subject when it is a string, otherwise fall back to the
  // structured source so wrapped transport errors still preserve subject.
  const wrapperSubject = 'subject' in error ? (error as { subject?: unknown }).subject : undefined;
  const structuredSubject =
    'subject' in structuredSource ? (structuredSource as { subject?: unknown }).subject : undefined;
  if (typeof wrapperSubject === 'string') {
    result.subject = wrapperSubject;
  } else if (typeof structuredSubject === 'string') {
    result.subject = structuredSubject;
  }

  // Copy own enumerable properties from the structured source into data.
  // Non-JSON-safe primitives (function, undefined, bigint, symbol) are
  // excluded at the top level. Deep sanitization (nested bigint, circular
  // refs, third-party HTTP error objects like Axios request/response/config)
  // is intentionally omitted — bus handlers are internal code and must not
  // throw raw third-party errors through the bus. If a handler does, the
  // transport's JSON.stringify will fail and the error response is lost,
  // which is the correct signal that the handler's error shape is broken.
  for (const key of Object.keys(structuredSource)) {
    if (SKIP_PROPS.has(key)) continue;
    const value = Object.getOwnPropertyDescriptor(structuredSource, key)?.value as unknown;
    if (
      typeof value === 'function' ||
      typeof value === 'undefined' ||
      typeof value === 'bigint' ||
      typeof value === 'symbol'
    )
      continue;
    result.data ??= {};
    result.data[key] = value;
  }

  return result;
}

/**
 * Send a serialized error response for a failed request back to the originating transport.
 * @param transport - Transport used to send the response
 * @param message - Original request message
 * @param error - Error to serialize into the response
 * @returns Promise that resolves when the response is sent or logged on failure
 */
export async function sendErrorResponse(
  transport: BusTransport,
  message: BusRequestMessage,
  error: unknown,
): Promise<void> {
  try {
    await transport.send({ type: 'response', correlationId: message.correlationId, error: serializeError(error) });
  } catch (err) {
    console.error('[TransportRegistry] Failed to send error response:', err);
  }
}

/**
 * Reconstruct an Error from a structured transport error payload.
 *
 * Preserves `code` and arbitrary `data` properties so callers can
 * inspect them for programmatic error handling.
 * @param transportError - The structured error received over the wire
 * @returns An Error with `code` and data properties attached
 */
export function deserializeTransportError(transportError: BusTransportError): Error {
  const error = new Error(transportError.message);
  if (transportError.code) {
    (error as Error & { code?: string }).code = transportError.code;
  }
  if (transportError.subject) {
    (error as Error & { subject?: string }).subject = transportError.subject;
  }
  if (transportError.data) {
    for (const [key, value] of Object.entries(transportError.data)) {
      (error as Error & Record<string, unknown>)[key] = value;
    }
  }
  return error;
}
