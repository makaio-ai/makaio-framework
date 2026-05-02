/* eslint max-lines: ["error", { "max": 550 }] */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Box, useApp, useInput, useStdout } from 'ink';
import { buildLayout } from './layout.js';
import { useScrollWindow } from './hooks/use-scroll-window.js';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { Account, SourceInfo } from '../bus/schemas.js';
import { BusLifecycle, type IMakaioBus } from '@makaio/bus-core';
import { displayLabel } from '../utils/format-account-display.js';
import { Header, HEADER_HEIGHT } from './components/header.js';
import { AccountsPanel, ACCOUNTS_PANEL_VERTICAL_PADDING_HEIGHT } from './components/accounts-panel.js';
import { NotificationBar, NOTIFICATION_BAR_HEIGHT } from './components/notification-bar.js';
import { LabelPrompt, LABEL_PROMPT_HEIGHT } from './components/label-prompt.js';
import { HelpBar, HELP_BAR_HEIGHT } from './components/help-bar.js';
import { ConnectionBanner, CONNECTION_BANNER_HEIGHT } from './components/connection-banner.js';
import { usageKey, type UsageMap } from './usage-keys.js';
import { loadUsageForAccounts } from './load-usage.js';
import { removeKey, removeUsageResolutionKey, type UsageAwaitingResolutionMap } from './usage-state.js';
import { createAccountCacheKey } from '../utils/account-key.js';

/** Terminal rows occupied by the App root border. */
const APP_BORDER_HEIGHT = 2;

interface LabelPromptState {
  clientId: string;
  accountId: string;
}

interface AppProps {
  bus: IMakaioBus;
}

interface LoadDataResult {
  /** Sequence token identifying the load run. */
  loadSeq: number;
  /** Accounts grouped by client ID. */
  accountsMap: Record<string, Account[]>;
}

/**
 * Root TUI component for the account manager.
 *
 * Manages account state, bus subscriptions, keyboard navigation,
 * and orchestrates all child components.
 * @param props - Component props
 */
