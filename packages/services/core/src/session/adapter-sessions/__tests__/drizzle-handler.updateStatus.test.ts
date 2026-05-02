import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSessionStorageSubjects } from '../namespace.js';
import { useAdapterSessionTestLifecycle } from './shared.js';

describe('registerDrizzleAdapterSessionStorage', () => {
  useAdapterSessionTestLifecycle({ beforeEach, afterEach });

  describe('updateStatus', () => {
    it('should update status to imported', async () => {
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-status-1',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });

      const result = await MakaioBus.request(AdapterSessionStorageSubjects.updateStatus, {
        adapterSessionId: 'cc-status-1',
        status: 'imported',
      });

      expect(result.success).toBe(true);

      const getResult = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-status-1',
      });
      expect(getResult.session?.status).toBe('imported');
    });

    it('should update status to live', async () => {
      await MakaioBus.request(AdapterSessionStorageSubjects.upsert, {
        adapterSessionId: 'cc-status-2',
        adapterName: 'claude-code',
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: 'root',
        model: null,
        cwd: null,
      });

      const result = await MakaioBus.request(AdapterSessionStorageSubjects.updateStatus, {
        adapterSessionId: 'cc-status-2',
        status: 'live',
      });

      expect(result.success).toBe(true);

      const getResult = await MakaioBus.request(AdapterSessionStorageSubjects.get, {
        adapterSessionId: 'cc-status-2',
      });
      expect(getResult.session?.status).toBe('live');
    });

    it('should return false for non-existent session', async () => {
      const result = await MakaioBus.request(AdapterSessionStorageSubjects.updateStatus, {
        adapterSessionId: 'non-existent',
        status: 'imported',
      });

      expect(result.success).toBe(false);
    });
  });
});
