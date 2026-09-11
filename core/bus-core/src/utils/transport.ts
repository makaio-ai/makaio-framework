import type {
  BusMessage,
  BusRequestMessage,
  BusTransport,
  BusTransportError,
  MakaioBusContext,
} from '../types/index.js';
import type { BusTransportKeys } from '../registries/transport-registry.js';
import { NoHandlerError, NO_HANDLER_ERROR_CODE } from '../errors/index.js';
import { defineOwnValue, isJsonObject } from '@makaio/contracts';

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
 *
 * `__proto__` is additionally dropped at every codec boundary: preserving it as
 * an own enumerable member would keep `instanceof` intact here but re-arm the
 * legacy `Object.prototype.__proto__` setter at any downstream copy site that
 * uses `[[Set]]` semantics (e.g. `Object.assign({}, error)`).
 */
const SKIP_PROPS = new Set(['message', 'name', 'stack', 'cause', 'subject', 'code', '__proto__']);

/**
 * Returns true when a value is safe to include in a serialized error data bag.
 * Excludes function, undefined, bigint, and symbol values.
 * @param value - Value to check
 * @returns True when the value may be serialized
 */
function isSerializableValue(value: unknown): boolean {
  return (
    typeof value !== 'function' &&
    typeof value !== 'undefined' &&
    typeof value !== 'bigint' &&
    typeof value !== 'symbol'
  );
}

/**
 * Collects own enumerable properties from `source`, skipping keys in `skip`
 * and values that are not serializable. Reads values through
 * `Object.getOwnPropertyDescriptor` so getter-backed properties are handled
 * safely. Returns `undefined` when no properties pass the filter.
 * @param source - Object to collect from
 * @param skip - Set of property names to exclude
 * @returns Shallow record of collected properties, or undefined when empty
 */
function collectStructuredProps(source: object, skip: ReadonlySet<string>): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (skip.has(key)) continue;
    const value = Object.getOwnPropertyDescriptor(source, key)?.value as unknown;
    if (!isSerializableValue(value)) continue;
    // Use defineOwnValue so a key named "__proto__" becomes a normal own member
    // instead of invoking the Object.prototype.__proto__ setter.
    defineOwnValue(result, key, value);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

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
 * `bigint`, and `symbol` values are excluded from `data`. An own `data`
 * property on the structured source is copied like any other member, so it
 * round-trips as a nested bag at `result.data.data` and is restored by
 * {@link deserializeTransportError} as an own `data` property on the
 * reconstructed error. Use {@link transportErrorData} to read structured
 * members uniformly regardless of which serializer authored the wire payload.
 * @param error - Any thrown value
 * @returns Structured error payload safe for JSON serialization
 * @see transportErrorData
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
  const data = collectStructuredProps(structuredSource, SKIP_PROPS);
  if (data !== undefined) {
    result.data = data;
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
      // Identity fields may be filled from the bag when the dedicated top-level
      // codec field is absent — peers historically carried code/subject inside
      // data, and isNoHandlerErrorForSubject relies on them being promoted —
      // but they never overwrite a top-level value.
      if (key === 'code' || key === 'subject') {
        if ((error as Error & Record<string, unknown>)[key] === undefined && typeof value === 'string') {
          defineOwnValue(error as Error & Record<string, unknown>, key, value);
        }
        continue;
      }
      // Skip the remaining codec-reserved names so a bag entry named "message",
      // "stack", "__proto__", etc. cannot clobber the real Error fields or
      // forge the prototype of the returned object.
      if (SKIP_PROPS.has(key)) continue;
      defineOwnValue(error as Error & Record<string, unknown>, key, value);
    }
  }
  return error;
}

/**
 * Read the structured members of an error regardless of which serializer authored
 * the wire payload.
 *
 * Three producible shapes exist depending on which serializer ran:
 *
 * - **`serializeError`** copies every own enumerable prop of the structured
 *   source into `result.data`, including an authored `data` bag (which lands at
 *   `result.data.data`). After {@link deserializeTransportError} the rebuilt
 *   error has `.data` (the nested bag) as an own prop alongside any flat
 *   siblings (e.g. `.retryable`).
 * - **`serializeTransportError`** uses `error.data` as the wire bag directly, so
 *   after deserialization the members are promoted flat onto the Error with no
 *   `data` key present.
 * - A **raw `BusTransportError` object** (not yet deserialized) carries the bag
 *   under its own `data` property.
 *
 * Merge rule: own enumerable props are collected (skipping codec fields), then,
 * if the object has an own `data` whose _value_ (read via descriptor, never via
 * a getter) is a plain JSON object, the `data` key is removed from the flat set
 * and the bag members are spread in after filtering codec field names — bag
 * members win on collision. A non-plain-object `data` value (array, primitive)
 * is kept as a verbatim member of the flat set. An accessor-backed `data`
 * property is omitted entirely: its descriptor has no `value`, so both
 * `collectStructuredProps` and the merge branch ignore it — getters never run.
 *
 * Codec field names (`message`, `name`, `stack`, `cause`, `subject`, `code`)
 * are reserved and never appear in the result, whether they originate from the
 * flat props or from inside a `data` bag.
 *
 * Standard Error fields and top-level codec fields (`message`, `name`, `stack`,
 * `cause`, `subject`, `code`) are never part of the result. Returns `undefined`
 * when the value is not an object or has no qualifying members.
 * @param error - Any error value (class instance, deserialized transport error,
 *   or raw `BusTransportError` object)
 * @returns Shallow record of structured members, or undefined when none are present
 * @see serializeError
 */
export function transportErrorData(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const flat = collectStructuredProps(error as object, SKIP_PROPS) ?? {};

  // Read the descriptor once — never invokes an accessor-backed getter.
  // Accessor-backed `data` properties have no `.value` field, so `dataDesc.value`
  // is `undefined` and isJsonObject returns false, consistent with collectStructuredProps.
  const dataDesc = Object.getOwnPropertyDescriptor(error, 'data');
  if (dataDesc !== undefined && isJsonObject(dataDesc.value)) {
    const bag = dataDesc.value;
    delete flat['data'];
    // Filter codec-reserved field names from the bag so the raw-wire path and
    // the deserialized path both agree that those names are excluded. Written
    // via defineOwnValue so a bag key named "__proto__" stays an own member.
    const filteredBag: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(bag)) {
      if (!SKIP_PROPS.has(key)) defineOwnValue(filteredBag, key, value);
    }
    const merged = { ...flat, ...filteredBag };
    return Object.keys(merged).length > 0 ? merged : undefined;
  }

  return Object.keys(flat).length > 0 ? flat : undefined;
}

/**
 * Walk an error and its `cause` chain (cycle-safe) and return the first non-undefined
 * result of `predicate`, which receives each link as a plain record view.
 * @param error - Starting error value
 * @param predicate - Function called with each chain link as a record; return non-undefined to halt
 * @returns First non-undefined predicate result, or undefined when the chain is exhausted
 */
export function findInErrorChain<T>(
  error: unknown,
  predicate: (record: Record<string, unknown>) => T | undefined,
): T | undefined {
  const visited = new Set<object>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    if (visited.has(current)) break;
    visited.add(current);
    const result = predicate(current as Record<string, unknown>);
    if (result !== undefined) return result;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
