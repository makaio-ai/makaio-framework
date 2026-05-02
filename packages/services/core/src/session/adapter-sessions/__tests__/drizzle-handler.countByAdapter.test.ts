import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSessionStorageSubjects } from '../namespace.js';
import { useAdapterSessionTestLifecycle } from './shared.js';

describe('registerDrizzleAdapterSessionStorage', () => {
  useAdapterSessionTestLifecycle({ beforeEach, afterEach });

  describe('countByAdapter', () => {
    it('should return zero counts for empty adapter', async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.countByAdapter, {
        adapterName: 'claude-code',
      });

      expect(result.total).toBe(0);
      expect(result.imported).toBe(0);
      expect(result.discovered).toBe(0);
    });

    it('should count sessions by status', async () => {
      // Create some sessions
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-count-1',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-count-2',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-count-3',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });

      // Mark one as imported
      await MakaioBus.request(AdapterSessionStorageSubjects.updateStatus, {
        adapterSessionId: 'cc-count-1',
        status: 'imported',
      });

      const result = await MakaioBus.request(AdapterSessionStorageSubjects.countByAdapter, {
        adapterName: 'claude-code',
      });

      expect(result.total).toBe(3);
      expect(result.imported).toBe(1);
      expect(result.discovered).toBe(2);
    });

    it('counts tracking sessions as imported', async () => {
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-tracking-1',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-imported-1',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });

      await MakaioBus.request(AdapterSessionStorageSubjects.updateStatus, {
        adapterSessionId: 'cc-tracking-1',
        status: 'tracking',
      });
      await MakaioBus.request(AdapterSessionStorageSubjects.updateStatus, {
        adapterSessionId: 'cc-imported-1',
        status: 'imported',
      });

      const result = await MakaioBus.request(AdapterSessionStorageSubjects.countByAdapter, {
        adapterName: 'claude-code',
      });

      expect(result.total).toBe(2);
      expect(result.imported).toBe(2);
      expect(result.discovered).toBe(0);
    });

    it('should only count sessions for the specified adapter', async () => {
      // Create sessions for different adapters
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-count-a1',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'other-count-1',
        adapterName: 'other-adapter',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });

      const ccResult = await MakaioBus.request(AdapterSessionStorageSubjects.countByAdapter, {
        adapterName: 'claude-code',
      });

      const otherResult = await MakaioBus.request(AdapterSessionStorageSubjects.countByAdapter, {
        adapterName: 'other-adapter',
      });

      expect(ccResult.total).toBe(1);
      expect(otherResult.total).toBe(1);
    });
  });
});
