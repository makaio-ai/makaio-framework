// @vitest-environment jsdom
/**
 * Tests for AccountsPage.
 *
 * Uses real bus subjects so account mutation feedback is covered through the
 * public account-manager browser contract instead of mocked component state.
 */

import { createElement, type ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { BusContext } from '@makaio/ui-hooks';
import { AccountManagerSubjects } from '@makaio/extension-account-manager/subjects';
import type { Account, SourceInfo } from '@makaio/extension-account-manager/schemas';
import { clearUsageCache } from '../../../data/use-usage-data.js';
import AccountsPage from '../accounts-page.js';

function makeBusWrapper(bus: IMakaioBus) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(BusContext.Provider, { value: bus }, children);
  };
}

function makeSource(): SourceInfo {
  return { available: true, clientId: 'test-client', displayName: 'Test Provider' };
}

function makeAccount(): Account {
  return {
    active: false,
    detectedAt: 1_000,
    id: 'test-account',
    label: 'Test Account',
    lastSeenAt: 2_000,
    metadata: {},
  };
}

describe('AccountsPage', () => {
  let bus: IMakaioBus;
  let subscriptions: Array<() => void>;

  beforeEach(() => {
    bus = createBusInstance();
    subscriptions = [];
    clearUsageCache();
  });

  afterEach(() => {
    subscriptions.forEach((cleanup) => cleanup());
    clearUsageCache();
  });

  it('keeps rename open and shows inline feedback when label update fails', async () => {
    const source = makeSource();
    const account = makeAccount();

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        ctx.setResult({ sources: [source] });
      }),
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        expect(ctx.payload).toEqual({ clientId: source.clientId });
        ctx.setResult({ accounts: [account] });
      }),
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        expect(ctx.payload).toEqual({ clientId: source.clientId, accountId: account.id });
        ctx.setResult({
          usage: {
            fetchedAt: 1_000,
            windows: [
              {
                id: 'daily',
                label: 'Daily',
                resetsAt: 2_000,
                utilization: 80,
                windowSeconds: 86_400,
              },
            ],
          },
        });
      }),
      bus.on(AccountManagerSubjects.accounts.label, (ctx) => {
        expect(ctx.payload).toEqual({
          accountId: account.id,
          clientId: source.clientId,
          label: 'New Label',
        });
        ctx.setResult({ success: false });
      }),
    );

    render(createElement(AccountsPage), { wrapper: makeBusWrapper(bus) });

    await screen.findByText('Test Provider');
    await userEvent.click(screen.getByRole('button', { name: 'Rename Test Account' }));

    const input = screen.getByRole('textbox', { name: 'New account label' });
    await userEvent.clear(input);
    await userEvent.type(input, 'New Label');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unable to rename account.'));
    expect(screen.getByRole('textbox', { name: 'New account label' })).toBeInTheDocument();
  });

  it('keeps the successful rename label visible when refresh returns stale account data', async () => {
    const source = makeSource();
    const account = makeAccount();

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        ctx.setResult({ sources: [source] });
      }),
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        ctx.setResult({ accounts: [account] });
      }),
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        ctx.setResult({ usage: { fetchedAt: 1_000, windows: [] } });
      }),
      bus.on(AccountManagerSubjects.accounts.label, (ctx) => {
        expect(ctx.payload).toEqual({
          accountId: account.id,
          clientId: source.clientId,
          label: 'New Label',
        });
        ctx.setResult({ success: true });
      }),
    );

    render(createElement(AccountsPage), { wrapper: makeBusWrapper(bus) });

    await screen.findByText('Test Provider');
    await userEvent.click(screen.getByRole('button', { name: 'Rename Test Account' }));

    const input = screen.getByRole('textbox', { name: 'New account label' });
    await userEvent.clear(input);
    await userEvent.type(input, 'New Label');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'New account label' })).toBeNull());
    expect(screen.getByText('New Label')).toBeInTheDocument();
    expect(screen.queryByText('Test Account')).toBeNull();
  });

  it('shows inline feedback and restores actions when account deletion fails', async () => {
    const source = makeSource();
    const account = makeAccount();

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        ctx.setResult({ sources: [source] });
      }),
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        ctx.setResult({ accounts: [account] });
      }),
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        ctx.setResult({ usage: { fetchedAt: 1_000, windows: [] } });
      }),
      bus.on(AccountManagerSubjects.accounts.remove, (ctx) => {
        expect(ctx.payload).toEqual({ accountId: account.id, clientId: source.clientId });
        ctx.setResult({ success: false });
      }),
    );

    render(createElement(AccountsPage), { wrapper: makeBusWrapper(bus) });

    await screen.findByText('Test Provider');
    await userEvent.click(screen.getByRole('button', { name: 'Delete Test Account' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm delete Test Account' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unable to delete account.'));
    expect(screen.getByRole('button', { name: 'Delete Test Account' })).toBeEnabled();
  });

  it('restores delete actions after a successful delete even when refresh returns stale data', async () => {
    const source = makeSource();
    const account = makeAccount();

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        ctx.setResult({ sources: [source] });
      }),
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        ctx.setResult({ accounts: [account] });
      }),
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        ctx.setResult({ usage: { fetchedAt: 1_000, windows: [] } });
      }),
      bus.on(AccountManagerSubjects.accounts.remove, (ctx) => {
        expect(ctx.payload).toEqual({ accountId: account.id, clientId: source.clientId });
        ctx.setResult({ success: true });
      }),
    );

    render(createElement(AccountsPage), { wrapper: makeBusWrapper(bus) });

    await screen.findByText('Test Provider');
    await userEvent.click(screen.getByRole('button', { name: 'Delete Test Account' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm delete Test Account' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm delete Test Account' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Delete Test Account' })).toBeEnabled();
  });
});
