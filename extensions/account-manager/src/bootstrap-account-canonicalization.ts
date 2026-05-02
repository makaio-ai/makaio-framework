import type { StoredAccount } from './interfaces/account-store.js';
import { extractCredentialExpiry } from './handlers/extract-credential-expiry.js';

/**
 * Canonical bootstrap state for one client's stored accounts.
 */
export interface CanonicalBootstrapAccounts {
  /** Canonical surviving accounts after duplicate collapse and active normalization. */
  accounts: StoredAccount[];
  /** Stable account ids removed during duplicate collapse. */
  removedAccountIds: string[];
  /** Canonical surviving id for every original account id. */
  canonicalAccountIdBySourceId: ReadonlyMap<string, string>;
}

/**
 * Collapses bootstrap duplicate clusters and normalizes active state.
 *
 * Migration and startup dedup both use this helper so they converge on the
 * same surviving account ids before any temporal bootstrap row is written.
 * @param accounts - Stored accounts for one client
 * @param now - Current epoch milliseconds used for expiry comparisons
 * @returns Canonical survivor set plus removed duplicate ids
 */
export function canonicalizeBootstrapAccounts(
  accounts: readonly StoredAccount[],
  now: number = Date.now(),
): CanonicalBootstrapAccounts {
  const survivors = accounts.map(cloneStoredAccount);
  const removedAccountIds = new Set<string>();
  const canonicalAccountIdBySourceId = new Map<string, string>();

  for (const group of findDuplicateGroups(survivors)) {
    const survivor = group.reduce((best, candidate) => pickSurvivor(best, candidate, now));
    mergeGroupState(survivor, group);

    for (const account of group) {
      canonicalAccountIdBySourceId.set(account.id, survivor.id);
      if (account.id === survivor.id) {
        continue;
      }
      removedAccountIds.add(account.id);
    }
  }

  const dedupedAccounts = survivors.filter((account) => !removedAccountIds.has(account.id));
  for (const account of dedupedAccounts) {
    canonicalAccountIdBySourceId.set(account.id, account.id);
  }
  normalizeActiveAccounts(dedupedAccounts);

  return {
    accounts: dedupedAccounts,
    removedAccountIds: [...removedAccountIds],
    canonicalAccountIdBySourceId,
  };
}

/**
 * Clones one stored account so canonicalization never mutates caller-owned state.
 * @param account - Stored account to clone
 * @returns Detached stored account copy
 */
function cloneStoredAccount(account: StoredAccount): StoredAccount {
  return structuredClone(account);
}

/**
 * Ensures at most one canonical survivor remains active.
 * @param accounts - Canonical surviving accounts for one client
 */
function normalizeActiveAccounts(accounts: StoredAccount[]): void {
  const activeAccounts = accounts.filter((account) => account.active);
  if (activeAccounts.length <= 1) {
    return;
  }

  activeAccounts.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  for (let i = 1; i < activeAccounts.length; i++) {
    activeAccounts[i].active = false;
  }
}

/**
 * Groups duplicate accounts into connected components.
 * @param accounts - Stored accounts for one client
 * @returns Duplicate groups containing at least two connected accounts
 */
function findDuplicateGroups(accounts: readonly StoredAccount[]): StoredAccount[][] {
  const groups: StoredAccount[][] = [];
  const visited = new Set<string>();

  for (const account of accounts) {
    if (visited.has(account.id)) {
      continue;
    }

    const queue = [account];
    const component: StoredAccount[] = [];
    visited.add(account.id);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      component.push(current);

      for (const candidate of accounts) {
        if (visited.has(candidate.id) || !areBootstrapDuplicates(current, candidate)) {
          continue;
        }

        visited.add(candidate.id);
        queue.push(candidate);
      }
    }

    if (component.length > 1) {
      groups.push(component);
    }
  }

  return groups;
}

/**
 * Returns whether two accounts belong to the same bootstrap duplicate cluster.
 * @param a - First candidate account
 * @param b - Second candidate account
 * @returns Whether the accounts should be merged together
 */
function areBootstrapDuplicates(a: StoredAccount, b: StoredAccount): boolean {
  return (
    a.id !== b.id &&
    ((a.fingerprint.length > 0 && b.fingerprint.length > 0 && a.fingerprint === b.fingerprint) ||
      (a.fingerprint.length > 0 && a.fingerprint === b.id) ||
      (b.fingerprint.length > 0 && b.fingerprint === a.id) ||
      a.credential.token === b.credential.token)
  );
}

/**
 * Merges user-visible state from a duplicate cluster into the chosen survivor.
 * @param survivor - Canonical account that will remain after duplicate collapse
 * @param group - Duplicate accounts contributing merged state
 */
function mergeGroupState(survivor: StoredAccount, group: StoredAccount[]): void {
  survivor.lastSeenAt = Math.max(...group.map((account) => account.lastSeenAt));
  survivor.detectedAt = Math.min(...group.map((account) => account.detectedAt));
  survivor.label = survivor.label || group.find((account) => !!account.label)?.label;
  survivor.active = survivor.active || group.some((account) => account.active);
}

/**
 * Chooses the canonical survivor for one duplicate pair.
 * @param a - First duplicate candidate
 * @param b - Second duplicate candidate
 * @param now - Current epoch milliseconds used for expiry comparisons
 * @returns The account that should survive the merge
 */
function pickSurvivor(a: StoredAccount, b: StoredAccount, now: number): StoredAccount {
  const expiresA = extractCredentialExpiry(a.credential.token);
  const expiresB = extractCredentialExpiry(b.credential.token);

  const validA = expiresA === null || expiresA > now;
  const validB = expiresB === null || expiresB > now;

  if (validA && !validB) {
    return a;
  }
  if (validB && !validA) {
    return b;
  }

  return a.lastSeenAt >= b.lastSeenAt ? a : b;
}
