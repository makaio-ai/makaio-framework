/**
 * Dashboard usage widget.
 *
 * KPI tile overview for the `'global'` (dashboard) scope. Displays:
 * - Active-now: count of active accounts across all providers.
 * - Peak-7d: highest utilization observed across all active accounts and all
 *   usage windows (approximated from the current snapshot — see note below).
 * - Switch count: number of `credentials.switched` events observed since this
 *   widget mounted. There is no server-side switch counter; this is a
 *   client-side session counter derived from bus event subscription.
 *
 * Below the KPI tiles, a headroom bar per active account shows the primary
 * usage window utilization via {@link UsageGauge}.
 *
 * **Switch-count note:** The counter is intentionally mount-local and derived
 * from `credentials.switched` bus events during the current session. It
 * resets on unmount and reflects the lifetime of the current browser session
 * only.
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useOptionalBus } from '@makaio/ui-hooks';
import { eraseWidgetConfig } from '@makaio/ui-kernel';
import { AccountManagerSubjects } from '@makaio/extension-account-manager/register';
import type { Account, AccountUsage } from '@makaio/extension-account-manager/schemas';
import type { WidgetDefinition, WidgetProps } from '@makaio/ui-kernel';
import { useAccounts } from '../../data/use-accounts.js';
import { useUsageData } from '../../data/use-usage-data.js';
import { createAccountCacheKey } from '@makaio/extension-account-manager/utils';
import { UsageGauge } from '../../components/usage-gauge/usage-gauge.js';
import styles from './dashboard-usage-widget.module.scss';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derives the peak utilization percentage from an account's usage snapshot.
 *
 * Returns the maximum `utilization` across all windows, normalised to 0–1.
 * @param usage - Account usage snapshot to inspect.
 * @returns Peak utilization in the range 0–1, or 0 if no windows are present.
 */
