const SENSITIVE_TRIGGER_PAYLOAD_KEY =
  /(?:^|[_-])(authorization|token|cookie|password|set[_-]?cookie|api[_-]?key|secret|credential|private[_-]?key|api[_-]?secret)(?:$|[_-])/i;
const MAX_TRIGGER_PAYLOAD_DEPTH = 6;
const MAX_TRIGGER_PAYLOAD_KEYS = 100;
const MAX_TRIGGER_PAYLOAD_ARRAY_ITEMS = 100;
const MAX_TRIGGER_PAYLOAD_STRING_LENGTH = 2_000;
const MAX_TRIGGER_PAYLOAD_APPROX_BYTES = 64 * 1024;

interface SanitizeBudget {
  remainingBytes: number;
}

/**
 * Sanitize trigger payload before persistence and template resolution.
 * Applies best-effort redaction and bounding to avoid storing oversized or sensitive data blobs.
 * @param triggerPayload - Raw trigger payload from the trigger source
 * @returns Sanitized payload suitable for persistence and expression context
 */
export function sanitizeTriggerPayload(triggerPayload?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!triggerPayload) return undefined;
  const budget: SanitizeBudget = { remainingBytes: MAX_TRIGGER_PAYLOAD_APPROX_BYTES };
  const result: Record<string, unknown> = {};
  const entries = Object.entries(triggerPayload).slice(0, MAX_TRIGGER_PAYLOAD_KEYS);
  for (const [key, value] of entries) {
    if (budget.remainingBytes <= 0) break;
    const safeValue = sanitizeTriggerPayloadValue(key, value, 0, budget);
    if (safeValue === undefined) continue;
    result[key] = safeValue;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Recursively sanitize trigger payload values with depth/size limits and key-based redaction.
 * @param key - Key associated with the current value
 * @param value - Value to sanitize
 * @param depth - Current recursion depth
 * @param budget - Remaining size budget
 * @returns Sanitized value or undefined when dropped
 */
function sanitizeTriggerPayloadValue(key: string, value: unknown, depth: number, budget: SanitizeBudget): unknown {
  if (budget.remainingBytes <= 0 || depth > MAX_TRIGGER_PAYLOAD_DEPTH) return undefined;
  budget.remainingBytes -= key.length;
  if (budget.remainingBytes <= 0) return undefined;

  if (SENSITIVE_TRIGGER_PAYLOAD_KEY.test(key)) {
    budget.remainingBytes -= 10;
    return '[REDACTED]';
  }

  if (value === null) {
    budget.remainingBytes -= 4;
    return null;
  }
  if (typeof value === 'string') {
    const truncated = value.slice(0, MAX_TRIGGER_PAYLOAD_STRING_LENGTH);
    budget.remainingBytes -= truncated.length;
    return truncated;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    budget.remainingBytes -= String(value).length;
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, MAX_TRIGGER_PAYLOAD_ARRAY_ITEMS)) {
      if (budget.remainingBytes <= 0) break;
      const sanitized = sanitizeTriggerPayloadValue(key, item, depth + 1, budget);
      if (sanitized !== undefined) out.push(sanitized);
    }
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_TRIGGER_PAYLOAD_KEYS);
    for (const [childKey, childValue] of entries) {
      if (budget.remainingBytes <= 0) break;
      const sanitized = sanitizeTriggerPayloadValue(childKey, childValue, depth + 1, budget);
      if (sanitized !== undefined) {
        out[childKey] = sanitized;
      }
    }
    return out;
  }
  return undefined;
}
