/**
 * Analytics page.
 *
 * Renders a header with range and account selectors, then a
 * {@link WidgetCanvas} scoped to `'account-manager:analytics'`.
 * Provides {@link AnalyticsContext} to all child widgets so they can
 * consume the current filter without prop-drilling.
 * @packageDocumentation
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { WidgetCanvas } from '@makaio/ui-views';
import { useWidgetLayout, useWidgetLayoutActions, useWidgetRegistry } from '@makaio/ui-hooks';
import type { WidgetLayout } from '@makaio/ui-kernel';
import type { PreferenceKey } from '@makaio/services-core/preferences';
import { useAccounts } from '../../data/use-accounts.js';
import { createAccountCacheKey } from '@makaio-community/account-manager/utils';
import { AnalyticsContext, type AnalyticsFilter, type AnalyticsRange } from './analytics-context.js';
import styles from './analytics-page.module.scss';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Custom widget scope used by the analytics page canvas. */
const ANALYTICS_SCOPE = 'account-manager:analytics';

/** Stable preference key for persisting the analytics canvas layout. */
const ANALYTICS_LAYOUT_KEY: PreferenceKey = {
  scope: ANALYTICS_SCOPE,
  surface: 'ui',
};

/** Milliseconds per unit of each named range preset. */
const RANGE_MS: Record<AnalyticsRange, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** Human-readable label for each range. */
const RANGE_LABELS: Record<AnalyticsRange, string> = {
  '24h': '24 h',
  '7d': '7 d',
  '30d': '30 d',
};

const RANGE_ORDER: AnalyticsRange[] = ['24h', '7d', '30d'];
const RANGE_REFRESH_MS = 60_000;

/**
 * Epoch ms time bounds for a range query.
 */
interface RangeBounds {
  /** Start of range (inclusive, epoch ms). */
  from: number;
  /** End of range (inclusive, epoch ms). */
  to: number;
}

/**
 * Compute epoch ms bounds for the selected range.
 * @param range - Named range preset.
 * @returns Time bounds with `from` and `to` in epoch ms.
 */
function computeRange(range: AnalyticsRange): RangeBounds {
  const to = Date.now();
  const from = to - RANGE_MS[range];
  return { from, to };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Analytics page component.
 *
 * Provides the {@link AnalyticsContext} for all descendant widgets and
 * renders:
 * - A header bar with range-selector and account-selector controls.
 * - A {@link WidgetCanvas} for the `'account-manager:analytics'` scope.
 * @returns Analytics page element.
 */
export default function AnalyticsPage(): JSX.Element {
  const [range, setRange] = useState<AnalyticsRange>('7d');
  const [selectedAccountKey, setSelectedAccountKey] = useState<string>('');
  const [rangeClock, setRangeClock] = useState(0);

  const { sources, accountsByClient } = useAccounts();
  const { layout: savedLayout, isLoading, error } = useWidgetLayout(ANALYTICS_LAYOUT_KEY);
  const { saveLayout } = useWidgetLayoutActions();
  const widgets = useWidgetRegistry({ scope: ANALYTICS_SCOPE, includeAny: false });

  // Build a flat list of { clientId, accountId, label } options.
  const accountOptions = useMemo(() => {
    const opts: Array<{ key: string; clientId: string; accountId: string; label: string }> = [];
    for (const source of sources) {
      const accounts = accountsByClient.get(source.clientId) ?? [];
      for (const account of accounts) {
        const key = createAccountCacheKey(source.clientId, account.id);
        opts.push({
          key,
          clientId: source.clientId,
          accountId: account.id,
          label: `${source.clientId} / ${account.label ?? account.id}`,
        });
      }
    }
    return opts;
  }, [sources, accountsByClient]);

  // Default to first account when options become available.
  const resolvedKey =
    selectedAccountKey !== '' && accountOptions.some((o) => o.key === selectedAccountKey)
      ? selectedAccountKey
      : (accountOptions[0]?.key ?? '');

  const selectedOption = accountOptions.find((o) => o.key === resolvedKey);

  useEffect(() => {
    const handle = setInterval(() => {
      setRangeClock((tick) => tick + 1);
    }, RANGE_REFRESH_MS);
    return () => clearInterval(handle);
  }, []);

  const filter: AnalyticsFilter = useMemo(
    () => ({
      clientId: selectedOption?.clientId ?? '',
      accountId: selectedOption?.accountId ?? '',
      ...computeRange(range),
      range,
    }),
    [selectedOption, range, rangeClock],
  );

  /**
   * Persists the analytics canvas layout to user preferences.
   * @param layout - Updated widget layout to persist.
   */
  const handleSaveLayout = useCallback(
    async (layout: WidgetLayout): Promise<void> => {
      await saveLayout(ANALYTICS_LAYOUT_KEY, layout);
    },
    [saveLayout],
  );

  return (
    <AnalyticsContext.Provider value={filter}>
      <div className={styles.page} data-component="AnalyticsPage">
        <header className={styles.header}>
          <span className={styles.headerTitle}>Analytics</span>

          {/* Range selector */}
          <div className={styles.rangeGroup} role="group" aria-label="Time range">
            {RANGE_ORDER.map((r) => (
              <button
                key={r}
                type="button"
                className={`${styles.rangeButton}${r === range ? ` ${styles.rangeButtonActive}` : ''}`}
                onClick={() => setRange(r)}
                aria-pressed={r === range}
              >
                {RANGE_LABELS[r]}
              </button>
            ))}
          </div>

          {/* Account selector */}
          {accountOptions.length > 0 && (
            <>
              <label className={styles.accountSelectLabel} htmlFor="analytics-account-select">
                Account
              </label>
              <select
                id="analytics-account-select"
                className={styles.accountSelect}
                value={resolvedKey}
                onChange={(e) => setSelectedAccountKey(e.target.value)}
              >
                {accountOptions.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </>
          )}
        </header>

        <div className={styles.canvas}>
          <WidgetCanvas
            widgets={widgets}
            savedLayout={savedLayout ?? null}
            isLoading={isLoading}
            error={error}
            onSaveLayout={handleSaveLayout}
          />
        </div>
      </div>
    </AnalyticsContext.Provider>
  );
}
