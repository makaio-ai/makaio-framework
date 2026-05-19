import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSessionStorageSubjects } from '../namespace.js';
import { useAdapterSessionTestLifecycle } from './shared.js';

describe('registerDrizzleAdapterSessionStorage', () => {
  useAdapterSessionTestLifecycle({ beforeEach, afterEach });

  describe('list', () => {
    it('should return sessions ordered by startedAt DESC (newest first)', async () => {
      const olderStartedAt = Date.now() - 120_000;
      const newerStartedAt = Date.now() - 30_000;

      // Insert the older session first
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-list-older',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
        startedAt: olderStartedAt,
      });

      // Insert the newer session second
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-list-newer',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
        startedAt: newerStartedAt,
      });

      const result = await MakaioBus.request(AdapterSessionStorageSubjects.list, {});

      expect(result.sessions.length).toBeGreaterThanOrEqual(2);

      // Find both sessions in the result
      const newerIdx = result.sessions.findIndex((s) => s.adapterSessionId === 'cc-list-newer');
      const olderIdx = result.sessions.findIndex((s) => s.adapterSessionId === 'cc-list-older');

      expect(newerIdx).not.toBe(-1);
      expect(olderIdx).not.toBe(-1);

      // Newer session must appear before the older one (DESC order)
      expect(newerIdx).toBeLessThan(olderIdx);

      // Verify startedAt values in the response
      expect(result.sessions[newerIdx].startedAt).toBe(newerStartedAt);
      expect(result.sessions[olderIdx].startedAt).toBe(olderStartedAt);
    });
  });
});
