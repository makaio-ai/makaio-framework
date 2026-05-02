import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { RawCredential } from '../interfaces/credential-source.js';
import { AccountManager } from '../account-manager.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

/**
 * Creates a test credential with a deterministic fingerprint derived from the token.
 * @param token - Token string to use as the credential payload
 * @param meta - Optional metadata
 * @returns A RawCredential with a computed fingerprint
 */
function _makeCredential(token: string, meta: Record<string, unknown> = {}): RawCredential {
  return {
    token,
    fingerprint: computeFingerprint(token),
    metadata: meta,
  };
}

describe('AccountManager', () => {
  let source: InMemoryCredentialSource;
  let store: InMemoryAccountStore;
  let service: AccountManager;

  beforeEach(async () => {
    vi.useFakeTimers();
    source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    store = new InMemoryAccountStore();
    service = new AccountManager(MakaioBus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    vi.useRealTimers();
  });

  describe('polling — fingerprint dedup via extractCredentialKey', () => {
    it('reconciles an existing account when the fingerprint format changes but the credential key matches', async () => {
      // Simulate a source that emits UUID-based fingerprints when online and
      // hash-based fingerprints when offline, using a stable key derived from
      // the underlying token.
      const underlyingToken = '{"refreshToken":"rt-stable","accessToken":"at-1"}';
      const stableKey = computeFingerprint('rt-stable');

      // Install a credential key extractor that parses the JSON token and hashes
      // the refreshToken — mirrors what ClaudeCodeSource.extractCredentialKey does.
      source.setCredentialKeyExtractor((rawToken) => {
        try {
          const parsed = JSON.parse(rawToken) as Record<string, unknown>;
          const rt = parsed['refreshToken'];
          return typeof rt === 'string' ? computeFingerprint(rt) : null;
        } catch {
          return null;
        }
      });
      source.setCredentialKeyFingerprintMismatchPolicy(
        ({ accountFingerprint, storedCredentialKey, incomingFingerprint, incomingCredentialKey }) =>
          accountFingerprint.includes(':') &&
          storedCredentialKey === incomingCredentialKey &&
          (incomingFingerprint === accountFingerprint || incomingFingerprint === storedCredentialKey),
      );

      // First poll: source returns a UUID-based fingerprint (profile endpoint reachable).
      const uuidFingerprint = 'uuid-abc:org-xyz';
      source.setCredential({ token: underlyingToken, fingerprint: uuidFingerprint, metadata: {} });
      await vi.advanceTimersByTimeAsync(1000);

      // Account is stored with a stable UUID id and the uuid-based fingerprint.
      const before = await store.list('claude-code');
      expect(before).toHaveLength(1);
      expect(before[0].id).toMatch(/^[0-9a-f-]+$/);
      expect(before[0].fingerprint).toBe(uuidFingerprint);
      expect(before[0].active).toBe(true);

      // Capture the stable UUID for later assertions.
      const stableAccountId = before[0].id;

      // Manually set a label and record detectedAt to verify carry-over.
      await store.upsert('claude-code', {
        ...before[0],
        label: 'Work',
      });
      const detectedAtBefore = before[0].detectedAt;

      // After server restart the access token is expired, so the profile
      // endpoint fails. The source now returns a hash-based fingerprint
      // for the same underlying token.
      source.setCredential({ token: underlyingToken, fingerprint: stableKey, metadata: {} });

      const switched: unknown[] = [];
      const detected: unknown[] = [];
      const cleanupSwitched = MakaioBus.on(AccountManagerSubjects.credentials.switched, (ctx) => {
        switched.push(ctx.payload);
      });
      const cleanupDetected = MakaioBus.on(AccountManagerSubjects.credentials.detected, (ctx) => {
        detected.push(ctx.payload);
      });

      try {
        await vi.advanceTimersByTimeAsync(1000);

        // Should NOT create a second account — dedup must kick in.
        const after = await store.list('claude-code');
        expect(after).toHaveLength(1);

        // The stable UUID is preserved; only the fingerprint transitions.
        const reconciled = after.find((a) => a.id === stableAccountId);
        expect(reconciled).toBeDefined();
        expect(reconciled?.fingerprint).toBe(stableKey);
        expect(reconciled?.active).toBe(true);

        // Label and detectedAt carry over from the old entry.
        expect(reconciled?.label).toBe('Work');
        expect(reconciled?.detectedAt).toBe(detectedAtBefore);

        // credentials.switched emitted, credentials.detected NOT emitted.
        expect(switched).toHaveLength(1);
        expect(detected).toHaveLength(0);
      } finally {
        cleanupSwitched();
        cleanupDetected();
      }
    });

    it('creates a new account when extractCredentialKey is not implemented', async () => {
      // No extractor installed — source falls back to fingerprint-only matching.
      const underlyingToken = '{"refreshToken":"rt-no-dedup","accessToken":"at-2"}';

      // First credential with UUID fingerprint.
      source.setCredential({ token: underlyingToken, fingerprint: 'uuid-no-dedup:org-1', metadata: {} });
      await vi.advanceTimersByTimeAsync(1000);

      // Second credential with hash fingerprint — same token, different fingerprint.
      const hashFingerprint = computeFingerprint('rt-no-dedup');
      source.setCredential({ token: underlyingToken, fingerprint: hashFingerprint, metadata: {} });

      const detected: unknown[] = [];
      const cleanup = MakaioBus.on(AccountManagerSubjects.credentials.detected, (ctx) => {
        detected.push(ctx.payload);
      });

      try {
        await vi.advanceTimersByTimeAsync(1000);

        // Without dedup, a second account is created.
        const accounts = await store.list('claude-code');
        expect(accounts).toHaveLength(2);
        expect(detected).toHaveLength(1);
      } finally {
        cleanup();
      }
    });
  });
});
