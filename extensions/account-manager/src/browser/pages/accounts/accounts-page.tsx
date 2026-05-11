/**
 * Accounts management page.
 *
 * Full-viewport sheet page that lists all credential providers and their
 * accounts. Provides per-account actions: switch, rename (inline input), and
 * delete (with a confirmation step). Usage gauges are rendered below each
 * account row.
 *
 * Opened via the dashboard accounts widget activation → `SheetOverlay` in
 * `FrameworkShell`. No internal routing is needed at this phase; the page
 * renders the account list directly.
 * @packageDocumentation
 */

import { useCallback, useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { useOptionalBus } from '@makaio/ui-hooks';
import { AccountManagerSubjects } from '@makaio-community/account-manager/register';
import type { Account, SourceInfo } from '@makaio-community/account-manager/schemas';
import type { PageComponentProps } from '@makaio/ui-kernel';
import { displayLabel, displayMeta } from '@makaio-community/account-manager/utils';
import { useAccounts } from '../../data/use-accounts.js';
import { useUsageData } from '../../data/use-usage-data.js';
import { useSwitchAccount } from '../../hooks/use-switch-account.js';
import { AccountRow } from '../../components/account-row/account-row.js';
import { UsageGauge } from '../../components/usage-gauge/usage-gauge.js';
import styles from './accounts-page.module.scss';

// ---------------------------------------------------------------------------
// AccountEntry — one account row with actions and usage gauges
// ---------------------------------------------------------------------------

/**
 * Props for {@link AccountEntry}.
 */
interface AccountEntryProps {
  /** The account to render. */
  account: Account;
  /** Credential-source client ID for this account's provider. */
  clientId: string;
  /** Whether the source is available (controls switch affordance). */
  sourceAvailable: boolean;
  /** Callback invoked when the user requests a switch to this account. */
  onSwitch: (clientId: string, accountId: string) => void;
  /** Callback invoked after a successful rename RPC. */
  onRenameComplete: () => void;
  /** Callback invoked after a successful delete RPC. */
  onDeleteComplete: () => void;
}

/**
 * Rename inline state managed within {@link AccountEntry}.
 */
type RenameState =
  | { active: false }
  | { active: true; value: string; submitting: boolean; error: string | null };

/**
 * Delete confirmation state managed within {@link AccountEntry}.
 */
type DeleteState =
  | { phase: 'idle'; error: string | null }
  | { phase: 'confirming'; error: null }
  | { phase: 'deleting'; error: null };

/**
 * Convert usage utilization into the bounded percentage expected by UsageGauge.
 * @param utilization - Utilization percentage where 100 means fully used.
 * @returns Clamped gauge percentage in the inclusive range [0, 1].
 */
function toGaugePercentage(utilization: number): number {
  return Math.min(Math.max(utilization / 100, 0), 1);
}

/**
 * Renders a single account entry with usage gauges below and inline actions.
 *
 * Switch appears only for inactive accounts when the source is available.
 * Rename shows an inline text input on activation; Escape or empty Enter
 * cancels. Delete requires a confirmation step before issuing the RPC.
 * @param props - Account entry configuration.
 * @returns Account entry element.
 */
function AccountEntry({
  account,
  clientId,
  sourceAvailable,
  onSwitch,
  onRenameComplete,
  onDeleteComplete,
}: AccountEntryProps): JSX.Element {
  const bus = useOptionalBus();
  const { data: usage, error: usageError } = useUsageData({ clientId, accountId: account.id });

  const [rename, setRename] = useState<RenameState>({ active: false });
  const [deleteState, setDeleteState] = useState<DeleteState>({ phase: 'idle', error: null });
  const [labelOverride, setLabelOverride] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const accountLabel = displayLabel(account);
  const label = labelOverride ?? accountLabel;
  const metaText = displayMeta(account.metadata);

  useEffect(() => {
    if (labelOverride !== null && accountLabel === labelOverride) {
      setLabelOverride(null);
    }
  }, [accountLabel, labelOverride]);

  const canSwitch = !account.active && sourceAvailable;
  const handleSwitchClick = useCallback((): void => {
    onSwitch(clientId, account.id);
  }, [onSwitch, clientId, account.id]);

  /**
   * Activate rename mode and focus the input on next tick.
   */
  const handleRenameStart = useCallback((): void => {
    setRename({ active: true, value: label, submitting: false, error: null });
    // Focus after state update.
    setTimeout(() => renameInputRef.current?.focus(), 0);
  }, [label]);

  /**
   * Cancel rename without submitting.
   */
  const handleRenameCancel = useCallback((): void => {
    setRename({ active: false });
  }, []);

  /**
   * Submit the rename RPC with the current input value.
   * @param value - Trimmed label to submit.
   */
  const handleRenameSubmit = useCallback(
    (value: string): void => {
      if (!bus) return;
      const trimmed = value.trim();
      if (!trimmed) {
        setRename({ active: false });
        return;
      }
      setRename({ active: true, value: trimmed, submitting: true, error: null });
      void bus
        .request(AccountManagerSubjects.accounts.label, {
          clientId,
          accountId: account.id,
          label: trimmed,
        })
        .then((result) => {
          if (result.success) {
            setLabelOverride(trimmed);
            setRename({ active: false });
            onRenameComplete();
          } else {
            setRename({ active: true, value: trimmed, submitting: false, error: 'Unable to rename account.' });
          }
        })
        .catch(() => {
          setRename({ active: true, value: trimmed, submitting: false, error: 'Unable to rename account.' });
        });
    },
    [bus, clientId, account.id, onRenameComplete],
  );

  /**
   * Handle keyboard events on the rename input.
   * Enter → submit; Escape → cancel.
   * @param e - Keyboard event from the input element.
   */
  const handleRenameKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (rename.active) {
          handleRenameSubmit(rename.value);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleRenameCancel();
      }
    },
    [rename, handleRenameSubmit, handleRenameCancel],
  );

  /**
   * Request delete confirmation.
   */
  const handleDeleteStart = useCallback((): void => {
    setDeleteState({ phase: 'confirming', error: null });
  }, []);

  /**
   * Cancel pending delete confirmation.
   */
  const handleDeleteCancel = useCallback((): void => {
    setDeleteState({ phase: 'idle', error: null });
  }, []);

  /**
   * Confirm and execute the delete RPC.
   */
  const handleDeleteConfirm = useCallback((): void => {
    if (!bus) return;
    setDeleteState({ phase: 'deleting', error: null });
    void bus
      .request(AccountManagerSubjects.accounts.remove, {
        clientId,
        accountId: account.id,
      })
      .then((result) => {
        if (result.success) {
          setDeleteState({ phase: 'idle', error: null });
          onDeleteComplete();
        } else {
          setDeleteState({ phase: 'idle', error: 'Unable to delete account.' });
        }
      })
      .catch(() => {
        setDeleteState({ phase: 'idle', error: 'Unable to delete account.' });
      });
  }, [bus, clientId, account.id, onDeleteComplete]);

  const isRenaming = rename.active;
  const isConfirmingDelete = deleteState.phase === 'confirming';
  const isDeleting = deleteState.phase === 'deleting';

  return (
    <div className={styles.accountEntry}>
      <div className={styles.accountMain}>
        {/*
         * AccountRow renders the active marker and label only — onSwitch is
         * intentionally omitted here so all three action buttons (Switch,
         * Rename, Delete) appear together in accountActions on the right.
         */}
        <div className={styles.accountMeta}>
          <AccountRow label={label} active={account.active} />
          {metaText && <span className={styles.accountMetaText}>{metaText}</span>}
        </div>

        {/* Action buttons — hidden until hover/focus */}
        {!isRenaming && !isConfirmingDelete && !isDeleting && (
          <div className={styles.accountActions}>
            {canSwitch && (
              <button
                type="button"
                className={`${styles.actionButton} ${styles.actionButtonSwitch}`}
                onClick={handleSwitchClick}
                aria-label={`Switch to ${label}`}
              >
                Switch
              </button>
            )}
            <button
              type="button"
              className={styles.actionButton}
              onClick={handleRenameStart}
              aria-label={`Rename ${label}`}
            >
              Rename
            </button>
            <button
              type="button"
              className={`${styles.actionButton} ${styles.actionButtonDanger}`}
              onClick={handleDeleteStart}
              aria-label={`Delete ${label}`}
            >
              Delete
            </button>
          </div>
        )}

        {/* Delete confirmation */}
        {(isConfirmingDelete || isDeleting) && (
          <div className={styles.accountActions}>
            <button
              type="button"
              className={`${styles.actionButton} ${styles.actionButtonDanger} ${styles.actionButtonActive}`}
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              aria-label={`Confirm delete ${label}`}
            >
              {isDeleting ? 'Deleting…' : 'Yes, delete'}
            </button>
            {!isDeleting && (
              <button
                type="button"
                className={`${styles.actionButton} ${styles.actionButtonActive}`}
                onClick={handleDeleteCancel}
                aria-label="Cancel delete"
              >
                Cancel
              </button>
            )}
          </div>
        )}
      </div>

      {deleteState.error !== null && (
        <span className={styles.inlineError} role="alert">
          {deleteState.error}
        </span>
      )}

      {/* Inline rename input */}
      {isRenaming && rename.active && (
        <div className={styles.renameRow}>
          <input
            ref={renameInputRef}
            type="text"
            className={styles.renameInput}
            value={rename.value}
            onChange={(e) =>
              setRename({ active: true, value: e.target.value, submitting: rename.submitting, error: null })
            }
            onKeyDown={handleRenameKeyDown}
            placeholder="Account label"
            disabled={rename.submitting}
            aria-label="New account label"
          />
          <button
            type="button"
            className={styles.renameSubmit}
            onClick={() => handleRenameSubmit(rename.value)}
            disabled={rename.submitting}
          >
            {rename.submitting ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className={styles.renameCancel}
            onClick={handleRenameCancel}
            disabled={rename.submitting}
          >
            Cancel
          </button>
          {rename.error !== null && (
            <span className={styles.inlineError} role="alert">
              {rename.error}
            </span>
          )}
        </div>
      )}

      {/* Usage gauges */}
      {usageError !== null ? (
        <div className={styles.gaugeError}>Usage unavailable.</div>
      ) : usage !== null && usage.windows.length > 0 ? (
        <div className={styles.gauges}>
          {usage.windows.map((window) => (
            <UsageGauge key={window.id} label={window.label} percentage={toGaugePercentage(window.utilization)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProviderSection — one section per credential source
// ---------------------------------------------------------------------------

/**
 * Props for {@link ProviderSection}.
 */
interface ProviderSectionProps {
  /** Source metadata for the provider. */
  source: SourceInfo;
  /** Accounts registered under this source. */
  accounts: Account[];
  /** Callback invoked when the user requests an account switch. */
  onSwitch: (clientId: string, accountId: string) => void;
  /** Callback invoked after a rename RPC completes. Triggers data refresh. */
  onMutationComplete: () => void;
}

/**
 * Renders one provider section: a header with provider name and all
 * account entries below.
 * @param props - Provider section configuration.
 * @returns Provider section element.
 */
function ProviderSection({ source, accounts, onSwitch, onMutationComplete }: ProviderSectionProps): JSX.Element {
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
        <span className={styles.accountCount}>
          {accounts.length} account{accounts.length !== 1 ? 's' : ''}
        </span>
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
              sourceAvailable={source.available}
              onSwitch={onSwitch}
              onRenameComplete={onMutationComplete}
              onDeleteComplete={onMutationComplete}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AccountsPage — page root
// ---------------------------------------------------------------------------

/**
 * Accounts management page component.
 *
 * Lists all registered credential sources and their accounts. Each account
 * row supports switch, rename, and delete actions. Usage gauges are rendered
 * below each account row.
 *
 * This is the default export required by the lazy-load pattern in
 * {@link accountsPageDefinition}.
 * @param props - Standard page component props.
 * @returns Accounts page element.
 */
export default function AccountsPage({ className }: PageComponentProps): JSX.Element {
  const bus = useOptionalBus();
  const { sources, accountsByClient, loading, error, refresh } = useAccounts();

  const handleSwitch = useSwitchAccount(bus, '[AccountsPage]');

  const rootClass = className !== undefined ? `${styles.page} ${className}` : styles.page;

  if (bus === null) {
    return (
      <div className={rootClass} data-component="AccountsPage">
        <header className={styles.header}>
          <span className={styles.headerTitle}>Accounts</span>
        </header>
        <div className={styles.content}>
          <div className={styles.unavailablePlaceholder}>Account service unavailable.</div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={rootClass} data-component="AccountsPage">
        <header className={styles.header}>
          <span className={styles.headerTitle}>Accounts</span>
        </header>
        <div className={styles.content}>
          <div className={styles.loadingPlaceholder}>Loading accounts…</div>
        </div>
      </div>
    );
  }

  return (
    <div className={rootClass} data-component="AccountsPage">
      <header className={styles.header}>
        <span className={styles.headerTitle}>Accounts</span>
      </header>
      <div className={styles.content}>
        {error !== null && (
          <div className={styles.errorBanner} role="status">
            {sources.length === 0 ? 'Unable to load accounts.' : 'Account data may be incomplete.'}
            <button type="button" className={styles.retryButton} onClick={refresh}>
              Retry
            </button>
          </div>
        )}
        {sources.length === 0 && error === null && (
          <div className={styles.emptyPlaceholder}>No providers configured.</div>
        )}
        {sources.length > 0 &&
          sources.map((source) => (
            <ProviderSection
              key={source.clientId}
              source={source}
              accounts={accountsByClient.get(source.clientId) ?? []}
              onSwitch={handleSwitch}
              onMutationComplete={refresh}
            />
          ))}
      </div>
    </div>
  );
}
