import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { LogImportSubjects } from '../namespace.js';
import {
  MessageStorageSubjects,
  SessionStorageSubjects,
  registerMemoryMessageStorage,
  registerMemorySessionStorage,
} from '@makaio/services-core/session';
import type { LogImporterRegistration } from '../types.js';
import { importFromFileContent, registerGenericScanHandler } from '../generic-import-handlers.js';
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

    cleanups.push(registerMemorySessionStorage(MakaioBus));

    cleanups.push(
      registerGenericScanHandler(MakaioBus, (adapterName) =>
        adapterName === testAdapterName ? registration : undefined,
      ),
    );

    const result = await MakaioBus.request(LogImportSubjects.scan, { adapterName: testAdapterName });
    expect(result.adapterName).toBe(testAdapterName);
    expect(result.sessionsFound).toBe(1);
    expect(result.newSessions).toBe(1);

    const stored = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId: 'session-1',
      source: testAdapterName,
    });
    expect(stored.session?.adapterSessionId).toBe('session-1');
    expect(stored.session?.source).toBe(testAdapterName);
    expect(stored.session?.importStatus).toBe('discovered');
  });

  it('does not persist content for observed sessions registered as policy-discovered', async () => {
    cleanups.push(registerMemorySessionStorage(MakaioBus));
    cleanups.push(registerMemoryMessageStorage(MakaioBus));

    const { sessionId } = await MakaioBus.request(SessionStorageSubjects.importUpsert, {
      kind: 'root',
      parentAdapterSessionId: null,
      forkPointMessageId: null,
      externalSessionId: 'private-session',
      source: testAdapterName,
      clientId: 'claude-code',
      cwd: '/private',
      logFilePath: '/logs/private-session.jsonl',
      importStatus: 'discovered',
    });

    const importer = createMockImporter({
      parseRecord: () => ({ parsed: true }),
      extractSessionContext: () => ({
        adapterSessionId: 'private-session',
        model: 'claude',
        cwd: '/private',
        sessionEvent: {
          subject: {} as never,
          payload: {
            adapterSessionId: 'private-session',
            kind: 'root',
            parentAdapterSessionId: null,
            forkPointMessageId: null,
            model: 'claude',
            cwd: '/private',
          },
        },
        startedEvent: { subject: {} as never, payload: {} },
        state: {},
      }),
      processLogFile: () => ({
        adapterSessionId: 'private-session',
        sessionEvent: {
          subject: {} as never,
          payload: {
            adapterSessionId: 'private-session',
            kind: 'root' as const,
            parentAdapterSessionId: null,
            forkPointMessageId: null,
            model: 'claude',
            cwd: '/private',
          },
        },
        messageEvents: [],
        messagePayloads: [
          {
            adapterMessageId: 'msg-private-user',
            role: 'user' as const,
            contentText: 'private prompt',
            blocks: [{ type: 'text' as const, content: 'private prompt' }],
            agentId: 'main',
            adapterSessionId: 'private-session',
            timestamp: 1_000,
          },
          {
            adapterMessageId: 'msg-private-assistant',
            role: 'assistant' as const,
            contentText: 'private answer',
            blocks: [{ type: 'text' as const, content: 'private answer' }],
            agentId: 'main',
            adapterSessionId: 'private-session',
            timestamp: 2_000,
          },
        ],
        lineage: {
          kind: 'root' as const,
          parentAdapterSessionId: null,
          forkPointMessageId: null,
        },
      }),
    });

    const result = await importFromFileContent({
      bus: MakaioBus,
      importer,
      content: '{"type":"user"}\n{"type":"assistant"}\n',
      isJsonl: true,
      adapterName: testAdapterName,
      adapterId: 'adapter-private',
      persistedLogFilePath: '/logs/private-session.jsonl',
    });

    expect(result).toEqual({ sessionId, messageCount: 0, turnCount: 0 });
    const { session } = await MakaioBus.request(SessionStorageSubjects.getByAdapterSessionId, {
      adapterSessionId: 'private-session',
      source: testAdapterName,
    });
    expect(session?.importStatus).toBe('discovered');

    const { messages } = await MakaioBus.request(MessageStorageSubjects.getBySession, { sessionId });
    expect(messages).toEqual([]);
  });
});
