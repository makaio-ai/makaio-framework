/**
 * Operator-facing logging for the gateway.
 *
 * The gateway is run in a terminal, so the question an operator needs answered
 * first is "did anything arrive, and what happened to it?". The `requestRouted`
 * bus event answers that for subscribers, but it is invisible to someone
 * watching the server output — and a rejected request emits no event at all,
 * whether it was turned away before routing (401, 413, 400, 404) or failed
 * outright once routing had begun (499, 500). This module supplies the console
 * counterpart: exactly one line per request the gateway accepted, and one per
 * request it turned away.
 *
 * **Seam:** {@link GatewayLogger} is the injection point. The router defaults to
 * the console sink; a host that owns its own sink (or a test that needs to
 * assert on output) supplies its own implementation instead. There is no level
 * configuration — a line is informational, a warning, or an error, and all three
 * are always written. Every call into a sink goes through {@link safeLog}, so a
 * sink that throws or returns a rejecting promise cannot turn a proxied response
 * into a 500 or leave an upstream body unconsumed.
 *
 * **Scope of `error`:** reserved for a fault the gateway cannot recover from on
 * its own and that no single request explains — today, credentials that could
 * not be resolved once the host finished starting. Per-request failures stay at
 * warning level, however the request ended.
 *
 * **Scope:** the sink, the guard around it, and the line formatters. Reading an
 * upstream error body is a proxy-layer concern and lives in
 * `proxy/upstream-error.ts`; this module only renders the summary that produces.
 *
 * **Secrets:** nothing here reads request or response headers, bodies, or
 * message content. An upstream error body is never logged raw — see
 * `proxy/upstream-error.ts` for the allowlist that produces the summary — and
 * client-controlled values are length-capped so an oversized model identifier
 * cannot produce an oversized log line.
 * @packageDocumentation
 */

import type { RequestRoutedEvent } from './contracts/schemas.js';
import type { UpstreamErrorSummary } from './proxy/upstream-error.js';

/** Prefix applied by the console sink to every line it writes. */
const LOG_PREFIX = '[gateway]';

/**
 * Maximum characters kept from a client- or config-controlled field.
 *
 * Model identifiers arrive verbatim in the request body and have no length
 * limit of their own, so without a cap a multi-megabyte `model` string would
 * produce a multi-megabyte log line.
 */
const FIELD_CHARS = 200;

/**
 * Maximum characters kept from a free-form message produced elsewhere.
 *
 * Covers an extracted upstream error message and a credential-resolution
 * failure: both are text the gateway did not author and cannot bound.
 */
const MESSAGE_CHARS = 512;

/**
 * Reason reported when the gateway cannot resolve its credentials.
 *
 * Shared by the startup error line and by every `503` rejection line written
 * while the credentials are still unavailable, so one grep finds the cause and
 * all of its consequences.
 */
export const CREDENTIALS_UNAVAILABLE_REASON = 'credentials unavailable';

/** The severities a {@link GatewayLogger} accepts. */
export type GatewayLogLevel = 'info' | 'warn' | 'error';

/**
 * Minimal sink the gateway writes operator-facing lines to.
 *
 * Deliberately narrower than a general logging interface: the gateway has
 * exactly three severities and formats its own messages, so a sink needs
 * nothing beyond three string-taking methods.
 */
export interface GatewayLogger {
  /**
   * Record an expected, successful event.
   * @param message - Preformatted single-line message, without a prefix.
   */
  info(message: string): void;
  /**
   * Record a rejected request or a request that did not complete successfully.
   * @param message - Preformatted single-line message, without a prefix.
   */
  warn(message: string): void;
  /**
   * Record a fault that leaves the gateway unable to serve requests until an
   * operator or another service fixes it.
   * @param message - Preformatted single-line message, without a prefix.
   */
  error(message: string): void;
}

/**
 * Default sink: writes to the process console, prefixed with `[gateway]`.
 *
 * Matches the runtime's own startup logging convention so gateway lines are
 * recognisable in an interleaved server log.
 */
const consoleGatewayLogger: GatewayLogger = {
  /**
   * Write an informational line to `console.info`.
   * @param message - Preformatted single-line message, without a prefix.
   */
  info(message: string): void {
    console.info(`${LOG_PREFIX} ${message}`);
  },
  /**
   * Write a warning line to `console.warn`.
   * @param message - Preformatted single-line message, without a prefix.
   */
  warn(message: string): void {
    console.warn(`${LOG_PREFIX} ${message}`);
  },
  /**
   * Write an error line to `console.error`.
   * @param message - Preformatted single-line message, without a prefix.
   */
  error(message: string): void {
    console.error(`${LOG_PREFIX} ${message}`);
  },
};

