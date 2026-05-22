import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { LogImportSubjects } from '../namespace.js';
import { AdapterSessionStorageSubjects } from '@makaio/services-core/session';
import type { LogImporterRegistration } from '../types.js';
import { registerGenericScanHandler } from '../generic-import-handlers.js';
import { createMockImporter } from './test-helpers.js';

describe('generic-import-handlers', () => {
  const testAdapterName = 'claude-code-cli';
  const cleanups: Array<() => void> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('stores adapterName during scan discovery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'log-import-scan-'));
    tempDirs.push(dir);
    await writeFile(join(dir, 'session.jsonl'), '{"type":"session"}\n', 'utf8');

    const importer = createMockImporter({
      getLogDirectory: () => dir,
      parseRecord: () => ({ parsed: true }),
      extractSessionContext: () => ({
        adapterSessionId: 'session-1',
        model: 'test-model',
        cwd: '/tmp/repo',
        sessionEvent: {
          subject: {} as never,
          payload: {
            adapterSessionId: 'session-1',
            kind: 'root',
            parentAdapterSessionId: null,
            forkPointMessageId: null,
            model: 'test-model',
            cwd: '/tmp/repo',
          },
        },
        startedEvent: { subject: {} as never, payload: {} },
        state: {},
      }),
    });

    const registration: LogImporterRegistration = {
      id: 'adapter-instance-1',
      adapterName: testAdapterName,
      displayName: 'Claude Code',
      source: 'adapter',
      importer,
      logFilePattern: '*.jsonl',
    };

    let storedAdapterName: string | null = null;
    cleanups.push(
      MakaioBus.on(AdapterSessionStorageSubjects.upsert, (ctx) => {
        storedAdapterName = ctx.payload.adapterName;
        ctx.setResult({
          adapterSessionId: ctx.payload.adapterSessionId,
          sessionId: null,
          created: true,
        });
      }),
    );

    cleanups.push(
      registerGenericScanHandler(MakaioBus, (adapterName) =>
        adapterName === testAdapterName ? registration : undefined,
      ),
    );

    const result = await MakaioBus.request(LogImportSubjects.scan, { adapterName: testAdapterName });
    expect(result.adapterName).toBe(testAdapterName);
    expect(result.sessionsFound).toBe(1);
    expect(result.newSessions).toBe(1);
    expect(storedAdapterName).toBe(testAdapterName);
  });
});
