/**
 * Tests for the TUI layout model.
 *
 * Covers `computeAccountRowHeight` (deterministic height from usage data) and
 * `buildLayout` (flat item array mirroring AccountsPanel render order).
 */
import { describe, it, expect } from 'vitest';
import {
  computeAccountRowHeight,
  buildLayout,
  type LayoutItem,
  type GroupHeaderItem,
  type AccountItem,
  type ConfigIssueItem,
  type MarginItem,
} from '../tui/layout.js';
import type { Account, AccountUsage, SourceInfo } from '../bus/schemas.js';
import { usageKey } from '../tui/usage-keys.js';
import type { UsageMap } from '../tui/usage-keys.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a minimal Account fixture.
 * @param overrides - Partial Account fields to merge.
 * @returns A complete Account object.
 */
function makeAccount(overrides: Partial<Account> & { id: string }): Account {
  return {
    label: undefined,
    linkedClientAccountId: undefined,
    metadata: {},
    active: false,
    detectedAt: 0,
    lastSeenAt: 0,
    ...overrides,
  };
}

/**
 * Build a minimal AccountUsage fixture.
 * @param windowCount - Number of usage windows to include.
 * @returns An AccountUsage object with the given window count.
 */
function makeUsage(windowCount: number): AccountUsage {
  return {
    fetchedAt: Date.now(),
    windows: Array.from({ length: windowCount }, (_, i) => ({
      id: `win-${i}`,
      label: `Window ${i}`,
      utilization: 50,
      resetsAt: Date.now() + 3_600_000,
      windowSeconds: 18000,
    })),
  };
}

/**
 * Build a minimal SourceInfo fixture with no configIssue.
 * @param clientId - The client identifier.
 * @param displayName - Human-readable source name.
 * @returns A SourceInfo with no config issue.
 */
function makeSource(clientId: string, displayName: string): SourceInfo {
  return { clientId, displayName, available: true };
}

/**
 * Build a SourceInfo fixture with a configIssue.
 * @param clientId - The client identifier.
 * @param displayName - Human-readable source name.
 * @returns A SourceInfo with a config issue.
 */
function makeSourceWithIssue(clientId: string, displayName: string): SourceInfo {
  return {
    clientId,
    displayName,
    available: false,
    configIssue: { reason: 'Bad config', action: 'Run fix command' },
  };
}

// ---------------------------------------------------------------------------
// computeAccountRowHeight
// ---------------------------------------------------------------------------

