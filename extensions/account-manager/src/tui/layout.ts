/**
 * Pure layout model for the account-manager TUI.
 *
 * Maps the visual structure of the account list into a flat array of
 * {@link LayoutItem} values so that a scroll hook can determine which items
 * fit inside the current viewport without touching React state.
 *
 * The item order and height rules mirror the `AccountsPanel` render tree:
 * - A {@link MarginItem} (height 1) is inserted before the second and
 * subsequent visible groups, matching the explicit spacer element rendered by
 * `AccountsPanel` between groups.
 * - Each `AccountRow` is always at least 2 lines (label row + "Last updated"
 * row) and gains one extra line per usage window (or one "No usage windows"
 * line when the usage snapshot is empty).
 * - A `configIssue` source renders as a 3-line banner instead of a group.
 * @packageDocumentation
 */

import type { Account, AccountUsage, SourceInfo } from '../bus/schemas.js';
import { usageKey, type UsageMap } from './usage-keys.js';

// ---------------------------------------------------------------------------
// Layout item types
// ---------------------------------------------------------------------------

/** A client group heading line. */
export interface GroupHeaderItem {
  readonly type: 'group-header';
  readonly height: 1;
  readonly clientId: string;
  readonly displayName: string;
}

/** A single account row (variable height). */
export interface AccountItem {
  readonly type: 'account';
  readonly height: number;
  /** Zero-based index into the flat selectable-accounts array in `app.tsx`. */
  readonly flatIndex: number;
  readonly clientId: string;
  readonly accountId: string;
}

/** A config-issue banner (name + reason + action = 3 lines). */
export interface ConfigIssueItem {
  readonly type: 'config-issue';
  readonly height: 3;
  readonly clientId: string;
}

/** Vertical margin between groups, rendered as a blank line in `AccountsPanel`. */
export interface MarginItem {
  readonly type: 'margin';
  readonly height: 1;
}

/** Discriminated union of all items that can appear in the layout array. */
export type LayoutItem = GroupHeaderItem | AccountItem | ConfigIssueItem | MarginItem;

// ---------------------------------------------------------------------------
// computeAccountRowHeight
// ---------------------------------------------------------------------------

/**
 * Computes the terminal line height of a single `AccountRow` from its usage
 * snapshot.
 *
 * Heights are fully deterministic from the usage data so the scroll hook can
 * recalculate without touching the React render tree:
 * - Base: 2 lines (label row + "Last updated" row).
 * - No usage: return 2.
 * - Usage with 0 windows: return 3 ("No usage windows reported" line).
 * - Usage with N windows: return 2 + N (one `UsageGauge` per window).
 * @param usage - The account's usage snapshot, or `undefined` if not yet loaded.
 * @returns The number of terminal lines this row will occupy.
 */
export function computeAccountRowHeight(usage?: AccountUsage): number {
  if (!usage) return 2;
  return 2 + Math.max(usage.windows.length, 1);
}

// ---------------------------------------------------------------------------
// buildLayout
// ---------------------------------------------------------------------------

/**
 * Builds a flat array of {@link LayoutItem} values that mirrors the visual
 * structure `AccountsPanel` produces.
 *
 * Iteration order follows `sources` exactly (same order as `AccountsPanel`
 * renders). Sources that have neither accounts nor a `configIssue` are skipped
 * entirely so they produce neither items nor margin separators.
 *
 * The `flatIndex` assigned to each {@link AccountItem} matches the index of
 * that account in the `flatAccounts` array computed by `app.tsx`
 * (accounts from `configIssue` sources are not selectable and therefore do
 * not consume flatIndex slots).
 * @param sources - Ordered list of credential sources, as returned by
 *   `accounts.getSources`.
 * @param accountsByClient - Accounts grouped by client ID.
 * @param usageByAccount - Current usage snapshots keyed by {@link usageKey}.
 * @returns Flat ordered array of layout items representing the full visual
 *   structure of the account list.
 */
export function buildLayout(
  sources: SourceInfo[],
  accountsByClient: Record<string, Account[]>,
  usageByAccount: UsageMap,
): LayoutItem[] {
  const items: LayoutItem[] = [];
  let isFirstGroup = true;
  let flatIndex = 0;

  for (const source of sources) {
    if (source.configIssue) {
      if (!isFirstGroup) {
        items.push({ type: 'margin', height: 1 });
      }
      items.push({ type: 'config-issue', height: 3, clientId: source.clientId });
      isFirstGroup = false;
      continue;
    }

    const accounts = accountsByClient[source.clientId] ?? [];
    if (accounts.length === 0) {
      // Empty source — skip entirely, no margin emitted.
      continue;
    }

    if (!isFirstGroup) {
      items.push({ type: 'margin', height: 1 });
    }

    items.push({
      type: 'group-header',
      height: 1,
      clientId: source.clientId,
      displayName: source.displayName,
    });

    for (const account of accounts) {
      const key = usageKey(source.clientId, account.id);
      const usage = usageByAccount[key];
      items.push({
        type: 'account',
        height: computeAccountRowHeight(usage),
        flatIndex,
        clientId: source.clientId,
        accountId: account.id,
      });
      flatIndex += 1;
    }

    isFirstGroup = false;
  }

  return items;
}
