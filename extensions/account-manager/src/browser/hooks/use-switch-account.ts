import { useCallback } from 'react';
import type { IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '@makaio/extension-account-manager/register';

/**
 * Shared `credentials.switch` helper for browser widgets that expose account
 * switching. Centralizes the RPC path and error logging so tray/dashboard
 * surfaces stay aligned when this flow changes.
 * @param bus - Optional bus instance from context.
 * @param logPrefix - Component-specific log prefix for failures.
 * @returns Stable callback that requests an account switch.
 */
export function useSwitchAccount(
  bus: IMakaioBus | null,
  logPrefix: string,
): (clientId: string, accountId: string) => void {
  return useCallback(
    (clientId: string, accountId: string): void => {
      if (!bus) return;
      void bus
        .request(AccountManagerSubjects.credentials.switch, { clientId, accountId })
        .then((result) => {
          if (!result.success) {
            console.error(`${logPrefix} Failed to switch account:`, result.error ?? 'unknown error');
          }
        })
        .catch((err: unknown) => {
          console.error(`${logPrefix} Failed to switch account:`, err);
        });
    },
    [bus, logPrefix],
  );
}
