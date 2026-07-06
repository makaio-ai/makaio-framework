import { describe, it, expect } from 'vitest';

import { LogImportSchemas } from '../schemas.js';

const { request, response } = LogImportSchemas.importFile;

describe('log-import.importFile schemas', () => {
  describe('request', () => {
    it('accepts a minimal request without ingestionMarker', () => {
      const parsed = request.safeParse({
        filePath: '/home/user/.claude/projects/session.jsonl',
        adapterName: 'claude-code-cli',
      });
      expect(parsed.success).toBe(true);
    });

    it('accepts both ingestion markers', () => {
      for (const ingestionMarker of ['live', 'backfill']) {
        const parsed = request.safeParse({
          filePath: '/tmp/session.jsonl',
          adapterName: 'claude-code-cli',
          ingestionMarker,
        });
        expect(parsed.success).toBe(true);
      }
    });

    it('rejects unknown ingestion markers and missing fields', () => {
      expect(
        request.safeParse({ filePath: '/tmp/session.jsonl', adapterName: 'x', ingestionMarker: 'imported' }).success,
      ).toBe(false);
      expect(request.safeParse({ filePath: '/tmp/session.jsonl' }).success).toBe(false);
      expect(request.safeParse({ adapterName: 'x' }).success).toBe(false);
    });
  });

  describe('response', () => {
    it('accepts a graceful-absence skip shape', () => {
      const parsed = response.safeParse({ status: 'skipped', reason: 'no-importer' });
      expect(parsed.success).toBe(true);
    });

    it('accepts a file-missing skip shape', () => {
      const parsed = response.safeParse({ status: 'skipped', reason: 'file-missing' });
      expect(parsed.success).toBe(true);
    });

    it('accepts a full imported shape', () => {
      const parsed = response.safeParse({
        status: 'imported',
        sessionId: 'sess-1',
        messageCount: 12,
        turnCount: 3,
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects incomplete imported and skipped shapes', () => {
      expect(response.safeParse({ status: 'imported' }).success).toBe(false);
      expect(response.safeParse({ status: 'skipped' }).success).toBe(false);
    });

    it('rejects unknown status values', () => {
      expect(response.safeParse({ status: 'failed' }).success).toBe(false);
    });
  });
});
