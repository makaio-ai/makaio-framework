import {
  SDKUserMessageSchema,
  SDKAssistantMessageSchema,
  SDKResultMessageSchema,
  SDKSystemMessageSchema,
  SDKStreamEventMessageSchema,
  TurnStateChangedEventSchema,
  SDKMessageSchema,
  type SDKMessage,
} from '@makaio/client-claude-code';
import { createAdapterNamespace, ScopedToolApprovalSchema } from '@makaio/ai-adapters-core';
import type { ScopedBusFor } from '@makaio/bus-core';
import type { NamespaceRegistrationOptions, SchemaViolationReport } from '@makaio/core';

export type { SDKMessage };
export { SDKMessageSchema };

type ZodIssueWithNestedErrors = {
  path?: PropertyKey[];
  message?: string;
  errors?: unknown;
};

const sensitivePayloadKeyPattern =
  /(?:api[_-]?key|authorization|bearer|credential|password|private[_-]?key|secret|token|(?:^|[_-])key(?:$|[_-])|(?:^|[_-])pat(?:$|[_-]))/i;
const textPayloadKeyPattern = /^(?:message|content|prompt|text|output)$/i;
const maxViolationStringPreviewLength = 80;

/**
 * Redact user text while leaving short protocol identifiers readable.
 * @param value - Raw string value from a violation payload
 * @returns Redacted text marker or short preview
 */
function redactTextPayload(value: string): string {
  return value.length > maxViolationStringPreviewLength
    ? `${value.slice(0, maxViolationStringPreviewLength)}... [redacted-text]`
    : '[redacted-text]';
}

/**
 * Format a Zod issue, recursively expanding union branch errors when present.
 * @param issue - Zod issue or nested issue-like object
 * @returns Compact issue descriptions suitable for one-line logs
 */
function formatViolationIssue(issue: ZodIssueWithNestedErrors): string[] {
  if (Array.isArray(issue.errors)) {
    return issue.errors.flatMap((branch) =>
      Array.isArray(branch) ? branch.flatMap((nested) => formatViolationIssue(nested as ZodIssueWithNestedErrors)) : [],
    );
  }

  const path = issue.path?.map(String).join('.') || '(root)';
  return [`${path}: ${issue.message ?? 'Invalid input'}`];
}

/**
 * Redact credential-like values while preserving the payload shape.
 * @param key - Property key for the value currently being redacted
 * @param value - Raw payload value
 * @returns Redacted value suitable for schema violation logs
 */
function redactViolationPayloadValue(key: string | undefined, value: unknown): unknown {
  if (key && key !== 'apiKeySource' && sensitivePayloadKeyPattern.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    if (key && textPayloadKeyPattern.test(key)) return redactTextPayload(value);
    if (value.length > maxViolationStringPreviewLength) return redactTextPayload(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactViolationPayloadValue(undefined, item));
  if (value && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      redacted[childKey] = redactViolationPayloadValue(childKey, childValue);
    }
    return redacted;
  }
  return value;
}

/**
 * Preserve the failed SDK payload for diagnostics without logging credentials.
 * @param payload - Raw payload from the schema violation report
 * @returns Redacted payload for conformance artifacts
 */
function redactViolationPayload(payload: unknown): Record<string, unknown> | undefined {
  const redacted = redactViolationPayloadValue(undefined, payload);
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : undefined;
}

/**
 * Default lenient-mode violation handler for Claude protocol adapters.
 *
 * Writes a compact, structured single-line warning to stderr so violations
 * cross the vitest fork boundary via the console log channel and are
 * parseable by the conformance log-parser.
 * @param report - Schema violation details
 */
function logSchemaViolation(report: SchemaViolationReport): void {
  const details = {
    subject: report.subject,
    issues: report.issues.flatMap((issue) => formatViolationIssue(issue as ZodIssueWithNestedErrors)),
    sample: redactViolationPayload(report.payload),
  };
  console.warn(`[BUS:VIOLATION] ${JSON.stringify(details)}`);
}

/**
 * Creates a Claude protocol adapter namespace registered on the bus.
 *
 * Both the claude-code and anthropic-sdk adapters speak the same Claude
 * protocol (same event shapes and subjects) but must register under
 * different namespace names. This factory avoids duplicating the subject
 * definitions across adapters.
 *
 * Registers with lenient validation by default: external SDK schema drift
 * triggers a warning instead of crashing the session.
 * @param namespaceName - The bus namespace domain (e.g., 'adapter:claude-code')
 * @param validationOptions - Optional bus validation override for tests or adapter-specific policy
 * @returns Typed adapter namespace with subjects and scoped bus factory
 */
export function createClaudeConnectorNamespace<N extends string>(
  namespaceName: N,
  validationOptions?: NamespaceRegistrationOptions,
) {
  return createAdapterNamespace(
    namespaceName,
    {
      // Raw SDK event catch-all (for observability/debugging)
      'sdk.event': SDKMessageSchema,

      // Tool approval RPC — sessionId optional at connector layer; enriched by agent before global forwarding
      can_use_tool: ScopedToolApprovalSchema,

      // Semantic subjects (typed events for agent layer)
      system: SDKSystemMessageSchema,
      assistant: SDKAssistantMessageSchema,
      user: SDKUserMessageSchema,
      result: SDKResultMessageSchema,
      stream_event: SDKStreamEventMessageSchema,

      // Turn state events (for Session/Turn extraction)
      'turn.state_changed': TurnStateChangedEventSchema,
      'turn.turn_started': TurnStateChangedEventSchema,
      'turn.step_started': TurnStateChangedEventSchema,
      'turn.step_finished': TurnStateChangedEventSchema,
      'turn.turn_finished': TurnStateChangedEventSchema,
      'turn.paused': TurnStateChangedEventSchema,
    },
    validationOptions ?? {
      busValidationMode: 'lenient',
      onSchemaViolation: logSchemaViolation,
    },
  );
}

/**
 * Type of the namespace returned by {@link createClaudeConnectorNamespace}.
 * @typeParam N - The namespace domain string literal
 */
export type ClaudeConnectorNamespace<N extends string> = ReturnType<typeof createClaudeConnectorNamespace<N>>;

/**
 * Scoped bus type for a Claude connector namespace.
 * @typeParam N - The namespace domain string literal
 */
export type ClaudeConnectorBus<N extends string> = ScopedBusFor<ClaudeConnectorNamespace<N>>;
