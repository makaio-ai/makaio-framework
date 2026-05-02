/**
 * Dashboard accounts widget.
 *
 * Rich overview of all credential providers and accounts for the `'global'`
 * (dashboard) scope. Each account row shows an active/inactive marker,
 * label, last-seen timestamp, and a switch affordance for inactive accounts.
 *
 * The widget surfaces an explicit unavailable state when no BusProvider
 * ancestor is present so transport absence is not mistaken for an empty
 * provider list.
 * @packageDocumentation
 */

import { type JSX } from 'react';
import { useOptionalBus } from '@makaio/ui-hooks';
import { eraseWidgetConfig } from '@makaio/ui-kernel';
import type { Account, SourceInfo } from '@makaio-community/account-manager/schemas';
import type { WidgetDefinition, WidgetProps } from '@makaio/ui-kernel';
import { useAccounts } from '../../data/use-accounts.js';
import { useSwitchAccount } from '../../hooks/use-switch-account.js';
import { AccountRow } from '../../components/account-row/account-row.js';
import { displayLabel, formatRelativeTime } from '@makaio-community/account-manager/utils';
import styles from './dashboard-accounts-widget.module.scss';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Props for {@link ProviderPanel}.
 */
interface ProviderPanelProps {
  /** Source metadata for the provider. */
  source: SourceInfo;
  /** Accounts registered under this source. */
  accounts: Account[];
  /** Callback invoked when the user requests a switch to an account. */
  onSwitch: (clientId: string, accountId: string) => void;
}

/**
 * Format the last-seen tooltip as an ISO timestamp when possible.
 *
 * Provider state can be stale or malformed. Keep the dashboard row on the same
 * non-throwing degradation path as the visible relative label instead of
 * letting one invalid timestamp break the whole provider panel.
 * @param epochMs - Last-seen timestamp in epoch milliseconds.
 * @returns ISO timestamp or a descriptive fallback.
 */
function formatLastSeenTitle(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return 'Unknown last-seen time';
  const d = new Date(epochMs);
  return Number.isNaN(d.getTime()) ? 'Unknown last-seen time' : d.toISOString();
}

/**
 * Shared retry notice for both full and partial dashboard fetch failures.
 * Keeping the markup in one place prevents copy drift between the two states.
 * @param props - Message and retry handler for the notice.
 * @returns Error notice element with retry action.
 */
function RetryNotice({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <div className={styles.errorPlaceholder} role="status">
      {message}
      <button type="button" className={styles.retryButton} onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/**
 * Renders a single provider panel with all its accounts in a richer
 * dashboard layout that includes last-seen timestamps.
 *
 * The widget returns early when no bus is available, so provider rows only
 * render once switching is actually possible and only need to gate on account
 * activity plus provider availability.
 * @param props - Provider panel configuration.
 * @returns Provider panel element.
 */
function ProviderPanel({ source, accounts, onSwitch }: ProviderPanelProps): JSX.Element {
  return (
    <div className={styles.providerPanel}>
      <div className={styles.providerHeader}>
        <span className={styles.providerGlyph} aria-hidden="true">
          ◈
        </span>
        <span className={styles.providerName}>{source.displayName}</span>
        {!source.available && (
          <span className={styles.unavailableBadge} title={source.configIssue?.reason}>
            Unavailable
          </span>
        )}
        <span className={styles.accountCount}>
          {accounts.length} account{accounts.length !== 1 ? 's' : ''}
        </span>
      </div>
      {accounts.length === 0 ? (
        <div className={styles.emptyAccounts}>No accounts detected.</div>
      ) : (
        <div className={styles.accountList}>
          {accounts.map((account) => (
            <div key={account.id} className={styles.accountRow}>
              <AccountRow
                label={displayLabel(account)}
                active={account.active}
                onSwitch={!account.active && source.available ? () => onSwitch(source.clientId, account.id) : undefined}
              />
              <span className={styles.lastSeen} title={formatLastSeenTitle(account.lastSeenAt)}>
                {formatRelativeTime(account.lastSeenAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget component
// ---------------------------------------------------------------------------

/** Dashboard accounts widget configuration. No instance config required. */
export type DashboardAccountsWidgetConfig = Record<string, never>;

/**
 * Dashboard accounts widget component.
 *
 * Lists all credential providers and their accounts with last-seen timestamps.
 * Inactive accounts expose a switch affordance when a bus is present.
 * @param _props - Standard widget props (unused at this phase).
 * @returns Dashboard accounts widget content.
 */
function DashboardAccountsWidget(_props: WidgetProps<DashboardAccountsWidgetConfig>): JSX.Element {
  const bus = useOptionalBus();
  const { sources, accountsByClient, loading, error, refresh } = useAccounts();

  const handleSwitch = useSwitchAccount(bus, '[DashboardAccountsWidget]');

  if (bus === null) {
    return (
      <div className={styles.widget} data-component="DashboardAccountsWidget">
        <div className={styles.emptyProviders}>Account service unavailable.</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.widget} data-component="DashboardAccountsWidget">
        <div className={styles.loadingPlaceholder}>Loading accounts…</div>
      </div>
    );
  }

  if (error !== null && sources.length === 0) {
    return (
      <div className={styles.widget} data-component="DashboardAccountsWidget">
        <RetryNotice message="Unable to load accounts." onRetry={refresh} />
      </div>
    );
  }

  return (
    <div className={styles.widget} data-component="DashboardAccountsWidget">
      {error !== null && <RetryNotice message="Account data may be incomplete." onRetry={refresh} />}
      <div className={styles.header}>
        <span className={styles.title}>Accounts</span>
        <span className={styles.sourceCount}>
          {sources.length} provider{sources.length !== 1 ? 's' : ''}
        </span>
      </div>
      {sources.length === 0 ? (
        <div className={styles.emptyProviders}>No providers configured.</div>
      ) : (
        <div className={styles.providerList}>
          {sources.map((source) => (
            <ProviderPanel
              key={source.clientId}
              source={source}
              accounts={accountsByClient.get(source.clientId) ?? []}
              onSwitch={handleSwitch}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget definition
// ---------------------------------------------------------------------------

/**
 * Dashboard accounts widget definition.
 *
 * Scope: `'global'` — appears on the main dashboard.
 * Shows a rich, full-width overview of all configured providers and accounts.
 */
export const dashboardAccountsWidgetDefinition: WidgetDefinition<DashboardAccountsWidgetConfig> = {
  allowMultiple: false,
  component: DashboardAccountsWidget,
  defaultSize: 'medium',
  description: 'All credential providers and accounts with last-used timestamps.',
  id: 'account-manager:dashboard-accounts',
  name: 'Accounts',
  scope: 'global',
  supportedSizes: ['medium', 'large', 'full-width'],
};

/** Type-erased export for use in heterogeneous widget arrays. */
export const dashboardAccountsWidgetDefinitionErased = eraseWidgetConfig(dashboardAccountsWidgetDefinition);
