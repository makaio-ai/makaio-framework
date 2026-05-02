import { describe, expect, it } from 'vitest';
import { normalizeClaudeCodeStatusline, type StatuslineIdentityContext } from '../statusline-normalizer.js';
import type { ClaudeCodeStatuslineRawPayload } from '../../schemas/statusline.js';

/**
 * Build a minimal raw statusline payload for test scenarios.
 * @param overrides - Optional field overrides
 * @returns Well-formed raw statusline payload
 */
function makeRawStatusline(overrides: Partial<ClaudeCodeStatuslineRawPayload> = {}): ClaudeCodeStatuslineRawPayload {
  return {
    session_id: 'sess-sl-001',
    model: { id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5', family: 'claude' },
    ...overrides,
  };
}

/**
 * Build a minimal identity context for test scenarios.
 * @param overrides - Optional field overrides
 * @returns Well-formed identity context
 */
function makeIdentity(overrides: Partial<StatuslineIdentityContext> = {}): StatuslineIdentityContext {
  return {
    clientAccountId: 'client-account-1',
    identifiers: [
      {
        scheme: 'account-org-uuid',
        value: 'acct-uuid-001:org-uuid-001',
        strength: 'strong',
      },
    ],
    ...overrides,
  };
}

describe('normalizeClaudeCodeStatusline', () => {
  describe('identity gate — returns null when no identity provided or identity is empty', () => {
    it('returns null when identity has no identifiers', () => {
      const result = normalizeClaudeCodeStatusline(
        makeRawStatusline({
          rate_limits: {
            five_hour: { used_percentage: 42, resets_at: 1_738_425_600 },
          },
        }),
        { clientAccountId: 'client-account-1', identifiers: [] },
      );

      expect(result).toBeNull();
    });

    it('returns null when there are no rate_limits windows', () => {
      const result = normalizeClaudeCodeStatusline(makeRawStatusline(), makeIdentity());

      expect(result).toBeNull();
    });

    it('returns null when rate_limits is absent entirely', () => {
      const result = normalizeClaudeCodeStatusline(makeRawStatusline({ rate_limits: undefined }), makeIdentity());

      expect(result).toBeNull();
    });

    it('returns null when all rate_limit windows lack used_percentage', () => {
      const result = normalizeClaudeCodeStatusline(
        makeRawStatusline({
          rate_limits: {
            five_hour: { resets_at: 1_738_425_600 },
            seven_day: { resets_at: 1_738_857_600 },
          },
        }),
        makeIdentity(),
      );

      expect(result).toBeNull();
    });

    it('returns null for an empty payload (early-session state)', () => {
      const result = normalizeClaudeCodeStatusline({}, makeIdentity());

      expect(result).toBeNull();
    });
  });

  describe('rate_limits → usage windows conversion', () => {
    it('maps five_hour window to key=five-hour and converts resets_at seconds to milliseconds', () => {
      const result = normalizeClaudeCodeStatusline(
        makeRawStatusline({
          rate_limits: {
            five_hour: { used_percentage: 42, resets_at: 1_738_425_600 },
          },
        }),
        makeIdentity(),
      );

      expect(result).not.toBeNull();
      expect(result!.usage.windows).toHaveLength(1);
      expect(result!.usage.windows[0]).toMatchObject({
        key: 'five-hour',
        label: '5 Hour',
        usedPercentage: 42,
        resetsAt: 1_738_425_600_000,
      });
    });

    it('maps seven_day window to key=seven-day', () => {
      const result = normalizeClaudeCodeStatusline(
        makeRawStatusline({
          rate_limits: {
            seven_day: { used_percentage: 15, resets_at: 1_738_857_600 },
          },
        }),
        makeIdentity(),
      );

      expect(result).not.toBeNull();
      expect(result!.usage.windows).toHaveLength(1);
      expect(result!.usage.windows[0]).toMatchObject({
        key: 'seven-day',
        label: '7 Day',
        usedPercentage: 15,
        resetsAt: 1_738_857_600_000,
      });
    });

    it('maps seven_day_sonnet passthrough window to key=seven-day-sonnet', () => {
      const result = normalizeClaudeCodeStatusline(
        makeRawStatusline({
          rate_limits: {
            seven_day_sonnet: { used_percentage: 8, resets_at: 1_739_000_000 },
          },
        }),
        makeIdentity(),
      );

      expect(result).not.toBeNull();
      expect(result!.usage.windows).toHaveLength(1);
      expect(result!.usage.windows[0]).toMatchObject({
        key: 'seven-day-sonnet',
        label: '7 Day Sonnet',
        usedPercentage: 8,
        resetsAt: 1_739_000_000_000,
      });
    });

    it('includes all three windows when all are present', () => {
      const result = normalizeClaudeCodeStatusline(
        makeRawStatusline({
          rate_limits: {
            five_hour: { used_percentage: 23.5, resets_at: 1_738_425_600 },
            seven_day: { used_percentage: 41.2, resets_at: 1_738_857_600 },
            seven_day_sonnet: { used_percentage: 12, resets_at: 1_739_000_000 },
          },
        }),
        makeIdentity(),
      );

      expect(result).not.toBeNull();
      expect(result!.usage.windows).toHaveLength(3);
      expect(result!.usage.windows.map((w) => w.key)).toEqual(['five-hour', 'seven-day', 'seven-day-sonnet']);
    });

    it('omits a window when used_percentage is absent', () => {
      const result = normalizeClaudeCodeStatusline(
        makeRawStatusline({
          rate_limits: {
            five_hour: { resets_at: 1_738_425_600 },
            seven_day: { used_percentage: 10, resets_at: 1_738_857_600 },
          },
        }),
        makeIdentity(),
      );

      expect(result).not.toBeNull();
      expect(result!.usage.windows).toHaveLength(1);
      expect(result!.usage.windows[0]).toMatchObject({ key: 'seven-day' });
    });

    it('sets resetsAt to undefined when resets_at is absent', () => {
      const result = normalizeClaudeCodeStatusline(
        makeRawStatusline({
          rate_limits: {
            five_hour: { used_percentage: 55 },
          },
        }),
        makeIdentity(),
      );

      expect(result).not.toBeNull();
      expect(result!.usage.windows[0]).toMatchObject({ key: 'five-hour', usedPercentage: 55 });
      expect(result!.usage.windows[0]!.resetsAt).toBeUndefined();
    });
  });

  describe('normalized payload shape', () => {
    it('sets clientId to claude-code and source to statusline', () => {
      const result = normalizeClaudeCodeStatusline(
        makeRawStatusline({
          rate_limits: { five_hour: { used_percentage: 10, resets_at: 1_738_425_600 } },
        }),
        makeIdentity(),
      );

      expect(result).not.toBeNull();
      expect(result!.clientId).toBe('claude-code');
      expect(result!.source).toBe('statusline');
    });

    it('carries identity identifiers from the context into the account field', () => {
      const identifiers = [{ scheme: 'account-org-uuid', value: 'acct:org', strength: 'strong' as const }];
      const result = normalizeClaudeCodeStatusline(
        makeRawStatusline({
          rate_limits: { five_hour: { used_percentage: 10, resets_at: 1_738_425_600 } },
        }),
        makeIdentity({ identifiers }),
      );

      expect(result).not.toBeNull();
      expect(result!.account.identifiers).toEqual(identifiers);
    });

    it('carries displayLabel from identity context into the account field', () => {
      const result = normalizeClaudeCodeStatusline(
        makeRawStatusline({
          rate_limits: { five_hour: { used_percentage: 10, resets_at: 1_738_425_600 } },
        }),
        makeIdentity({ displayLabel: 'Chris' }),
      );

      expect(result).not.toBeNull();
      expect(result!.account.displayLabel).toBe('Chris');
    });

    it('puts session_id into metadata.sessionId when present', () => {
      const result = normalizeClaudeCodeStatusline(
        makeRawStatusline({
          session_id: 'sess-meta-001',
          rate_limits: { five_hour: { used_percentage: 10, resets_at: 1_738_425_600 } },
        }),
        makeIdentity(),
      );

      expect(result).not.toBeNull();
      expect(result!.metadata).toMatchObject({ sessionId: 'sess-meta-001' });
    });

    it('omits metadata entirely when no metadata-eligible fields are present', () => {
      const result = normalizeClaudeCodeStatusline(
        {
          rate_limits: { five_hour: { used_percentage: 10, resets_at: 1_738_425_600 } },
        },
        makeIdentity(),
      );

      expect(result).not.toBeNull();
      expect(result!.metadata).toBeUndefined();
    });

    it('observedAt is a positive integer', () => {
      const before = Date.now();
      const result = normalizeClaudeCodeStatusline(
        makeRawStatusline({
          rate_limits: { five_hour: { used_percentage: 10, resets_at: 1_738_425_600 } },
        }),
        makeIdentity(),
      );
      const after = Date.now();

      expect(result).not.toBeNull();
      expect(result!.observedAt).toBeGreaterThanOrEqual(before);
      expect(result!.observedAt).toBeLessThanOrEqual(after);
    });
  });
});