/**
 * Resolve the sink to use for a request.
 * @param logger - Caller-supplied sink, or `undefined` to use the console.
 * @returns The sink to write through.
 */
export function resolveGatewayLogger(logger: GatewayLogger | undefined): GatewayLogger {
  return logger ?? consoleGatewayLogger;
}

/**
 * Write one line through a sink, absorbing anything the sink does wrong.
 *
 * The sole boundary between the gateway and a host-supplied sink. Logging is
 * diagnostics: a sink that throws — or that is declared `void` but actually
 * returns a rejecting promise — must not propagate into the request path, where
 * it would turn a successfully proxied response into a 500 or abandon an
 * upstream body mid-stream.
 * @param logger - Sink to write to.
 * @param level - Severity to write at.
 * @param message - Preformatted single-line message, without a prefix.
 */
function safeLog(logger: GatewayLogger, level: GatewayLogLevel, message: string): void {
  try {
    const written: unknown = logger[level](message);
    if (written instanceof Promise) {
      void written.catch(() => undefined);
    }
  } catch {
    // A broken sink is an operator-tooling problem, never a client-facing one.
  }
}

/**
 * Flatten a value to a single line.
 *
 * Runs of whitespace and of Unicode "other" code points — controls, format
 * characters, surrogates, unassigned — collapse to one space. Applied to every
 * free-form value before it reaches a log line, because model identifiers come
 * straight from the client request body and upstream error messages are
 * arbitrary text; either could otherwise break the one-line-per-request
 * contract or smuggle a terminal escape sequence into the operator's console.
 * @param value - Raw value to flatten.
 * @returns The value with control characters and whitespace runs collapsed.
 */
function collapseToSingleLine(value: string): string {
  return value.replace(/[\p{C}\s]+/gu, ' ').trim();
}

/**
 * Shorten a value to at most `maxChars`, marking that it was cut.
 * @param value - Value to shorten.
 * @param maxChars - Maximum number of characters to keep.
 * @returns The original value, or its first `maxChars` characters plus `...`.
 */
function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

/**
 * Render a free-form value as a quoted, single-line, length-capped log field.
 *
 * `JSON.stringify` supplies the quoting and escaping rules, so a value
 * containing a quote character stays unambiguous rather than silently
 * truncating the field.
 * @param value - Raw value to render.
 * @param maxChars - Maximum number of characters to keep.
 * @returns The value, flattened, capped, and wrapped in double quotes.
 */
function field(value: string, maxChars: number): string {
  return JSON.stringify(truncate(collapseToSingleLine(value), maxChars));
}

/**
 * Render numeric detail fields as `key=value` fragments.
 * @param detail - Numeric fields to append to a log line.
 * @returns The fragments in declaration order.
 */
function formatDetail(detail: Readonly<Record<string, number>>): string[] {
  return Object.entries(detail).map(([key, value]) => `${key}=${value}`);
}

/**
 * Render an upstream error summary as log-line fragments.
 * @param summary - What was learned about the upstream error body.
 * @returns The fragments to append to the routed-request line.
 */
function formatUpstreamError(summary: UpstreamErrorSummary): string[] {
  if (summary.kind === 'message') {
    return [`upstreamError=${field(summary.text, MESSAGE_CHARS)}`];
  }
  const parts = [`upstreamErrorBytes=${summary.bytes}${summary.truncated ? '+' : ''}`];
  if (summary.contentType !== null) {
    parts.push(`upstreamContentType=${field(summary.contentType, FIELD_CHARS)}`);
  }
  return parts;
}

/**
 * Whether a routed request finished the way the client asked it to.
 *
 * Anything else — a non-2xx upstream status, a client disconnect, or an
 * unreachable upstream — is what an operator is scanning for, so it is logged
 * at warning level.
 * @param event - Routing telemetry for the completed request.
 * @returns `true` when the upstream returned a 2xx response.
 */
function isSuccessfulRoute(event: RequestRoutedEvent): boolean {
  return event.outcome === 'completed' && event.status !== null && event.status >= 200 && event.status < 300;
}

/**
 * Format the single line written for a routed request.
 *
 * Every field except the HTTP method is read from the emitted
 * {@link RequestRoutedEvent}, so the log line and the bus event cannot describe
 * the same request differently. `upstreamModel` appears only when a rule
 * renamed the model, because repeating the requested model adds noise to the
 * common case.
 * @param method - HTTP method of the client request.
 * @param event - Routing telemetry emitted for this request.
 * @param upstreamError - What was learned about the upstream error body, when
 *   the upstream responded with a client or server error.
 * @returns The formatted line, without a prefix.
 */
