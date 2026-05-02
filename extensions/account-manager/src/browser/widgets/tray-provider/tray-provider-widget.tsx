/**
 * Tray provider widget.
 *
 * Renders all registered credential sources and their accounts in a compact
 * glass-card layout for the tray surface. Each provider section shows accounts
 * with active/inactive markers, compact usage gauges, and a hover-revealed
 * switch action for inactive accounts.
 *
 * A single widget instance covers all providers. The `credentials.switch` RPC
 * is emitted via the bus when a switch action is requested; when no bus is
 * present the widget renders in read-only mode.
 * @packageDocumentation
 */

import { type JSX } from 'react';
import { useOptionalBus } from '@makaio/ui-hooks';
import { eraseWidgetConfig } from '@makaio/ui-kernel';
import type { Account, SourceInfo } from '@makaio-community/account-manager/schemas';
import type { WidgetDefinition, WidgetProps } from '@makaio/ui-kernel';
import { useAccounts } from '../../data/use-accounts.js';
import { useUsageData } from '../../data/use-usage-data.js';
import { useSwitchAccount } from '../../hooks/use-switch-account.js';
import { AccountRow } from '../../components/account-row/account-row.js';
import { UsageGauge } from '../../components/usage-gauge/usage-gauge.js';
import styles from './tray-provider-widget.module.scss';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Props for {@link AccountEntry}.
 */
interface AccountEntryProps {
  /** The account to render. */
  account: Account;
  /** Credential-source identifier for this account's provider. */
  clientId: string;
  /** Whether the switch affordance should be rendered (bus present). */
  canSwitch: boolean;
  /** Callback invoked when the user requests a switch to this account. */
  onSwitch: (clientId: string, accountId: string) => void;
}

/**
 * Renders a single account entry with usage gauges below the row.
 *
 * Usage gauges are loaded independently per account so a single failed fetch
 * does not affect other accounts.
 * @param props - Account entry configuration.
 * @returns Account row element with optional usage gauges.
 */
function AccountEntry({ account, clientId, canSwitch, onSwitch }: AccountEntryProps): JSX.Element {
  const { data: usage, error: usageError } = useUsageData({ clientId, accountId: account.id });

  const handleSwitch = !account.active && canSwitch ? () => onSwitch(clientId, account.id) : undefined;

  const label = account.label ?? account.id;

  return (
    <div className={styles.accountEntry}>
      <AccountRow label={label} active={account.active} onSwitch={handleSwitch} />
      {usageError !== null ? (
        <div className={styles.emptyAccounts}>Usage unavailable.</div>
      ) : usage !== null && usage.windows.length > 0 ? (
        <div className={styles.gauges}>
          {usage.windows.map((window) => (
            <UsageGauge key={window.id} label={window.label} percentage={window.utilization / 100} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider section
// ---------------------------------------------------------------------------

/**
 * Props for {@link ProviderSection}.
 */
interface ProviderSectionProps {
  /** Source metadata for the provider. */
  source: SourceInfo;
  /** Accounts registered under this source. */
  accounts: Account[];
  /** Callback invoked when the user requests a switch to an account. */
  onSwitch: (clientId: string, accountId: string) => void;
}

/**
 * Renders one provider section: a header with the provider name and all
 * account entries below.
 *
 * The widget returns early when no bus is available, so provider rows only
 * render once switching is possible and only need to gate on provider
 * availability.
 * @param props - Provider section configuration.
 * @returns Provider section element.
 */
function ProviderSection({ source, accounts, onSwitch }: ProviderSectionProps): JSX.Element {
  return (
    <div className={styles.providerSection}>
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
      </div>
      {accounts.length === 0 ? (
        <div className={styles.emptyAccounts}>No accounts detected.</div>
      ) : (
        <div className={styles.accountList}>
          {accounts.map((account) => (
            <AccountEntry
              key={account.id}
              account={account}
              clientId={source.clientId}
              canSwitch={source.available}
              onSwitch={onSwitch}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Shared retry notice used for both full and partial account-loading failures.
 * Keeping the CTA markup in one place prevents the tray warning and full-error
 * states from drifting when the retry affordance changes.
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

// ---------------------------------------------------------------------------
// Widget component
// ---------------------------------------------------------------------------

/** Tray provider widget configuration. No instance config required. */
export type TrayProviderWidgetConfig = Record<string, never>;

/**
 * Tray provider widget component.
 *
 * Renders all registered credential sources and their accounts. Inactive
 * accounts expose a switch affordance on hover when a bus is present.
 * Surfaces an explicit unavailable state when no BusProvider ancestor is
 * present so the tray does not misread transport absence as an empty account
 * configuration.
 * @param _props - Standard widget props (size and config unused at small size).
 * @returns Tray provider widget content.
 */
function TrayProviderWidget(_props: WidgetProps<TrayProviderWidgetConfig>): JSX.Element {
  const bus = useOptionalBus();
  const { sources, accountsByClient, loading, error, refresh } = useAccounts();

  const handleSwitch = useSwitchAccount(bus, '[TrayProviderWidget]');

  if (bus === null) {
    return (
      <div className={styles.widget} data-component="TrayProviderWidget">
        <div className={styles.emptyAccounts}>Account service unavailable.</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={styles.widget} data-component="TrayProviderWidget">
        <div className={styles.loadingPlaceholder}>Loading…</div>
      </div>
    );
  }

  if (error !== null && sources.length === 0) {
    return (
      <div className={styles.widget} data-component="TrayProviderWidget">
        <RetryNotice message="Unable to load accounts." onRetry={refresh} />
      </div>
    );
  }

  return (
    <div className={styles.widget} data-component="TrayProviderWidget">
      {error !== null && <RetryNotice message="Account data may be incomplete." onRetry={refresh} />}
      {sources.length === 0 ? (
        <div className={styles.emptyAccounts}>No providers configured.</div>
      ) : (
        sources.map((source) => (
          <ProviderSection
            key={source.clientId}
            source={source}
            accounts={accountsByClient.get(source.clientId) ?? []}
            onSwitch={handleSwitch}
          />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget definition
// ---------------------------------------------------------------------------

/**
 * Tray provider widget definition.
 *
 * Scope: `'tray'` — appears in the tray popover.
 * A single instance renders every configured credential provider; per-provider
 * instances would require dynamic definition registration or a new
 * `useTrayLayout` seam and are not supported by the current framework.
 */
export const trayProviderWidgetDefinition: WidgetDefinition<TrayProviderWidgetConfig> = {
  allowMultiple: false,
  component: TrayProviderWidget,
  defaultSize: 'medium',
  description: 'All credential providers and accounts with usage gauges.',
  id: 'account-manager:tray-provider',
  name: 'Accounts',
  scope: 'tray',
  supportedSizes: ['small', 'medium', 'large'],
};

/** Type-erased export for use in heterogeneous widget arrays. */
export const trayProviderWidgetDefinitionErased = eraseWidgetConfig(trayProviderWidgetDefinition);
