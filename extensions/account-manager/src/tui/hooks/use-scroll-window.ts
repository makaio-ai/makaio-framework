/**
 * Scroll window computation for the account-manager TUI.
 *
 * Provides a pure {@link computeScrollWindow} function (easily unit-tested)
 * and a thin {@link useScrollWindow} React hook that stores the current scroll
 * offset in a ref.
 *
 * The algorithm maps a flat {@link LayoutItem} array + a selected flat-account
 * index + an available terminal height into the set of indices that should be
 * rendered, plus counts of accounts hidden above and below the viewport.
 * @packageDocumentation
 */

import { useRef } from 'react';
import type { LayoutItem } from '../layout.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Inputs that describe the current state of the scrollable area, without the
 * current scroll offset (used by the hook wrapper).
 */
export interface ScrollWindowInput {
  /** Flat layout items produced by {@link buildLayout}. */
  readonly layout: readonly LayoutItem[];
  /** Currently selected index into the flat selectable-accounts array. */
  readonly selectedFlatIndex: number;
  /** Terminal lines available for the scrollable content area. */
  readonly availableHeight: number;
}

/**
 * The subset of scroll-window output that callers of the hook receive.
 * The offset is managed internally by the hook.
 */
export interface ScrollWindowResult {
  /** Flat-account indices that should be rendered in the current viewport. */
  readonly visibleFlatIndices: ReadonlySet<number>;
  /** Config-issue client IDs whose banners fall inside the current viewport. */
  readonly visibleConfigIssueIds: ReadonlySet<string>;
  /** Number of selectable accounts hidden above the viewport. */
  readonly hiddenAbove: number;
  /** Number of selectable accounts hidden below the viewport. */
  readonly hiddenBelow: number;
  /** Whether the total content height exceeds the available height. */
  readonly scrolling: boolean;
}

/**
 * Extended input for the pure function — includes the current scroll offset so
 * the function can decide whether to keep or adjust it.
 */
export interface ComputeScrollWindowInput extends ScrollWindowInput {
  /** Current scroll offset (number of lines scrolled past the top). */
  readonly currentOffset: number;
}

/**
 * Extended output from the pure function — includes the (possibly updated)
 * offset so the hook can persist it.
 */
export interface ComputeScrollWindowOutput extends ScrollWindowResult {
  /** The scroll offset to use for the next render. */
  readonly newOffset: number;
}

// ---------------------------------------------------------------------------
// Empty result helpers
// ---------------------------------------------------------------------------

/**
 * Builds an empty {@link ComputeScrollWindowOutput} for degenerate inputs
 * (no content or viewport too small to display anything).
 * @param scrolling - Whether the content nominally requires scrolling (true
 *   when `totalHeight > availableHeight` even though nothing is displayed).
 * @param newOffset - The offset to persist; usually `0` for degenerate cases.
 * @returns A {@link ComputeScrollWindowOutput} with empty visible sets and
 *   zero hidden counts.
 */
function emptyResult(scrolling: boolean, newOffset: number): ComputeScrollWindowOutput {
  return {
    visibleFlatIndices: new Set(),
    visibleConfigIssueIds: new Set(),
    hiddenAbove: 0,
    hiddenBelow: 0,
    scrolling,
    newOffset,
  };
}

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

/**
 * Computes the set of layout items visible within the scrollable viewport.
 *
 * This is a pure function with no side effects — it derives the new scroll
 * offset entirely from its inputs, making it straightforward to unit-test
 * without a React environment.
 *
 * ### Algorithm outline
 * 1. Build prefix-sum heights over `layout`.
 * 2. If `totalHeight <= availableHeight`, return everything visible, no
 *    scrolling.
 * 3. Reserve 2 indicator lines (`effectiveHeight = availableHeight - 2`).
 *    If `effectiveHeight <= 0`, return empty.
 * 4. Find selected account in layout; if absent, keep `currentOffset`.
 * 5. Adjust offset to keep selection visible, pulling group-header (and
 *    preceding margin) into view when scrolling upward.
 * 6. Clamp offset to valid range.
 * 7. Collect visible flat-account indices and config-issue client IDs.
 * 8. Count accounts hidden above / below.
 * @param input - Scroll window inputs including the current offset.
 * @returns The updated scroll window output including `newOffset`.
 */
