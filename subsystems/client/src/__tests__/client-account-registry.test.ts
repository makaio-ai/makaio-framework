import { beforeEach, describe, expect, it } from 'vitest';
import { ClientAccountRegistry } from '../client-account-registry.js';

describe('ClientAccountRegistry', () => {
  let registry: ClientAccountRegistry;

  beforeEach(() => {
    registry = new ClientAccountRegistry();
  });

  // Explicit upsertAccount calls per test (not extracted into helpers) keep
  // each test self-contained — the setup IS the specification under test.
  describe('upsertAccount — strong identifiers', () => {
    it('returns a stable clientAccountId for the first observed strong identifier', () => {
      const result = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' }],
      });

      expect(result.clientAccountId).toMatch(/^client-account-\d+$/);
      expect(result.mergedAccountIds).toEqual([]);
    });

    it('reuses the same clientAccountId when the same strong identifier is observed again', () => {
      const first = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' }],
      });

      const second = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' }],
      });

      expect(second.clientAccountId).toBe(first.clientAccountId);
      expect(second.mergedAccountIds).toEqual([]);
    });

    it('creates different clientAccountIds for different strong identifier values', () => {
      const first = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' }],
      });

      const second = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-2:org-2', strength: 'strong' }],
      });

      expect(second.clientAccountId).not.toBe(first.clientAccountId);
    });

    it('creates different clientAccountIds for the same identifier value under different schemes', () => {
      const first = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'strong' }],
      });

      const second = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'username', value: 'user@example.com', strength: 'strong' }],
      });

      expect(second.clientAccountId).not.toBe(first.clientAccountId);
    });
  });

  describe('upsertAccount — alias identifiers', () => {
    it('creates an account for a first alias identifier observation', () => {
      const result = registry.upsertAccount({
        clientId: 'codex',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
      });

      expect(result.clientAccountId).toMatch(/^client-account-\d+$/);
      expect(result.mergedAccountIds).toEqual([]);
    });

    it('reuses the same clientAccountId for a repeated alias identifier', () => {
      const first = registry.upsertAccount({
        clientId: 'codex',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
      });

      const second = registry.upsertAccount({
        clientId: 'codex',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
      });

      expect(second.clientAccountId).toBe(first.clientAccountId);
    });

    it('creates different clientAccountIds for different alias identifier values', () => {
      const first = registry.upsertAccount({
        clientId: 'codex',
        identifiers: [{ scheme: 'email', value: 'alice@example.com', strength: 'alias' }],
      });

      const second = registry.upsertAccount({
        clientId: 'codex',
        identifiers: [{ scheme: 'email', value: 'bob@example.com', strength: 'alias' }],
      });

      expect(second.clientAccountId).not.toBe(first.clientAccountId);
    });

    it('chooses the lowest-sequence account when two known aliases are presented together', () => {
      // Create two distinct alias-only accounts
      const first = registry.upsertAccount({
        clientId: 'codex',
        identifiers: [{ scheme: 'email', value: 'alice@example.com', strength: 'alias' }],
      });
      const second = registry.upsertAccount({
        clientId: 'codex',
        identifiers: [{ scheme: 'email', value: 'bob@example.com', strength: 'alias' }],
      });

      expect(first.clientAccountId).not.toBe(second.clientAccountId);

      // Now present both aliases together: the registry should pick the lowest-sequence one
      const merged = registry.upsertAccount({
        clientId: 'codex',
        identifiers: [
          { scheme: 'email', value: 'alice@example.com', strength: 'alias' },
          { scheme: 'email', value: 'bob@example.com', strength: 'alias' },
        ],
      });

      // The canonical should be the first (lowest sequence)
      expect(merged.clientAccountId).toBe(first.clientAccountId);
    });
  });

  describe('upsertAccount — cross-client isolation', () => {
    it('does not share accounts across different clientIds with the same identifier value', () => {
      const claudeCodeResult = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'email', value: 'shared@example.com', strength: 'strong' }],
      });

      const codexResult = registry.upsertAccount({
        clientId: 'codex',
        identifiers: [{ scheme: 'email', value: 'shared@example.com', strength: 'strong' }],
      });

      expect(claudeCodeResult.clientAccountId).not.toBe(codexResult.clientAccountId);
    });

    it('does not merge alias accounts from different clientIds even if identifier values match', () => {
      const clientA = registry.upsertAccount({
        clientId: 'client-a',
        identifiers: [{ scheme: 'username', value: 'shared-user', strength: 'alias' }],
      });

      const clientB = registry.upsertAccount({
        clientId: 'client-b',
        identifiers: [{ scheme: 'username', value: 'shared-user', strength: 'alias' }],
      });

      expect(clientA.clientAccountId).not.toBe(clientB.clientAccountId);
      expect(clientA.mergedAccountIds).toEqual([]);
      expect(clientB.mergedAccountIds).toEqual([]);
    });
  });

  describe('upsertAccount — display label', () => {
    it('retains the first non-empty display label', () => {
      const result = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1', strength: 'strong' }],
        displayLabel: 'My Account',
      });

      expect(result.displayLabel).toBe('My Account');
    });

    it('trims whitespace from display labels', () => {
      const result = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1', strength: 'strong' }],
        displayLabel: '  My Account  ',
      });

      expect(result.displayLabel).toBe('My Account');
    });

    it('overwrites the label with the latest non-empty label (latest wins)', () => {
      registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1', strength: 'strong' }],
        displayLabel: 'First Label',
      });

      const second = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1', strength: 'strong' }],
        displayLabel: 'Updated Label',
      });

      expect(second.displayLabel).toBe('Updated Label');
    });

    it('does not overwrite an existing label with a whitespace-only label', () => {
      registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1', strength: 'strong' }],
        displayLabel: 'Kept Label',
      });

      const second = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1', strength: 'strong' }],
        displayLabel: '   ',
      });

      expect(second.displayLabel).toBe('Kept Label');
    });

    it('returns undefined for displayLabel when none has been supplied', () => {
      const result = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1', strength: 'strong' }],
      });

      expect(result.displayLabel).toBeUndefined();
    });
  });

  describe('upsertAccount — merge on strong evidence', () => {
    it('merges an alias-only account into the strong account when combined identifiers are presented', () => {
      const aliasResult = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
      });

      const strongResult = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' }],
      });

      // The two accounts are distinct at this point
      expect(aliasResult.clientAccountId).not.toBe(strongResult.clientAccountId);

      // Presenting both identifiers together triggers a merge
      const mergedResult = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [
          { scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' },
          { scheme: 'email', value: 'user@example.com', strength: 'alias' },
        ],
      });

      expect(mergedResult.clientAccountId).toBe(strongResult.clientAccountId);
      expect(mergedResult.mergedAccountIds).toContain(aliasResult.clientAccountId);
    });

    it('subsequent observations of the alias alone resolve to the canonical strong account after a merge', () => {
      // Establish separate accounts
      const aliasResult = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
      });
      const strongResult = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' }],
      });

      // Trigger the merge
      registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [
          { scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' },
          { scheme: 'email', value: 'user@example.com', strength: 'alias' },
        ],
      });

      // Now the alias alone should resolve to the strong account's canonical ID
      const afterMerge = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
      });

      expect(afterMerge.clientAccountId).toBe(strongResult.clientAccountId);
      expect(afterMerge.clientAccountId).not.toBe(aliasResult.clientAccountId);
    });

    it('does not populate mergedAccountIds when no merge is necessary', () => {
      const result = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' }],
      });

      const second = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' }],
      });

      expect(result.mergedAccountIds).toEqual([]);
      expect(second.mergedAccountIds).toEqual([]);
    });

    it('merges multiple alias accounts into the strong account simultaneously', () => {
      const alias1 = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'email', value: 'user@example.com', strength: 'alias' }],
      });
      const alias2 = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'username', value: 'jdoe', strength: 'alias' }],
      });
      const strong = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' }],
      });

      const merged = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [
          { scheme: 'account-uuid', value: 'acct-1:org-1', strength: 'strong' },
          { scheme: 'email', value: 'user@example.com', strength: 'alias' },
          { scheme: 'username', value: 'jdoe', strength: 'alias' },
        ],
      });

      expect(merged.clientAccountId).toBe(strong.clientAccountId);
      expect(merged.mergedAccountIds).toContain(alias1.clientAccountId);
      expect(merged.mergedAccountIds).toContain(alias2.clientAccountId);
    });
  });

  describe('clear', () => {
    it('removes all accounts so subsequent upserts start from a fresh state', () => {
      const before = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-before-clear', strength: 'strong' }],
      });

      registry.clear();

      const after = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-after-clear', strength: 'strong' }],
      });
      const reobservedBefore = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'account-uuid', value: 'acct-before-clear', strength: 'strong' }],
      });

      // The old identifier must be re-observed as new state rather than
      // resolving through stale pre-clear identifier mappings.
      expect(after.clientAccountId).toBe('client-account-1');
      expect(before.clientAccountId).toBe('client-account-1');
      expect(reobservedBefore.clientAccountId).toBe('client-account-2');
      expect(reobservedBefore.clientAccountId).not.toBe(after.clientAccountId);
      expect(reobservedBefore.mergedAccountIds).toEqual([]);
    });

    it('generates account IDs from sequence 1 again after clear', () => {
      registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'email', value: 'a@example.com', strength: 'alias' }],
      });
      registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'email', value: 'b@example.com', strength: 'alias' }],
      });

      registry.clear();

      const fresh = registry.upsertAccount({
        clientId: 'claude-code',
        identifiers: [{ scheme: 'email', value: 'a@example.com', strength: 'alias' }],
      });

      expect(fresh.clientAccountId).toBe('client-account-1');
    });
  });
});
