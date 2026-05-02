import type { AccountUsage } from '../bus/schemas.js';

/**
 * Logs when the usage endpoint returns a successful payload but no recognized windows.
 * @param data - Raw usage payload returned by the upstream endpoint.
 */
export function logEmptyClaudeUsageWindows(data: Record<string, unknown>): void {
  const responseKeys = Object.keys(data).sort();
  console.warn(
    `[ClaudeCodeSource] usage endpoint returned no known windows; response keys: ${responseKeys.join(', ')}`,
  );
}

/**
 * Extracts optional credit-balance details from a Claude usage payload.
 * @param data - Raw usage payload returned by the upstream endpoint.
 * @returns Normalized credit information, or undefined when not present.
 */
export function parseClaudeUsageCredits(data: Record<string, unknown>): AccountUsage['credits'] {
  const extraUsage = data['extra_usage'] as Record<string, unknown> | null | undefined;
  if (extraUsage == null || typeof extraUsage['is_enabled'] !== 'boolean') return undefined;
  return {
    enabled: extraUsage['is_enabled'],
    balance: typeof extraUsage['balance'] === 'string' ? extraUsage['balance'] : undefined,
    limit: typeof extraUsage['monthly_limit'] === 'string' ? extraUsage['monthly_limit'] : undefined,
    utilization:
      typeof extraUsage['utilization'] === 'number' && Number.isFinite(extraUsage['utilization'])
        ? extraUsage['utilization']
        : undefined,
  };
}

/**
 * Safely extract a usage window from a Claude API response entry.
 * Returns null if required fields are missing or malformed.
 *
 * The Anthropic API documents `resets_at`, while some existing fixtures and
 * callers still provide `resetsAt`; accept both so the parser normalizes the
 * upstream payload without coupling the rest of the account-manager stack to
 * one wire-key spelling.
 * @param raw - The raw API response object for this window.
 * @param id - Window identifier slug.
 * @param label - Human-readable label.
 * @param group - Logical group.
 * @param windowSeconds - Window duration in seconds.
 * @returns A valid UsageWindow, or null if the data is malformed.
 */
export function parseUsageWindow(
  raw: Record<string, unknown>,
  id: string,
  label: string,
  group: string,
  windowSeconds: number,
): AccountUsage['windows'][number] | null {
  const utilization = raw['utilization'];
  const resetsAtRaw = typeof raw['resets_at'] === 'string' ? raw['resets_at'] : raw['resetsAt'];
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null;
  const resetsAt = typeof resetsAtRaw === 'string' ? new Date(resetsAtRaw).getTime() : undefined;
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return null;
  return { id, label, group, utilization, resetsAt, windowSeconds };
}
