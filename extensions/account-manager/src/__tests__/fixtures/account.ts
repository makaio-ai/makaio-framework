import type { Account } from '../../bus/schemas.js';

/**
 * Build a minimal account fixture for account-manager tests.
 * @param overrides - Per-test account overrides.
 * @returns A valid account object.
 */
export function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'account-1',
    label: 'Work',
    metadata: {},
    active: false,
    detectedAt: 0,
    lastSeenAt: 0,
    ...overrides,
  };
}
