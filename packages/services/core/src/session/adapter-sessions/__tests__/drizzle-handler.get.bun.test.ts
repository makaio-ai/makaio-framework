import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSessionStorageSubjects } from '../namespace.js';
import { useAdapterSessionTestLifecycle } from './shared.js';

describe('registerDrizzleAdapterSessionStorage', () => {
  useAdapterSessionTestLifecycle({ beforeEach, afterEach });

  describe('get', () => {
    it('should retrieve adapter session by ID', async () => {
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-get-1',
        adapterName: 'claude-code',
        parentAdapterSessionId: 'cc-parent',
        forkPointMessageId: 'msg-fork',
        kind: 'fork',
        model: 'claude-3-opus',
        cwd: '/test/path',
      });

      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-get-1',
      });

      expect(result.session).not.toBeNull();
      expect(result.session?.adapterSessionId).toBe('cc-get-1');
      expect(result.session?.adapterName).toBe('claude-code');
      expect(result.session?.parentAdapterSessionId).toBe('cc-parent');
      expect(result.session?.forkPointMessageId).toBe('msg-fork');
      expect(result.session?.kind).toBe('fork');
      expect(result.session?.model).toBe('claude-3-opus');
      expect(result.session?.cwd).toBe('/test/path');
      expect(result.session?.status).toBe('discovered');
      expect(typeof result.session?.discoveredAt).toBe('number');
      expect(typeof result.session?.startedAt).toBe('number');
    });

    it('should return null for non-existent session', async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'non-existent',
      });

      expect(result.session).toBeNull();
    });
  });
});
