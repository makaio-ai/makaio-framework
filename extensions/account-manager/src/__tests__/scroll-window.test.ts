/**
 * Tests for the scroll window pure function.
 *
 * Covers `computeScrollWindow` directly without React rendering — the hook is a
 * thin wrapper that stores the offset in a ref, so the pure function is the
 * correct unit to test.
 */
import { describe, it, expect } from 'vitest';
import { computeScrollWindow } from '../tui/hooks/use-scroll-window.js';
import type { AccountItem, ConfigIssueItem, GroupHeaderItem, MarginItem } from '../tui/layout.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal AccountItem fixture.
 * @param flatIndex - Zero-based selectable-account index.
 * @param height - Terminal lines this row occupies (default 2).
 * @param clientId - Client identifier (default 'c1').
 * @returns A fully-typed AccountItem.
 */
function makeAccountItem(flatIndex: number, height: number = 2, clientId: string = 'c1'): AccountItem {
  return { type: 'account', height, flatIndex, clientId, accountId: `a${flatIndex}` };
}

/**
 * Creates a GroupHeaderItem fixture.
 * @param clientId - Client identifier (default 'c1').
 * @param displayName - Human-readable label (default 'Client').
 * @returns A fully-typed GroupHeaderItem.
 */
function makeGroupHeader(clientId: string = 'c1', displayName: string = 'Client'): GroupHeaderItem {
  return { type: 'group-header', height: 1, clientId, displayName };
}

/**
 * Creates a MarginItem fixture.
 * @returns A fully-typed MarginItem.
 */
function makeMargin(): MarginItem {
  return { type: 'margin', height: 1 };
}

/**
 * Creates a ConfigIssueItem fixture.
 * @param clientId - Client identifier.
 * @returns A fully-typed ConfigIssueItem.
 */
function makeConfigIssue(clientId: string): ConfigIssueItem {
  return { type: 'config-issue', height: 3, clientId };
}

// ---------------------------------------------------------------------------
// Test 1: Everything fits — no scrolling needed
// ---------------------------------------------------------------------------

describe('computeScrollWindow — no scrolling needed', () => {
  it('returns all accounts visible when total height fits in viewport', () => {
    // 3 accounts at height 2 each = 6 total; viewport = 20
    const layout = [makeAccountItem(0), makeAccountItem(1), makeAccountItem(2)];
    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 0,
      availableHeight: 20,
      currentOffset: 0,
    });

    expect(result.scrolling).toBe(false);
    expect(result.newOffset).toBe(0);
    expect(result.hiddenAbove).toBe(0);
    expect(result.hiddenBelow).toBe(0);
    expect(result.visibleFlatIndices).toEqual(new Set([0, 1, 2]));
  });
});

// ---------------------------------------------------------------------------
// Test 2: Overflow, selection at top
// ---------------------------------------------------------------------------