export function App({ bus }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [connected, setConnected] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [accountsByClient, setAccountsByClient] = useState<Record<string, Account[]>>({});
  const [usageByAccount, setUsageByAccount] = useState<UsageMap>({});
  const [usageAwaitingResolutionByAccount, setUsageAwaitingResolutionByAccount] = useState<UsageAwaitingResolutionMap>(
    {},
  );
  const [notification, setNotification] = useState<string | null>(null);
  const [labelPrompt, setLabelPrompt] = useState<LabelPromptState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [switchingAccountId, setSwitchingAccountId] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const runIdRef = useRef(0);
  const loadSeqRef = useRef(0);

  // Build a flat list of selectable accounts for keyboard navigation.
  // configIssue sources render as banners and must not become selectable rows.
  const flatAccounts = useMemo(
    () =>
      sources
        .filter((source) => !source.configIssue)
        .flatMap((source) =>
          (accountsByClient[source.clientId] ?? []).map((account) => ({
            clientId: source.clientId,
            account,
          })),
        ),
    [accountsByClient, sources],
  );

  const canCommitLoad = useCallback(
    (loadSeq: number, isCurrentRun: () => boolean) =>
      mountedRef.current && isCurrentRun() && loadSeq === loadSeqRef.current,
    [],
  );

  const loadData = useCallback(
    async (isCurrentRun: () => boolean = () => mountedRef.current): Promise<LoadDataResult | undefined> => {
      const loadSeq = ++loadSeqRef.current;
      try {
        const { sources: srcList } = await bus.request(AccountManagerSubjects.accounts.getSources, {});
        if (!canCommitLoad(loadSeq, isCurrentRun)) return undefined;
        setSources(srcList);

        const accountsMap: Record<string, Account[]> = {};
        for (const src of srcList) {
          const { accounts } = await bus.request(AccountManagerSubjects.accounts.list, {
            clientId: src.clientId,
          });
          if (!canCommitLoad(loadSeq, isCurrentRun)) return undefined;
          accountsMap[src.clientId] = accounts;
        }
        if (!canCommitLoad(loadSeq, isCurrentRun)) return undefined;
        setAccountsByClient(accountsMap);

        const liveKeys = new Set(
          Object.entries(accountsMap).flatMap(([cid, accts]) => accts.map((a) => usageKey(cid, a.id))),
        );
        setUsageByAccount((prev) => {
          const pruned = Object.fromEntries(Object.entries(prev).filter(([k]) => liveKeys.has(k)));
          return Object.keys(pruned).length === Object.keys(prev).length ? prev : pruned;
        });
        setUsageAwaitingResolutionByAccount((prev) => {
          const pruned = Object.fromEntries(
            Object.entries(prev).filter(([k]) => liveKeys.has(k)),
          ) as UsageAwaitingResolutionMap;
          return Object.keys(pruned).length === Object.keys(prev).length ? prev : pruned;
        });

        return { loadSeq, accountsMap };
      } catch {
        if (canCommitLoad(loadSeq, isCurrentRun)) {
          setNotification('Failed to connect to account-manager service');
        }
        return undefined;
      }
    },
    [bus, canCommitLoad],
  );

  // --- Initial load + event subscriptions ---
  useEffect(() => {
    mountedRef.current = true;
    const currentRunId = ++runIdRef.current;
    const isCurrentRun = () => runIdRef.current === currentRunId;
    const cleanups: Array<() => void> = [];

    // Reload accounts then usage in sequence so stale bootstrap work cannot merge after a newer reload.
    const reloadAll = (): void => {
      void loadData(isCurrentRun).then((result) => {
        if (result && isCurrentRun()) {
          void loadUsageForAccounts(
            { bus, canCommitLoad, setUsageByAccount, setUsageAwaitingResolutionByAccount },
            result.loadSeq,
            result.accountsMap,
            isCurrentRun,
          );
        }
      });
    };

    // Subscribe before loading so events that fire during bootstrap are captured.
    cleanups.push(
      bus.on(BusLifecycle.disconnected, () => {
        if (!isCurrentRun()) return;
        setConnected(false);
        setReconnecting(false);
      }),
      bus.on(BusLifecycle.connected, () => {
        if (!isCurrentRun()) return;
        setConnected(true);
        setReconnecting(false);
        reloadAll();
      }),
      bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
        if (!isCurrentRun()) return;
        const { clientId, accountId, usage } = ctx.payload;
        const key = usageKey(clientId, accountId);
        setUsageAwaitingResolutionByAccount((prev) => removeUsageResolutionKey(prev, key));
        const isPlaceholder = usage.stale === true && usage.windows.length === 0 && usage.lastOkAt == null;
        if (isPlaceholder) return;
        setUsageByAccount((prev) => {
          const existing = prev[key];
          if (existing && existing.fetchedAt > usage.fetchedAt) return prev;
          return { ...prev, [key]: usage };
        });
      }),
      bus.on(AccountManagerSubjects.accounts.metadataPatched, (ctx) => {
        if (!isCurrentRun()) return;
        const key = usageKey(ctx.payload.clientId, ctx.payload.account.id);
        setUsageAwaitingResolutionByAccount((prev) => removeUsageResolutionKey(prev, key));
        void loadData(isCurrentRun);
      }),
      bus.on(AccountManagerSubjects.credentials.detected, (ctx) => {
        if (!isCurrentRun()) return;
        reloadAll();
        if (ctx.payload.autoLabeled) {
          setNotification(`New account detected for ${ctx.payload.clientId}: ${ctx.payload.account.label}`);
        } else {
          setLabelPrompt({ clientId: ctx.payload.clientId, accountId: ctx.payload.account.id });
          setNotification(`New account detected for ${ctx.payload.clientId}`);
        }
      }),
      bus.on(AccountManagerSubjects.credentials.switched, (ctx) => {
        if (!isCurrentRun()) return;
        setSwitchingAccountId(null);
        reloadAll();
        setNotification(`Switched to ${displayLabel(ctx.payload.to)}`);
      }),
      bus.on(AccountManagerSubjects.credentials.refreshed, () => {
        if (!isCurrentRun()) return;
        reloadAll();
      }),
      bus.on(AccountManagerSubjects.accounts.labeled, (ctx) => {
        if (!isCurrentRun()) return;
        void loadData(isCurrentRun);
        setLabelPrompt((current) =>
          current?.clientId === ctx.payload.clientId && current.accountId === ctx.payload.account.id ? null : current,
        );
        setNotification(`Label resolved for ${ctx.payload.clientId}: ${displayLabel(ctx.payload.account)}`);
      }),
      bus.on(AccountManagerSubjects.credentials.error, (ctx) => {
        if (!isCurrentRun()) return;
        setNotification(`Error: ${ctx.payload.message}`);
      }),
    );

    const init = async () => {
      const result = await loadData(isCurrentRun);
      if (isCurrentRun() && result) {
        void loadUsageForAccounts(
          { bus, canCommitLoad, setUsageByAccount, setUsageAwaitingResolutionByAccount },
          result.loadSeq,
          result.accountsMap,
          isCurrentRun,
        );
      }
    };

    void init();
    return () => {
      mountedRef.current = false;
      ++runIdRef.current;
      cleanups.forEach((fn) => fn());
    };
  }, [bus, loadData]);

  // Clamp selectedIndex when the account list grows, shrinks, or becomes empty.
  useEffect(() => {
    setSelectedIndex((i) => (flatAccounts.length === 0 ? 0 : Math.max(0, Math.min(i, flatAccounts.length - 1))));
  }, [flatAccounts.length]);

  const selected = flatAccounts[selectedIndex] ?? null;
  const hasConfigIssue = sources.some((source) => Boolean(source.configIssue));
  const showHelpBar = labelPrompt === null;

  const terminalRows = stdout?.rows ?? 24;

  const chromeHeight =
    APP_BORDER_HEIGHT +
    HEADER_HEIGHT +
    ACCOUNTS_PANEL_VERTICAL_PADDING_HEIGHT +
    (notification ? NOTIFICATION_BAR_HEIGHT : 0) +
    (!connected ? CONNECTION_BANNER_HEIGHT : 0) +
    (labelPrompt ? LABEL_PROMPT_HEIGHT : 0) +
    (showHelpBar ? HELP_BAR_HEIGHT : 0);

  const availableHeight = Math.max(0, terminalRows - chromeHeight);

  const layout = useMemo(
    () => buildLayout(sources, accountsByClient, usageByAccount),
    [accountsByClient, sources, usageByAccount],
  );
  const scrollWindow = useScrollWindow({ layout, selectedFlatIndex: selectedIndex, availableHeight });
  const visibleAccountKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const item of layout) {
      if (item.type === 'account' && scrollWindow.visibleFlatIndices.has(item.flatIndex)) {
        keys.add(createAccountCacheKey(item.clientId, item.accountId));
      }
    }
    return keys;
  }, [layout, scrollWindow.visibleFlatIndices]);

  // --- Keyboard input ---
  useInput((input, key) => {
    if (!connected) {
      if (input === 'q') {
        exit();
        return;
      }
      if (input === 'r') {
        setReconnecting(true);
        // Only catch immediate reconnect() rejections; lifecycle events clear reconnecting for transport outcomes.
        void bus.reconnect().catch((err: unknown) => {
          console.error('[app] reconnect failed:', err);
          setReconnecting(false);
        });
        return;
      }
      return;
    }

    if (labelPrompt) return; // Label prompt handles its own input

    if (input === 'q') {
      exit();
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow && flatAccounts.length > 0) {
      setSelectedIndex((i) => Math.max(0, Math.min(flatAccounts.length - 1, i + 1)));
      return;
    }

    if (input === 'f') {
      const sourceWithIssue = sources.find((s) => s.configIssue);
      if (sourceWithIssue) {
        void bus
          .request(AccountManagerSubjects.credentials.configureFileMode, {
            clientId: sourceWithIssue.clientId,
          })
          .then((result) => {
            if (result.success) {
              setNotification(`Switched ${sourceWithIssue.displayName} to file mode (config backed up)`);
            } else {
              setNotification(`Failed to configure file mode: ${result.error ?? 'unknown error'}`);
            }
            void loadData();
          })
          .catch(() => {
            setNotification('Failed to configure file mode');
          });
      }
      return;
    }

    if (!selected) return;

    if (key.return && !selected.account.active && switchingAccountId === null) {
      setSwitchingAccountId(selected.account.id);
      void bus
        .request(AccountManagerSubjects.credentials.switch, {
          clientId: selected.clientId,
          accountId: selected.account.id,
        })
        .then((result) => {
          setSwitchingAccountId(null);
          if (!result.success) {
            setNotification(`Failed to switch account: ${result.error ?? 'unknown error'}`);
          }
        })
        .catch(() => {
          setSwitchingAccountId(null);
          setNotification('Failed to switch account');
        });
      return;
    }

    if (input === 'l') {
      setLabelPrompt({ clientId: selected.clientId, accountId: selected.account.id });
      return;
    }

    if (input === 'd') {
      void bus
        .request(AccountManagerSubjects.accounts.remove, {
          clientId: selected.clientId,
          accountId: selected.account.id,
        })
        .then((result) => {
          if (!result.success) {
            setNotification('Failed to remove account');
            return;
          }
          setUsageByAccount((prev) => removeKey(prev, usageKey(selected.clientId, selected.account.id)));
          setUsageAwaitingResolutionByAccount((prev) =>
            removeUsageResolutionKey(prev, usageKey(selected.clientId, selected.account.id)),
          );
          return loadData();
        })
        .catch(() => {
          setNotification('Failed to remove account');
        });
      return;
    }
  });

  // --- Label submission ---
  const handleLabelSubmit = useCallback(
    async (label: string) => {
      if (!labelPrompt) return;
      try {
        const result = await bus.request(AccountManagerSubjects.accounts.label, {
          clientId: labelPrompt.clientId,
          accountId: labelPrompt.accountId,
          label,
        });
        if (!result.success) {
          setNotification('Failed to update label');
          return;
        }
        setLabelPrompt(null);
        await loadData();
      } catch {
        setNotification('Failed to update label');
      }
    },
    [bus, labelPrompt, loadData],
  );

  // --- Render ---
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Header />
      <AccountsPanel
        sources={sources}
        accountsByClient={accountsByClient}
        selectedClientId={selected?.clientId ?? null}
        selectedAccountId={selected?.account.id ?? null}
        usageByAccount={usageByAccount}
        usageAwaitingResolutionByAccount={usageAwaitingResolutionByAccount}
        switchingAccountId={switchingAccountId}
        visibleAccountKeys={visibleAccountKeys}
        visibleConfigIssueIds={scrollWindow.visibleConfigIssueIds}
        hiddenAbove={scrollWindow.hiddenAbove}
        hiddenBelow={scrollWindow.hiddenBelow}
      />

      {notification && <NotificationBar message={notification} />}
      {!connected && <ConnectionBanner reconnecting={reconnecting} />}
      {labelPrompt && <LabelPrompt onSubmit={handleLabelSubmit} onCancel={() => setLabelPrompt(null)} />}
      {showHelpBar ? (
        <HelpBar
          showNavigationShortcut={flatAccounts.length > 0}
          showSwitchShortcut={Boolean(selected && !selected.account.active)}
          showLabelShortcut={selected !== null}
          showDeleteShortcut={selected !== null}
          showFileModeShortcut={hasConfigIssue}
          showQuitShortcut
        />
      ) : null}
    </Box>
  );
}