export function computeScrollWindow(input: ComputeScrollWindowInput): ComputeScrollWindowOutput {
  const { layout, selectedFlatIndex, availableHeight, currentOffset } = input;

  if (availableHeight <= 0) {
    return emptyResult(false, 0);
  }

  // Step 1: Build prefix-sum heights.
  const prefixHeights = new Array<number>(layout.length + 1);
  prefixHeights[0] = 0;
  for (let i = 0; i < layout.length; i++) {
    prefixHeights[i + 1] = prefixHeights[i] + layout[i].height;
  }
  const totalHeight = prefixHeights[layout.length];

  // Step 2: No scrolling needed — everything fits.
  if (totalHeight <= availableHeight) {
    const visibleFlatIndices = new Set<number>();
    const visibleConfigIssueIds = new Set<string>();
    for (const item of layout) {
      if (item.type === 'account') {
        visibleFlatIndices.add(item.flatIndex);
      } else if (item.type === 'config-issue') {
        visibleConfigIssueIds.add(item.clientId);
      }
    }
    return {
      visibleFlatIndices,
      visibleConfigIssueIds,
      hiddenAbove: 0,
      hiddenBelow: 0,
      scrolling: false,
      newOffset: 0,
    };
  }

  // Step 3: Reserve indicator lines.
  const effectiveHeight = availableHeight - 2;
  if (effectiveHeight <= 0) {
    return emptyResult(true, 0);
  }

  // Step 4: Find selected account in layout.
  let selectedLayoutIndex = -1;
  for (let i = 0; i < layout.length; i++) {
    const item = layout[i];
    if (item.type === 'account' && item.flatIndex === selectedFlatIndex) {
      selectedLayoutIndex = i;
      break;
    }
  }

  let offset = currentOffset;

  // Step 5: Adjust offset to keep selection visible.
  if (selectedLayoutIndex !== -1) {
    const selectedTop = prefixHeights[selectedLayoutIndex];
    const selectedBottom = prefixHeights[selectedLayoutIndex + 1];

    if (selectedTop < offset) {
      // Scroll up: move offset up to show selected item at top.
      offset = selectedTop;

      // Pull in group-header immediately before the selected account, but only
      // if the selected account still fits within the viewport at the new offset.
      const prevIdx = selectedLayoutIndex - 1;
      if (prevIdx >= 0 && layout[prevIdx].type === 'group-header') {
        const headerOffset = prefixHeights[prevIdx];
        if (selectedBottom <= headerOffset + effectiveHeight) {
          offset = headerOffset;

          // Pull in margin before the group-header, again only if the selected
          // account still fits at the further-pulled offset.
          const prevPrevIdx = prevIdx - 1;
          if (prevPrevIdx >= 0 && layout[prevPrevIdx].type === 'margin') {
            const marginOffset = prefixHeights[prevPrevIdx];
            if (selectedBottom <= marginOffset + effectiveHeight) {
              offset = marginOffset;
            }
          }
        }
      }
    } else if (selectedBottom > offset + effectiveHeight) {
      // Scroll down: move offset so selected item's bottom aligns with viewport bottom.
      offset = selectedBottom - effectiveHeight;
    }
  }

  // Step 6: Clamp offset.
  const maxOffset = Math.max(0, totalHeight - effectiveHeight);
  offset = Math.max(0, Math.min(offset, maxOffset));

  // Step 7: Collect visible items.
  const visibleFlatIndices = new Set<number>();
  const visibleConfigIssueIds = new Set<string>();
  const viewportEnd = offset + effectiveHeight;

  for (let i = 0; i < layout.length; i++) {
    const itemTop = prefixHeights[i];
    const itemBottom = prefixHeights[i + 1];
    const item = layout[i];

    if (itemTop < viewportEnd && itemBottom > offset) {
      if (item.type === 'account') {
        visibleFlatIndices.add(item.flatIndex);
      } else if (item.type === 'config-issue') {
        visibleConfigIssueIds.add(item.clientId);
      }
    }
  }

  // Step 8: Count hidden accounts — any account not in the visible set is
  // hidden. Accounts whose midpoint is above the viewport center go to
  // hiddenAbove; the rest go to hiddenBelow. This guarantees
  // hiddenAbove + visibleCount + hiddenBelow === totalAccountCount.
  let hiddenAbove = 0;
  let hiddenBelow = 0;
  const viewportMid = offset + effectiveHeight / 2;
  for (let i = 0; i < layout.length; i++) {
    const item = layout[i];
    if (item.type !== 'account') continue;
    if (visibleFlatIndices.has(item.flatIndex)) continue;

    const itemMid = (prefixHeights[i] + prefixHeights[i + 1]) / 2;
    if (itemMid < viewportMid) {
      hiddenAbove += 1;
    } else {
      hiddenBelow += 1;
    }
  }

  return {
    visibleFlatIndices,
    visibleConfigIssueIds,
    hiddenAbove,
    hiddenBelow,
    scrolling: true,
    newOffset: offset,
  };
}

// ---------------------------------------------------------------------------
// React hook wrapper
// ---------------------------------------------------------------------------

/**
 * Thin React hook wrapper around {@link computeScrollWindow}.
 *
 * Stores the current scroll offset in a ref so that offset mutations do not
 * trigger re-renders — the component re-renders only when its inputs (layout,
 * selectedFlatIndex, availableHeight) change, which in turn may update the
 * offset automatically via the pure function.
 * @param input - Scroll window inputs (layout, selectedFlatIndex,
 *   availableHeight).
 * @returns The computed scroll window result (without the raw offset).
 */
export function useScrollWindow(input: ScrollWindowInput): ScrollWindowResult {
  const offsetRef = useRef(0);
  const result = computeScrollWindow({ ...input, currentOffset: offsetRef.current });
  offsetRef.current = result.newOffset;
  return result;
}