function formatRoutedRequestLine(
  method: string,
  event: RequestRoutedEvent,
  upstreamError?: UpstreamErrorSummary,
): string {
  const parts = [
    `${method} ${event.path}`,
    `model=${field(event.requestedModel, FIELD_CHARS)}`,
    `upstream=${field(event.upstream, FIELD_CHARS)}`,
    `kind=${event.target}`,
  ];
  if (event.upstreamModel !== event.requestedModel) {
    parts.push(`upstreamModel=${field(event.upstreamModel, FIELD_CHARS)}`);
  }
  parts.push(
    `rule=${event.ruleIndex === null ? 'default' : String(event.ruleIndex)}`,
    `outcome=${event.outcome}`,
    `status=${event.status === null ? '-' : String(event.status)}`,
    `streamed=${String(event.streamed)}`,
    `duration=${Math.round(event.durationMs)}ms`,
  );
  if (upstreamError !== undefined) {
    parts.push(...formatUpstreamError(upstreamError));
  }
  return parts.join(' ');
}

/**
 * Write the routed-request line at the severity implied by its outcome.
 * @param logger - Sink to write to.
 * @param method - HTTP method of the client request.
 * @param event - Routing telemetry emitted for this request.
 * @param upstreamError - What was learned about the upstream error body, when
 *   the upstream responded with a client or server error.
 */
export function logRoutedRequest(
  logger: GatewayLogger,
  method: string,
  event: RequestRoutedEvent,
  upstreamError?: UpstreamErrorSummary,
): void {
  safeLog(logger, isSuccessfulRoute(event) ? 'info' : 'warn', formatRoutedRequestLine(method, event, upstreamError));
}

/** Everything a rejection line reports about a request the gateway turned away. */
export interface RejectionLineFields {
  /** HTTP method of the client request. */
  readonly method: string;
  /**
   * Path the rejection applies to.
   *
   * The two body rejections report the routed endpoint (`/v1/messages`), which
   * matches what a routed line shows; so does the 499/500 line for a request
   * that failed in no anticipated way, which is the one rejection that can be
   * written after routing began. The gate (503 and 401) and the catch-all (404)
   * run ahead of route matching and therefore report the full request pathname,
   * including the prefix the gateway is mounted under.
   *
   * A 503 can be written from either side of that split: the gate writes one
   * with the full pathname, and `routeRequest` writes one with the routed
   * endpoint when the gateway was torn down after the gate had let the request
   * through.
   */
  readonly path: string;
  /** HTTP status returned to the client. */
  readonly status: number;
  /** Why the request was rejected. Never contains a credential. */
  readonly reason: string;
  /** Numeric context such as byte counts, rendered as `key=value` fragments. */
  readonly detail?: Readonly<Record<string, number>>;
}

/**
 * Format the single line written for a request the gateway turned away.
 * @param fields - What to report about the rejection.
 * @returns The formatted line, without a prefix.
 */
function formatRejectionLine(fields: RejectionLineFields): string {
  const parts = [
    `${fields.method} ${fields.path}`,
    'rejected',
    `status=${fields.status}`,
    `reason=${field(fields.reason, FIELD_CHARS)}`,
  ];
  if (fields.detail !== undefined) {
    parts.push(...formatDetail(fields.detail));
  }
  return parts.join(' ');
}

/**
 * Write the single line for a request the gateway turned away.
 * @param logger - Sink to write to.
 * @param fields - What to report about the rejection.
 */
export function logRejection(logger: GatewayLogger, fields: RejectionLineFields): void {
  safeLog(logger, 'warn', formatRejectionLine(fields));
}

/**
 * Write the single line reporting that the gateway has no usable credentials.
 *
 * Written once per failed resolution attempt at the coordinator-ready barrier,
 * not per request: the request path reports the same fault as a `503` rejection
 * line, and repeating the cause on every request would bury it.
 *
 * `reason` is the message of the failure the credential resolution produced. By
 * construction it names the configuration site and the credential reference
 * that could not be resolved, never a resolved value.
 * @param logger - Sink to write to.
 * @param reason - Why the credentials could not be resolved.
 */
export function logCredentialFailure(logger: GatewayLogger, reason: string): void {
  safeLog(logger, 'error', `${CREDENTIALS_UNAVAILABLE_REASON} reason=${field(reason, MESSAGE_CHARS)}`);
}