function peakUtilization(usage: AccountUsage): number {
  if (usage.windows.length === 0) return 0;
  const max = Math.max(...usage.windows.map((w) => w.utilization));
  return max / 100;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Props for {@link KpiTile}.
 */
interface KpiTileProps {
  /** Short title for the KPI. */
  title: string;
  /** Display value. */
  value: string | number;
  /** Optional sub-label rendered below the value. */
  sub?: string;
}

/**
 * Renders a single KPI metric tile.
 * @param props - Tile configuration.
 * @returns KPI tile element.
 */
function KpiTile({ title, value, sub }: KpiTileProps): JSX.Element {
  return (
    <div className={styles.kpiTile}>
      <span className={styles.kpiTitle}>{title}</span>
      <span className={styles.kpiValue}>{value}</span>
      {sub !== undefined && <span className={styles.kpiSub}>{sub}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account headroom row
// ---------------------------------------------------------------------------

/**
 * Props for {@link AccountHeadroomRow}.
 */
interface AccountHeadroomRowProps {
  /** Account to show headroom for. */
  account: Account;
  /** Credential-source identifier. */
  clientId: string;
  /** Callback to pass this account's usage state up for overall KPI computation. */
  onUsageStateReported: (accountKey: string, usageState: { loading: boolean; utilization: number | null }) => void;
}

/**
 * Renders the primary usage gauge for one active account.
 *
 * Calls {@link AccountHeadroomRowProps.onUsageStateReported} with this
 * account's usage state so the parent can compute the peak-7d KPI.
 * @param props - Account headroom row configuration.
 * @returns Account usage gauge row.
 */
function AccountHeadroomRow({ account, clientId, onUsageStateReported }: AccountHeadroomRowProps): JSX.Element {
  const { data: usage, loading } = useUsageData({ clientId, accountId: account.id });

  // Compose a stable provider-scoped cache key for this account.
  const accountKey = createAccountCacheKey(clientId, account.id);

  useEffect(() => {
    if (loading) {
      onUsageStateReported(accountKey, { loading: true, utilization: null });
      return () => {
        onUsageStateReported(accountKey, { loading: false, utilization: null });
      };
    }

    if (usage !== null) {
      onUsageStateReported(accountKey, { loading: false, utilization: peakUtilization(usage) });
      return () => {
        onUsageStateReported(accountKey, { loading: false, utilization: null });
      };
    }
    onUsageStateReported(accountKey, { loading: false, utilization: null });
    return undefined;
  }, [loading, usage, accountKey, onUsageStateReported]);

  if (loading) {
    return (
      <div className={styles.headroomRow}>
        <span className={styles.headroomLabel}>{account.label ?? account.id}</span>
        <span className={styles.headroomEmpty}>Loading…</span>
      </div>
    );
  }

  if (usage === null || usage.windows.length === 0) {
    return (
      <div className={styles.headroomRow}>
        <span className={styles.headroomLabel}>{account.label ?? account.id}</span>
        <span className={styles.headroomEmpty}>—</span>
      </div>
    );
  }

  // Show the first (typically the shortest / most relevant) window.
  const primary = usage.windows[0];
  return (
    <div className={styles.headroomRow}>
      <span className={styles.headroomLabel}>{account.label ?? account.id}</span>
      <div className={styles.headroomGauge}>
        <UsageGauge label={primary.label} percentage={primary.utilization / 100} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget component
// ---------------------------------------------------------------------------

/** Dashboard usage widget configuration. No instance config required. */
export type DashboardUsageWidgetConfig = Record<string, never>;

/**
 * Dashboard usage widget component.
 *
 * Shows KPI tiles (active-now, peak-7d, switch count) and headroom bars for
 * every active account across all providers.
 * @param _props - Standard widget props (size and config unused at this phase).
 * @returns Dashboard usage widget content.
 */
function DashboardUsageWidget(_props: WidgetProps<DashboardUsageWidgetConfig>): JSX.Element {
  const bus = useOptionalBus();
  const { sources, accountsByClient, loading, error } = useAccounts();

  // Mount-local switch counter — incremented by credentials.switched bus events.
  const [switchCount, setSwitchCount] = useState(0);

  // Per-account utilization map used to compute peak-7d. Entries for removed
  // accounts are inert (cleanup sets utilization: null, filtered by peak calc)
  // and bounded to accounts-seen-this-mount, so no explicit pruning is needed.
  const usageStateMapRef = useRef<Map<string, { loading: boolean; utilization: number | null }>>(new Map());
  const [peakState, setPeakState] = useState<{ loading: boolean; value: number | null }>({
    loading: false,
    value: null,
  });

  useEffect(() => {
    if (!bus) return;
    const unsub = bus.on(AccountManagerSubjects.credentials.switched, () => {
      setSwitchCount((prev) => prev + 1);
    });
    return unsub;
  }, [bus]);

  /**
   * Receives per-account usage state and recomputes the overall peak KPI.
   *
   * Wrapped in `useCallback` with an empty dependency list because the map
   * is accessed via a stable ref and `setPeakPct` is a stable setter. This
   * prevents `AccountHeadroomRow`'s `useEffect` from firing on every parent
   * re-render due to a new function reference.
   *
   * Loading rows report `loading: true` so the parent can avoid rendering a
   * misleading "0%" peak while the first snapshots are still in flight.
   * @param accountKey - Provider-scoped account key produced by {@link createAccountCacheKey}.
   * @param usageState - Current loading/utilization state for this account row.
   */
  const handleUsageStateReported = useCallback(
    (accountKey: string, usageState: { loading: boolean; utilization: number | null }): void => {
      usageStateMapRef.current.set(accountKey, usageState);

      const states = Array.from(usageStateMapRef.current.values());
      const values = states.map((state) => state.utilization).filter((value): value is number => value !== null);
      const newPeak = values.length > 0 ? Math.round(Math.max(...values) * 100) : null;
      setPeakState({
        loading: states.some((state) => state.loading),
        value: newPeak,
      });
    },
    [],
  );

  // Flatten all active accounts across all providers.
  const allAccounts: Array<{ account: Account; clientId: string }> = [];
  for (const source of sources) {
    const accounts = accountsByClient.get(source.clientId) ?? [];
    for (const account of accounts) {
      if (account.active) {
        allAccounts.push({ account, clientId: source.clientId });
      }
    }
  }

  const activeCount = allAccounts.length;

  // When all accounts report utilization: null (error or no data), value is
  // null and we show '0%' rather than '—' to distinguish from the loading
  // state. The peak calc correctly filters nulls; error-state accounts do
  // not inflate the peak — they are simply absent from the computation.
  const peakValue = peakState.value !== null ? `${peakState.value}%` : peakState.loading ? '—' : '0%';

  if (loading) {
    return (
      <div className={styles.widget} data-component="DashboardUsageWidget">
        <div className={styles.loadingPlaceholder}>Loading usage data…</div>
      </div>
    );
  }

  if (error !== null && sources.length === 0) {
    return (
      <div className={styles.widget} data-component="DashboardUsageWidget">
        <div className={styles.errorPlaceholder}>Unable to load usage data.</div>
      </div>
    );
  }

  return (
    <div className={styles.widget} data-component="DashboardUsageWidget">
      {error !== null && (
        <div className={styles.errorPlaceholder} role="status">
          Usage data may be incomplete.
        </div>
      )}
      <div className={styles.kpiRow}>
        <KpiTile title="Active" value={activeCount} sub="accounts" />
        <KpiTile title="Peak" value={peakValue} sub={peakState.loading ? 'loading' : 'utilization'} />
        <KpiTile title="Switches" value={switchCount} sub="this session" />
      </div>
      {allAccounts.length > 0 && (
        <div className={styles.headroomSection}>
          <span className={styles.headroomTitle}>Headroom</span>
          <div className={styles.headroomList}>
            {allAccounts.map(({ account, clientId }) => (
              <AccountHeadroomRow
                key={createAccountCacheKey(clientId, account.id)}
                account={account}
                clientId={clientId}
                onUsageStateReported={handleUsageStateReported}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget definition
// ---------------------------------------------------------------------------

/**
 * Dashboard usage widget definition.
 *
 * Scope: `'global'` — appears on the main dashboard.
 * Shows KPI tiles and per-account headroom bars.
 */
export const dashboardUsageWidgetDefinition: WidgetDefinition<DashboardUsageWidgetConfig> = {
  allowMultiple: false,
  component: DashboardUsageWidget,
  defaultSize: 'medium',
  description: 'Usage KPI tiles (active accounts, peak utilization, switch count) with headroom bars.',
  id: 'account-manager:dashboard-usage',
  name: 'Usage',
  scope: 'global',
  supportedSizes: ['medium', 'large'],
};

/** Type-erased export for use in heterogeneous widget arrays. */
export const dashboardUsageWidgetDefinitionErased = eraseWidgetConfig(dashboardUsageWidgetDefinition);