describe('computeScrollWindow — overflow, selection at top', () => {
  it('shows first few accounts when selection is at top, hides some below', () => {
    // 10 accounts at height 2 each + 1 group header = 21 total; viewport = 10
    // effectiveHeight = 10 - 2 = 8; viewport fits 4 accounts (8 lines)
    const layout = [makeGroupHeader('c1'), ...Array.from({ length: 10 }, (_, i) => makeAccountItem(i))];

    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 0,
      availableHeight: 10,
      currentOffset: 0,
    });

    expect(result.scrolling).toBe(true);
    expect(result.hiddenAbove).toBe(0);
    expect(result.hiddenBelow).toBeGreaterThan(0);
    // Account 0 is selected and must be visible
    expect(result.visibleFlatIndices.has(0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Scroll down — selection at last account
// ---------------------------------------------------------------------------

describe('computeScrollWindow — scroll down to last account', () => {
  it('scrolls viewport to bottom when last account is selected', () => {
    // 10 accounts at height 2 each + 1 group header = 21 total; viewport = 10
    const layout = [makeGroupHeader('c1'), ...Array.from({ length: 10 }, (_, i) => makeAccountItem(i))];

    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 9,
      availableHeight: 10,
      currentOffset: 0,
    });

    expect(result.scrolling).toBe(true);
    expect(result.hiddenAbove).toBeGreaterThan(0);
    expect(result.hiddenBelow).toBe(0);
    // Last account (index 9) must be visible
    expect(result.visibleFlatIndices.has(9)).toBe(true);
    // First few accounts must NOT be visible (scrolled past)
    expect(result.visibleFlatIndices.has(0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Scroll up — starting at bottom, move selection to top
// ---------------------------------------------------------------------------

describe('computeScrollWindow — scroll up from bottom offset', () => {
  it('scrolls back to top when selection moves to account 0 from a bottom offset', () => {
    const layout = [makeGroupHeader('c1'), ...Array.from({ length: 10 }, (_, i) => makeAccountItem(i))];

    // Start with offset deep in the list (say 12, near the bottom)
    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 0,
      availableHeight: 10,
      currentOffset: 12,
    });

    expect(result.scrolling).toBe(true);
    // With selection at top, account 0 must be visible
    expect(result.visibleFlatIndices.has(0)).toBe(true);
    // Offset should have adjusted upward (toward 0) to reveal account 0
    expect(result.newOffset).toBeLessThan(12);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Group header revealed when scrolling up to first account in group
// ---------------------------------------------------------------------------

describe('computeScrollWindow — group header revealed on scroll up', () => {
  it('includes group header when scrolling up to the first account of a group', () => {
    // Layout: [header-c1, acc0, margin, header-c2, acc1]
    // heights: 1 + 2 + 1 + 1 + 2 = 7 total; viewport = 5
    // effectiveHeight = 5 - 2 = 3
    // When acc1 (index 1) is selected and we scroll up from a low offset,
    // the header-c2 must be included because acc1 is the first account of its group
    const layout = [
      makeGroupHeader('c1', 'Client 1'),
      makeAccountItem(0, 2, 'c1'),
      makeMargin(),
      makeGroupHeader('c2', 'Client 2'),
      makeAccountItem(1, 2, 'c2'),
    ];

    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 1,
      availableHeight: 5,
      currentOffset: 4, // offset at margin/header-c2 area
    });

    expect(result.scrolling).toBe(true);
    // Account 1 should be visible
    expect(result.visibleFlatIndices.has(1)).toBe(true);
  });

  it('pulls the group header into view when scrolling up to first account of second group', () => {
    // Layout: [header-c1, acc0, margin, header-c2, acc1]
    // When we have acc1 selected but offset would cut off the group header,
    // the algorithm must pull offset up to include the header
    const layout = [
      makeGroupHeader('c1', 'Client 1'),
      makeAccountItem(0, 2, 'c1'),
      makeMargin(),
      makeGroupHeader('c2', 'Client 2'),
      makeAccountItem(1, 2, 'c2'),
    ];

    // If effectiveHeight = 3 and acc1 is at top=4, bottom=6
    // Without group header pull, offset would = 4 (selectedTop)
    // With group header pull, offset should = 3 (header at index 3 in layout, prefixHeight[3]=4... let me recount)
    // prefix: [0, 1, 3, 4, 5, 7]
    // acc1 is layout index 4, top=5, bottom=7
    // effectiveHeight = 5 - 2 = 3
    // If selectedTop(5) < currentOffset(6): scroll up, offset=5
    // Before acc1 (layout[3]) is group-header -> include: offset = prefixHeights[3] = 4
    // prefix[3] = 1+2+1 = 4
    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 1,
      availableHeight: 5,
      currentOffset: 6, // offset past the selected item top, triggering scroll-up
    });

    // The group header for c2 should be visible
    // It's at layout index 3, top=4, bottom=5
    // visible range = [newOffset, newOffset + effectiveHeight) = [4, 7)
    // So items at [4..7) are visible: header-c2 (4..5) and acc1 (5..7) — both fit
    expect(result.visibleFlatIndices.has(1)).toBe(true);
    expect(result.newOffset).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Margin + group header revealed when scrolling up to first account
// ---------------------------------------------------------------------------

describe('computeScrollWindow — margin + group header revealed', () => {
  it('includes both margin and group header when scrolling up to first account of non-first group', () => {
    // Layout: [header-c1, acc0, margin, header-c2, acc1]
    // prefixHeights: [0, 1, 3, 4, 5, 7]
    // When acc1 (layout idx 4) is selected and selectedTop(5) < currentOffset(7):
    //   - scroll up: offset = 5 (selectedTop)
    //   - layout[3] is group-header: offset = prefixHeights[3] = 4
    //   - layout[2] is margin: offset = prefixHeights[2] = 3
    const layout = [
      makeGroupHeader('c1', 'Client 1'),
      makeAccountItem(0, 2, 'c1'),
      makeMargin(),
      makeGroupHeader('c2', 'Client 2'),
      makeAccountItem(1, 2, 'c2'),
    ];

    // With availableHeight = 10, totalHeight = 7, fits entirely -> scrolling=false.
    // Use a height that requires scrolling: 6.
    // effectiveHeight = 6 - 2 = 4
    // totalHeight = 7 > 6 => scrolling needed
    // selectedTop(5) < currentOffset(7): offset=5, then pull header: offset=4, then pull margin: offset=3
    const result2 = computeScrollWindow({
      layout,
      selectedFlatIndex: 1,
      availableHeight: 6,
      currentOffset: 7,
    });

    expect(result2.scrolling).toBe(true);
    // newOffset should be 3 (pulled up to include margin before group header)
    expect(result2.newOffset).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Edge — no accounts, selectedFlatIndex = -1
// ---------------------------------------------------------------------------

describe('computeScrollWindow — no accounts edge case', () => {
  it('returns empty visible sets and no crash for empty layout and selectedFlatIndex=-1', () => {
    const result = computeScrollWindow({
      layout: [],
      selectedFlatIndex: -1,
      availableHeight: 20,
      currentOffset: 0,
    });

    expect(result.scrolling).toBe(false);
    expect(result.visibleFlatIndices.size).toBe(0);
    expect(result.visibleConfigIssueIds.size).toBe(0);
    expect(result.hiddenAbove).toBe(0);
    expect(result.hiddenBelow).toBe(0);
    expect(result.newOffset).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Edge — availableHeight <= 0
// ---------------------------------------------------------------------------

describe('computeScrollWindow — zero or negative availableHeight', () => {
  it('returns empty visible sets for availableHeight = 0', () => {
    const layout = [makeAccountItem(0), makeAccountItem(1)];

    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 0,
      availableHeight: 0,
      currentOffset: 0,
    });

    expect(result.visibleFlatIndices.size).toBe(0);
    expect(result.visibleConfigIssueIds.size).toBe(0);
    expect(result.hiddenAbove).toBe(0);
    expect(result.hiddenBelow).toBe(0);
  });

  it('returns empty visible sets for availableHeight < 0', () => {
    const layout = [makeAccountItem(0)];

    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 0,
      availableHeight: -5,
      currentOffset: 0,
    });

    expect(result.visibleFlatIndices.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 9: Edge — availableHeight = 1 with scrolling needed
// ---------------------------------------------------------------------------

describe('computeScrollWindow — availableHeight=1 with content needing scrolling', () => {
  it('returns empty visible set when effectiveHeight becomes non-positive', () => {
    // totalHeight = 4 > availableHeight = 1, so scrolling needed
    // effectiveHeight = 1 - 2 = -1 <= 0 → return empty
    const layout = [makeAccountItem(0), makeAccountItem(1)];

    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 0,
      availableHeight: 1,
      currentOffset: 0,
    });

    expect(result.visibleFlatIndices.size).toBe(0);
    expect(result.visibleConfigIssueIds.size).toBe(0);
    expect(result.hiddenAbove).toBe(0);
    expect(result.hiddenBelow).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 10: Indicator reservation reduces visible items
// ---------------------------------------------------------------------------

describe('computeScrollWindow — indicator line reservation', () => {
  it('reserves 2 lines for indicators when scrolling, leaving fewer visible items', () => {
    // 6 accounts at height 2 = 12 total; availableHeight = 10
    // Without reservation: 5 accounts would fit (10 / 2)
    // With reservation: effectiveHeight = 8, so 4 accounts fit
    const layout = Array.from({ length: 6 }, (_, i) => makeAccountItem(i));

    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 0,
      availableHeight: 10,
      currentOffset: 0,
    });

    expect(result.scrolling).toBe(true);
    // With effectiveHeight=8, exactly 4 accounts visible (indices 0-3)
    expect(result.visibleFlatIndices.size).toBe(4);
    expect(result.visibleFlatIndices.has(0)).toBe(true);
    expect(result.visibleFlatIndices.has(3)).toBe(true);
    expect(result.visibleFlatIndices.has(4)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 11: Config issue visibility
// ---------------------------------------------------------------------------

describe('computeScrollWindow — config issue in viewport', () => {
  it('includes config issue clientId in visibleConfigIssueIds when in viewport', () => {
    // Layout: [config-issue(c1, h=3), account(0, h=2)]
    // totalHeight = 5; availableHeight = 20 -> no scrolling, all visible
    const layout = [makeConfigIssue('c1'), makeAccountItem(0, 2, 'c2')];

    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 0,
      availableHeight: 20,
      currentOffset: 0,
    });

    expect(result.scrolling).toBe(false);
    expect(result.visibleConfigIssueIds.has('c1')).toBe(true);
    expect(result.visibleFlatIndices.has(0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 12: Config issue hidden (scrolled out of viewport)
// ---------------------------------------------------------------------------

describe('computeScrollWindow — config issue scrolled out of viewport', () => {
  it('excludes config issue when scrolled below viewport', () => {
    // Layout: [config-issue(c1, h=3), acc(0), acc(1), acc(2), acc(3), acc(4)]
    // totalHeight = 3 + 2*5 = 13; availableHeight = 6
    // effectiveHeight = 4; select acc(4) -> viewport scrolls to bottom
    // config issue at [0,3) should be above the viewport
    const layout = [makeConfigIssue('c1'), ...Array.from({ length: 5 }, (_, i) => makeAccountItem(i))];

    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 4,
      availableHeight: 6,
      currentOffset: 0,
    });

    expect(result.scrolling).toBe(true);
    expect(result.visibleConfigIssueIds.has('c1')).toBe(false);
    expect(result.visibleFlatIndices.has(4)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 13: Hidden counts sum correctly (boundary-straddling items)
// ---------------------------------------------------------------------------

describe('computeScrollWindow — hidden counts include boundary-straddling items', () => {
  it('counts boundary-straddling accounts so hidden + visible = total', () => {
    // 5 accounts at height 3 = 15 total; availableHeight = 10
    // effectiveHeight = 10 - 2 = 8; fits 2 accounts (6 lines) with room for header
    const layout = [makeGroupHeader('c1'), ...Array.from({ length: 5 }, (_, i) => makeAccountItem(i, 3))];

    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 4,
      availableHeight: 10,
      currentOffset: 0,
    });

    expect(result.scrolling).toBe(true);
    const totalAccounts = 5;
    const visibleCount = result.visibleFlatIndices.size;
    expect(result.hiddenAbove + visibleCount + result.hiddenBelow).toBe(totalAccounts);
  });
});

// ---------------------------------------------------------------------------
// Test 14: Over-tall item visibility
// ---------------------------------------------------------------------------

describe('computeScrollWindow — over-tall item taller than viewport', () => {
  it('marks an over-tall selected account as visible even when it cannot fully fit', () => {
    // Layout: [acc(0, h=2), acc(1, h=20), acc(2, h=2)]
    // totalHeight = 24; availableHeight = 10; effectiveHeight = 8
    // acc(1) is taller than effectiveHeight (20 > 8) — it can never fully fit.
    // When selected, the scroll-down path sets offset = selectedBottom - effectiveHeight = 22 - 8 = 14,
    // clamped to maxOffset = max(0, 24 - 8) = 16, so offset stays 14.
    // viewportEnd = 14 + 8 = 22.
    // acc(1): itemTop=2, itemBottom=22 → overlaps [14,22) → must be visible.
    const layout = [makeAccountItem(0, 2), makeAccountItem(1, 20), makeAccountItem(2, 2)];

    const result = computeScrollWindow({
      layout,
      selectedFlatIndex: 1,
      availableHeight: 10,
      currentOffset: 0,
    });

    expect(result.scrolling).toBe(true);
    expect(result.visibleFlatIndices.has(1)).toBe(true);
  });
});