describe('computeAccountRowHeight', () => {
  it('returns 2 when no usage is provided', () => {
    expect(computeAccountRowHeight(undefined)).toBe(2);
  });

  it('returns 3 when usage has 0 windows', () => {
    expect(computeAccountRowHeight(makeUsage(0))).toBe(3);
  });

  it('returns 3 when usage has 1 window', () => {
    expect(computeAccountRowHeight(makeUsage(1))).toBe(3);
  });

  it('returns 5 when usage has 3 windows', () => {
    expect(computeAccountRowHeight(makeUsage(3))).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// buildLayout
// ---------------------------------------------------------------------------

describe('buildLayout', () => {
  it('produces [group-header, account, account] for a single source with two accounts and no usage', () => {
    const source = makeSource('claude', 'Claude Code');
    const accounts = [makeAccount({ id: 'acc1' }), makeAccount({ id: 'acc2' })];
    const layout = buildLayout([source], { claude: accounts }, {});

    expect(layout).toHaveLength(3);

    const [header, acc1, acc2] = layout as [GroupHeaderItem, AccountItem, AccountItem];

    expect(header.type).toBe('group-header');
    expect(header.height).toBe(1);
    expect(header.clientId).toBe('claude');
    expect(header.displayName).toBe('Claude Code');

    expect(acc1.type).toBe('account');
    expect(acc1.height).toBe(2);
    expect(acc1.clientId).toBe('claude');
    expect(acc1.accountId).toBe('acc1');
    expect(acc1.flatIndex).toBe(0);

    expect(acc2.type).toBe('account');
    expect(acc2.height).toBe(2);
    expect(acc2.accountId).toBe('acc2');
    expect(acc2.flatIndex).toBe(1);
  });

  it('inserts a margin item between two normal sources', () => {
    const source1 = makeSource('claude', 'Claude Code');
    const source2 = makeSource('codex', 'OpenAI Codex');
    const acc1 = makeAccount({ id: 'a1' });
    const acc2 = makeAccount({ id: 'a2' });

    const layout = buildLayout([source1, source2], { claude: [acc1], codex: [acc2] }, {});

    expect(layout).toHaveLength(5); // header + acc + margin + header + acc

    const types = layout.map((item) => item.type);
    expect(types).toEqual(['group-header', 'account', 'margin', 'group-header', 'account']);
  });

  it('emits a config-issue item for a source with configIssue', () => {
    const source = makeSourceWithIssue('claude', 'Claude Code');

    const layout = buildLayout([source], {}, {});

    expect(layout).toHaveLength(1);
    const [item] = layout as [ConfigIssueItem];
    expect(item.type).toBe('config-issue');
    expect(item.height).toBe(3);
    expect(item.clientId).toBe('claude');
  });

  it('emits margin + config-issue for a configIssue source after a normal source', () => {
    const source1 = makeSource('codex', 'OpenAI Codex');
    const source2 = makeSourceWithIssue('claude', 'Claude Code');
    const acc = makeAccount({ id: 'a1' });

    const layout = buildLayout([source1, source2], { codex: [acc] }, {});

    // header + account + margin + config-issue
    expect(layout).toHaveLength(4);
    const types = layout.map((item) => item.type);
    expect(types).toEqual(['group-header', 'account', 'margin', 'config-issue']);
  });

  it('emits margin between configIssue and normal sources in mixed order', () => {
    const source1 = makeSourceWithIssue('claude', 'Claude Code');
    const source2 = makeSource('codex', 'OpenAI Codex');
    const acc = makeAccount({ id: 'a1' });

    const layout = buildLayout([source1, source2], { codex: [acc] }, {});

    // config-issue + margin + header + account
    expect(layout).toHaveLength(4);
    const types = layout.map((item) => item.type);
    expect(types).toEqual(['config-issue', 'margin', 'group-header', 'account']);
  });

  it('skips sources with no accounts and no configIssue', () => {
    const source1 = makeSource('empty', 'Empty Source');
    const source2 = makeSource('claude', 'Claude Code');
    const acc = makeAccount({ id: 'a1' });

    const layout = buildLayout([source1, source2], { claude: [acc] }, {});

    // empty source skipped entirely; no margin before claude
    expect(layout).toHaveLength(2);
    const types = layout.map((item) => item.type);
    expect(types).toEqual(['group-header', 'account']);
  });

  it('skips an empty source between two normal sources (no extra margin)', () => {
    const source1 = makeSource('claude', 'Claude Code');
    const source2 = makeSource('empty', 'Empty Source');
    const source3 = makeSource('codex', 'OpenAI Codex');
    const acc1 = makeAccount({ id: 'a1' });
    const acc2 = makeAccount({ id: 'a2' });

    const layout = buildLayout([source1, source2, source3], { claude: [acc1], codex: [acc2] }, {});

    // header + acc + margin + header + acc (empty source in between is skipped)
    expect(layout).toHaveLength(5);
    const types = layout.map((item) => item.type);
    expect(types).toEqual(['group-header', 'account', 'margin', 'group-header', 'account']);
  });

  it('assigns sequential flatIndex values across multiple groups', () => {
    const source1 = makeSource('claude', 'Claude Code');
    const source2 = makeSource('codex', 'OpenAI Codex');
    const accounts1 = [makeAccount({ id: 'a1' }), makeAccount({ id: 'a2' })];
    const accounts2 = [makeAccount({ id: 'b1' }), makeAccount({ id: 'b2' }), makeAccount({ id: 'b3' })];

    const layout = buildLayout([source1, source2], { claude: accounts1, codex: accounts2 }, {});

    const accountItems = layout.filter((item): item is AccountItem => item.type === 'account');
    expect(accountItems.map((i) => i.flatIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('does not assign flatIndex for configIssue sources (they are not selectable)', () => {
    const source1 = makeSourceWithIssue('claude', 'Claude Code');
    const source2 = makeSource('codex', 'OpenAI Codex');
    const source3 = makeSource('gemini', 'Gemini');
    const accounts2 = [makeAccount({ id: 'b1' })];
    const accounts3 = [makeAccount({ id: 'c1' }), makeAccount({ id: 'c2' })];

    const layout = buildLayout([source1, source2, source3], { codex: accounts2, gemini: accounts3 }, {});

    const accountItems = layout.filter((item): item is AccountItem => item.type === 'account');
    expect(accountItems.map((i) => i.flatIndex)).toEqual([0, 1, 2]);
  });

  it('computes account row height from usage data', () => {
    const source = makeSource('claude', 'Claude Code');
    const acc = makeAccount({ id: 'a1' });
    const usage = makeUsage(3);
    const usageByAccount: UsageMap = { [usageKey('claude', 'a1')]: usage };

    const layout = buildLayout([source], { claude: [acc] }, usageByAccount);

    const accountItems = layout.filter((item): item is AccountItem => item.type === 'account');
    expect(accountItems[0]?.height).toBe(5); // 2 + max(3, 1) = 5
  });

  it('uses height 2 for accounts with missing usage key', () => {
    const source = makeSource('claude', 'Claude Code');
    const acc = makeAccount({ id: 'a1' });

    const layout = buildLayout([source], { claude: [acc] }, {});

    const accountItems = layout.filter((item): item is AccountItem => item.type === 'account');
    expect(accountItems[0]?.height).toBe(2);
  });

  it('produces an empty layout when no sources have content', () => {
    const source = makeSource('empty', 'Empty Source');
    const layout = buildLayout([source], {}, {});
    expect(layout).toHaveLength(0);
  });

  it('produces an empty layout when sources array is empty', () => {
    const layout = buildLayout([], {}, {});
    expect(layout).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Margin item shape
// ---------------------------------------------------------------------------

describe('MarginItem shape', () => {
  it('has type "margin" and height 1', () => {
    const source1 = makeSource('claude', 'Claude Code');
    const source2 = makeSource('codex', 'OpenAI Codex');
    const layout = buildLayout(
      [source1, source2],
      { claude: [makeAccount({ id: 'a1' })], codex: [makeAccount({ id: 'b1' })] },
      {},
    );
    const marginItem = layout.find((item): item is MarginItem => item.type === 'margin');
    expect(marginItem).toBeDefined();
    expect(marginItem?.height).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Total height utility (derived from layout)
// ---------------------------------------------------------------------------

describe('layout total height', () => {
  it('sums correctly for a single source with two no-usage accounts', () => {
    const source = makeSource('claude', 'Claude Code');
    const accounts = [makeAccount({ id: 'a1' }), makeAccount({ id: 'a2' })];
    const layout = buildLayout([source], { claude: accounts }, {});
    const total = layout.reduce((sum: number, item: LayoutItem) => sum + item.height, 0);
    // group-header(1) + account(2) + account(2) = 5
    expect(total).toBe(5);
  });

  it('does not include a trailing margin for the last group (no off-by-one)', () => {
    // Two groups: margin appears only between them, not after the last one.
    const source1 = makeSource('claude', 'Claude Code');
    const source2 = makeSource('codex', 'OpenAI Codex');
    const acc1 = makeAccount({ id: 'a1' });
    const acc2 = makeAccount({ id: 'b1' });

    const layout = buildLayout([source1, source2], { claude: [acc1], codex: [acc2] }, {});
    const total = layout.reduce((sum: number, item: LayoutItem) => sum + item.height, 0);

    // group-header(1) + account(2) + margin(1) + group-header(1) + account(2) = 7
    // A trailing margin would incorrectly add 1, giving 8.
    expect(total).toBe(7);
    expect(layout[layout.length - 1]?.type).not.toBe('margin');
  });

  it('does not include a trailing margin after a config-issue group', () => {
    const source = makeSourceWithIssue('claude', 'Claude Code');

    const layout = buildLayout([source], {}, {});
    const total = layout.reduce((sum: number, item: LayoutItem) => sum + item.height, 0);

    // config-issue(3) = 3, no trailing margin
    expect(total).toBe(3);
    expect(layout[layout.length - 1]?.type).not.toBe('margin');
  });

  it('sums correctly for mixed normal and config-issue groups', () => {
    const source1 = makeSource('codex', 'OpenAI Codex');
    const source2 = makeSourceWithIssue('claude', 'Claude Code');
    const acc = makeAccount({ id: 'a1' });

    const layout = buildLayout([source1, source2], { codex: [acc] }, {});
    const total = layout.reduce((sum: number, item: LayoutItem) => sum + item.height, 0);

    // group-header(1) + account(2) + margin(1) + config-issue(3) = 7
    expect(total).toBe(7);
    expect(layout[layout.length - 1]?.type).not.toBe('margin');
  });
});
