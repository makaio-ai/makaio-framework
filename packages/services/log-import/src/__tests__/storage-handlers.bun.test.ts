/**
 * Tests for Drizzle-based log-import storage handlers.
 *
 * Verifies the real handler implementations against an in-memory SQLite database:
 * - `getMode`: single global-row lookup → falls back to 'disabled' when absent
 * - `setMode`: upsert semantics, idempotency
 * - `listSettings`: returns all global adapter rows
 *
 * All tests use real bus requests routed to real Drizzle handlers — no mocks.
 *
 * Project-scoped two-tier fallback is tested separately in
 * host-owned scoped override handler.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { LogImportSubjects } from '../namespace.js';
import { createTempDb } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { registerDrizzleLogImportStorage } from '../storage/handlers.js';

const CREATE_LOG_IMPORT_SETTINGS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS log_import_settings (
    adapter_name TEXT PRIMARY KEY NOT NULL,
    mode         TEXT NOT NULL DEFAULT 'disabled',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  )
`;

/**
 * Creates an isolated test database with log-import storage handlers registered.
 * @returns cleanup function
 */
async function createTestDb(): Promise<() => void> {
  const { db, cleanup: cleanupDb } = await createTempDb('log-import-settings');

  await db.run(CREATE_LOG_IMPORT_SETTINGS_TABLE_SQL);

  const handlerCleanup = registerDrizzleLogImportStorage(MakaioBus, db, makeStubExtensionContext(MakaioBus));
  return () => {
    handlerCleanup();
    cleanupDb();
  };
}

describe('registerDrizzleLogImportStorage', () => {
  let cleanup: () => void;

  beforeEach(async () => {
    cleanup = await createTestDb();
  });

  afterEach(() => {
    cleanup();
  });

  // ---------------------------------------------------------------------------
  // getMode
  // ---------------------------------------------------------------------------

  describe('getMode', () => {
    it('returns "disabled" when no row exists for the adapter', async () => {
      const { mode } = await MakaioBus.request(LogImportSubjects.getMode, {
        adapterName: 'claude-code',
      });

      expect(mode).toBe('disabled');
    });

    it('returns the persisted mode for the adapter', async () => {
      await MakaioBus.request(LogImportSubjects.setMode, {
        adapterName: 'claude-code',
        mode: 'import',
      });

      const { mode } = await MakaioBus.request(LogImportSubjects.getMode, {
        adapterName: 'claude-code',
      });

      expect(mode).toBe('import');
    });

    it('does not cross adapter boundaries when multiple adapters have rows', async () => {
      await MakaioBus.request(LogImportSubjects.setMode, {
        adapterName: 'claude-code',
        mode: 'import',
      });

      await MakaioBus.request(LogImportSubjects.setMode, {
        adapterName: 'openai',
        mode: 'discover',
      });

      const { mode: claudeMode } = await MakaioBus.request(LogImportSubjects.getMode, {
        adapterName: 'claude-code',
      });

      const { mode: openaiMode } = await MakaioBus.request(LogImportSubjects.getMode, {
        adapterName: 'openai',
      });

      expect(claudeMode).toBe('import');
      expect(openaiMode).toBe('discover');
    });

    it('returns "disabled" when a different adapter has a row', async () => {
      await MakaioBus.request(LogImportSubjects.setMode, {
        adapterName: 'other-adapter',
        mode: 'import',
      });

      const { mode } = await MakaioBus.request(LogImportSubjects.getMode, {
        adapterName: 'claude-code',
      });

      expect(mode).toBe('disabled');
    });
  });

  // ---------------------------------------------------------------------------
  // setMode
  // ---------------------------------------------------------------------------

  describe('setMode', () => {
    it('creates a new row and reports success', async () => {
      const { success } = await MakaioBus.request(LogImportSubjects.setMode, {
        adapterName: 'claude-code',
        mode: 'import',
      });

      expect(success).toBe(true);
    });

    it('updates an existing row (upsert is idempotent)', async () => {
      await MakaioBus.request(LogImportSubjects.setMode, {
        adapterName: 'claude-code',
        mode: 'discover',
      });

      await MakaioBus.request(LogImportSubjects.setMode, {
        adapterName: 'claude-code',
        mode: 'import',
      });

      const { mode } = await MakaioBus.request(LogImportSubjects.getMode, {
        adapterName: 'claude-code',
      });

      expect(mode).toBe('import');
    });

    it('updates only updatedAt (not createdAt) on re-upsert', async () => {
      const nowSpy = spyOn(Date, 'now');
      let currentTime = 1_700_000_000_000;
      nowSpy.mockImplementation(() => currentTime);

      try {
        await MakaioBus.request(LogImportSubjects.setMode, {
          adapterName: 'claude-code',
          mode: 'discover',
        });

        currentTime += 5_000;

        await MakaioBus.request(LogImportSubjects.setMode, {
          adapterName: 'claude-code',
          mode: 'import',
        });

        const { settings } = await MakaioBus.request(LogImportSubjects.listSettings, {});
        const row = settings.find((s) => s.adapterName === 'claude-code');

        expect(row).toBeDefined();
        expect(row!.createdAt).toBe(1_700_000_000_000);
        expect(row!.updatedAt).toBe(1_700_000_005_000);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // listSettings
  // ---------------------------------------------------------------------------

  describe('listSettings', () => {
    it('returns an empty array when no rows exist', async () => {
      const { settings } = await MakaioBus.request(LogImportSubjects.listSettings, {});

      expect(settings).toEqual([]);
    });

    it('returns the persisted row for an adapter', async () => {
      await MakaioBus.request(LogImportSubjects.setMode, {
        adapterName: 'claude-code',
        mode: 'import',
      });

      const { settings } = await MakaioBus.request(LogImportSubjects.listSettings, {});

      expect(settings).toHaveLength(1);
      expect(settings[0].adapterName).toBe('claude-code');
      expect(settings[0].mode).toBe('import');
    });

    it('returns rows for multiple adapters', async () => {
      await MakaioBus.request(LogImportSubjects.setMode, {
        adapterName: 'claude-code',
        mode: 'import',
      });

      await MakaioBus.request(LogImportSubjects.setMode, {
        adapterName: 'openai',
        mode: 'discover',
      });

      const { settings } = await MakaioBus.request(LogImportSubjects.listSettings, {});

      expect(settings).toHaveLength(2);

      const adapterNames = settings.map((s) => s.adapterName).sort();
      expect(adapterNames).toEqual(['claude-code', 'openai']);
    });

    it('includes timestamps on returned rows', async () => {
      await MakaioBus.request(LogImportSubjects.setMode, {
        adapterName: 'claude-code',
        mode: 'import',
      });

      const { settings } = await MakaioBus.request(LogImportSubjects.listSettings, {});

      expect(settings[0].createdAt).toBeTypeOf('number');
      expect(settings[0].updatedAt).toBeTypeOf('number');
      expect(settings[0].createdAt).toBeGreaterThan(0);
    });
  });
});
