/**
 * Fork-lineage coverage for `CodexClientSessionService`.
 *
 * Codex `0.158.0` reports a fork child as `SessionStart` with
 * `source: 'fork'` but without a parent id. The service recovers the parent
 * from the rollout head and downgrades to `startMode: 'fresh'` when it cannot.
 * `'startup'` is never sniffed.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/subsystem-client';
import { CodexClientSessionService } from '../codex-client-session-service.js';
import { capturePayloads, emitRawHook, emitRuntimeStarted } from './codex-client-session-service.test-support.js';
import { rolloutMetaLine } from './rollout-fixtures.test-support.js';

describe('CodexClientSessionService', () => {
  let bus: IMakaioBus;
  let service: CodexClientSessionService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new CodexClientSessionService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  describe('fork lineage enrichment', () => {
    const CHILD = '0199b0d1-1111-7000-8000-000000000001';
    const PARENT = '0199b0d1-2222-7000-8000-000000000002';
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'codex-service-fork-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    /**
     * Write a synthetic rollout file whose own metadata record optionally
     * names a fork source, matching the shape Codex writes on disk.
     * @param threadId - Thread id of the rollout owner
     * @param forkedFromId - Parent thread id, omitted for a root thread
     * @returns Absolute path of the written rollout file
     */
    async function writeRollout(threadId: string, forkedFromId?: string): Promise<string> {
      const path = join(dir, `${threadId}.jsonl`);
      await writeFile(path, `${rolloutMetaLine(threadId, forkedFromId)}\n`, 'utf8');
      return path;
    }

    it('keeps startMode fork and adds the parent a fork rollout names', async () => {
      const transcriptPath = await writeRollout(CHILD, PARENT);
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', {
        session_id: CHILD,
        source: 'fork',
        transcript_path: transcriptPath,
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        adapterSessionId: CHILD,
        startMode: 'fork',
        parentAdapterSessionId: PARENT,
        transcriptPath,
      });
    });

    it('downgrades a fork to startMode fresh when the rollout names no fork source', async () => {
      const transcriptPath = await writeRollout(CHILD);
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', {
        session_id: CHILD,
        source: 'fork',
        transcript_path: transcriptPath,
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ startMode: 'fresh' });
      expect(received[0]).not.toHaveProperty('parentAdapterSessionId');
    });

    it('does not sniff a startup session: it stays fresh even when the rollout names a fork source', async () => {
      // Since Codex 0.158.0 'startup' is only ever a brand-new thread.
      const transcriptPath = await writeRollout(CHILD, PARENT);
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', {
        session_id: CHILD,
        source: 'startup',
        transcript_path: transcriptPath,
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ startMode: 'fresh' });
      expect(received[0]).not.toHaveProperty('parentAdapterSessionId');
    });

    it("does not sniff a resume: the rollout is the thread's own file, already registered", async () => {
      // A resumed fork child still shows its original fork source; upgrading it
      // would re-register instead of letting ingestion rebind by session id.
      const transcriptPath = await writeRollout(CHILD, PARENT);
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', {
        session_id: CHILD,
        source: 'resume',
        transcript_path: transcriptPath,
      });
      cleanup();

      expect(received[0]).toMatchObject({ startMode: 'resume' });
      expect(received[0]).not.toHaveProperty('parentAdapterSessionId');
    });

    it('downgrades an ephemeral fork (transcript_path null) to startMode fresh', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: CHILD, source: 'fork', transcript_path: null });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ startMode: 'fresh' });
      expect(received[0]).not.toHaveProperty('transcriptPath');
      expect(received[0]).not.toHaveProperty('parentAdapterSessionId');
    });

    it('downgrades a fork to startMode fresh when the rollout file does not exist', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', {
        session_id: CHILD,
        source: 'fork',
        transcript_path: join(dir, 'missing.jsonl'),
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ startMode: 'fresh' });
      expect(received[0]).not.toHaveProperty('parentAdapterSessionId');
    });

    it('suppresses session.started with source fork for a managed session (suppression runs before enrichment)', async () => {
      const transcriptPath = await writeRollout(CHILD, PARENT);
      await emitRuntimeStarted(bus, { clientRuntimeId: 'rt-fork', adapterSessionId: CHILD });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', {
        session_id: CHILD,
        source: 'fork',
        transcript_path: transcriptPath,
      });
      cleanup();

      expect(received).toHaveLength(0);
    });
  });
});
