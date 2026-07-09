import { describe, expect, it } from 'vitest';
import {
  normalizeClaudeCodeSessionUsage,
  normalizeClaudeCodeStatusline,
  type StatuslineIdentityContext,
} from '../statusline-normalizer.js';
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
    it('maps five_hour window to key=5h and converts resets_at seconds to milliseconds', () => {
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
        key: '5h',
        label: '5 Hour',
        usedPercentage: 42,
        resetsAt: 1_738_425_600_000,
      });
    });

    it('maps seven_day window to key=7d', () => {
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
        key: '7d',
        label: '7 Day',
        usedPercentage: 15,
        resetsAt: 1_738_857_600_000,
      });
    });

    it('maps seven_day_sonnet passthrough window to key=7d-sonnet', () => {
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
        key: '7d-sonnet',
        label: 'Sonnet (7 Day)',
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
      expect(result!.usage.windows.map((w) => w.key)).toEqual(['5h', '7d', '7d-sonnet']);
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
      expect(result!.usage.windows[0]).toMatchObject({ key: '7d' });
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
      expect(result!.usage.windows[0]).toMatchObject({ key: '5h', usedPercentage: 55 });
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

describe('normalizeClaudeCodeSessionUsage', () => {
  it('preserves current-request, current-context, and cumulative measurements with explicit semantics', () => {
    const result = normalizeClaudeCodeSessionUsage(
      makeRawStatusline({
        version: '2.1.132',
        context_window: {
          total_input_tokens: 80_000,
          total_output_tokens: 4_000,
          context_window_size: 200_000,
          used_percentage: 42,
          remaining_percentage: 58,
          current_usage: {
            input_tokens: 120,
            output_tokens: 45,
            cache_read_input_tokens: 2_400,
            cache_creation_input_tokens: 80,
          },
        },
        exceeds_200k_tokens: false,
        cost: {
          total_cost_usd: 12.68,
          total_duration_ms: 3_933_000,
          total_api_duration_ms: 348_000,
          total_lines_added: 82,
          total_lines_removed: 1,
          total_edits: 12,
        },
      }),
      'client-account-1',
      'framework-session-1',
    );

    expect(result).toMatchObject({
      clientId: 'claude-code',
      clientAccountId: 'client-account-1',
      sessionId: 'framework-session-1',
      adapterSessionId: 'sess-sl-001',
      source: 'statusline',
      clientVersion: '2.1.132',
      modelId: 'claude-opus-4-5',
      modelDisplayName: 'Claude Opus 4.5',
      modelFamily: 'claude',
      latestRequestInputTokens: 120,
      latestRequestOutputTokens: 45,
      latestRequestCacheReadTokens: 2_400,
      latestRequestCacheWriteTokens: 80,
      currentContextInputTokens: 80_000,
      currentContextOutputTokens: 4_000,
      contextWindowSizeTokens: 200_000,
      contextUsedPercentage: 42,
      contextRemainingPercentage: 58,
      contextThresholdExceeded: false,
      totalCost: 12.68,
      costCurrency: 'USD',
      costProvenance: 'client-reported',
      totalDurationMs: 3_933_000,
      totalApiDurationMs: 348_000,
      totalLinesAdded: 82,
      totalLinesRemoved: 1,
      totalEdits: 12,
    });
    expect(result).not.toHaveProperty('cwd');
    expect(result).not.toHaveProperty('transcriptPath');
    expect(result).not.toHaveProperty('rateLimits');
  });

  it('emits anonymous session usage when no account identity is available', () => {
    const result = normalizeClaudeCodeSessionUsage(
      makeRawStatusline({ context_window: { current_usage: { input_tokens: 10 } } }),
    );

    expect(result).toMatchObject({
      clientId: 'claude-code',
      adapterSessionId: 'sess-sl-001',
      latestRequestInputTokens: 10,
    });
    expect(result?.clientAccountId).toBeUndefined();
  });

  it('keeps quota windows out of session usage snapshots', () => {
    const result = normalizeClaudeCodeSessionUsage(
      makeRawStatusline({
        rate_limits: { five_hour: { used_percentage: 50, resets_at: 1_738_425_600 } },
        cost: { total_cost_usd: 1.25 },
      }),
    );

    expect(result?.totalCost).toBe(1.25);
    expect(result).not.toHaveProperty('usage');
    expect(result).not.toHaveProperty('windows');
  });

  it('returns null without a session ID or supported usage measurements', () => {
    expect(normalizeClaudeCodeSessionUsage({ cost: { total_cost_usd: 1 } })).toBeNull();
    expect(normalizeClaudeCodeSessionUsage(makeRawStatusline())).toBeNull();
  });

  it('does not treat a false context-threshold flag as a usage measurement by itself', () => {
    expect(normalizeClaudeCodeSessionUsage({ session_id: 'session-1', exceeds_200k_tokens: false })).toBeNull();
    expect(normalizeClaudeCodeSessionUsage({ session_id: 'session-1', exceeds_200k_tokens: true })).toMatchObject({
      contextThresholdExceeded: true,
    });
  });

  it('drops invalid optional measurements without turning them into zero', () => {
    const result = normalizeClaudeCodeSessionUsage(
      makeRawStatusline({
        cost: { total_cost_usd: -1, total_duration_ms: Number.POSITIVE_INFINITY },
        context_window: { used_percentage: 120, current_usage: { input_tokens: 5 } },
      }),
    );

    expect(result?.latestRequestInputTokens).toBe(5);
    expect(result?.totalCost).toBeUndefined();
    expect(result?.totalDurationMs).toBeUndefined();
    expect(result?.contextUsedPercentage).toBeUndefined();
  });
});
