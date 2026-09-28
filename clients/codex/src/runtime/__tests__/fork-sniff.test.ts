/**
 * Tests for the Codex rollout fork-lineage sniff.
 *
 * Covers the pure detection core ({@link sniffRolloutForkLineage}) and the
 * bounded I/O wrapper ({@link sniffRolloutFork}) against real temp files.
 *
 * The synthetic rollout fixtures mirror the on-disk shape Codex writes at the
 * pinned `rust-v0.158.0` source: one JSON object per line, the thread's own
 * metadata record first, ancestor records copied in afterwards.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sniffRolloutFork, sniffRolloutForkLineage, SNIFF_MAX_BYTES } from '../fork-sniff.js';
import { rolloutMetaLine } from './rollout-fixtures.test-support.js';

const CHILD_THREAD_ID = '0199b0d1-1111-7000-8000-000000000001';
const PARENT_THREAD_ID = '0199b0d1-2222-7000-8000-000000000002';
const GRANDPARENT_THREAD_ID = '0199b0d1-3333-7000-8000-000000000003';

/**
 * Build a non-metadata rollout line.
 * @param text - Message text carried by the record
 * @returns Serialized JSONL line
 */
function responseLine(text: string): string {
  return JSON.stringify({
    timestamp: '2026-09-16T23:09:49.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  });
}

describe('sniffRolloutForkLineage (pure core)', () => {
  it('reports the parent when the own session_meta names a foreign fork source', () => {
    const lines = [rolloutMetaLine(CHILD_THREAD_ID, PARENT_THREAD_ID), responseLine('inherited turn')];

    expect(sniffRolloutForkLineage(lines, CHILD_THREAD_ID)).toEqual({
      parentAdapterSessionId: PARENT_THREAD_ID,
    });
  });

  it('returns undefined for a root thread whose session_meta has no fork source', () => {
    const lines = [rolloutMetaLine(CHILD_THREAD_ID), responseLine('first turn')];

    expect(sniffRolloutForkLineage(lines, CHILD_THREAD_ID)).toBeUndefined();
  });

  it('ignores ancestor session_meta records copied in after the own record', () => {
    // A nested fork: the child's own record names its direct parent; the
    // parent's and grandparent's records follow as copied history and must not
    // change the verdict.
    const lines = [
      rolloutMetaLine(CHILD_THREAD_ID, PARENT_THREAD_ID),
      rolloutMetaLine(PARENT_THREAD_ID, GRANDPARENT_THREAD_ID),
      rolloutMetaLine(GRANDPARENT_THREAD_ID),
    ];

    expect(sniffRolloutForkLineage(lines, CHILD_THREAD_ID)).toEqual({
      parentAdapterSessionId: PARENT_THREAD_ID,
    });
  });

  it('returns undefined when the copied ancestor record is the only fork marker', () => {
    // Own record is root; the ancestor record below it belongs to a different
    // thread and must never be read as this thread's lineage.
    const lines = [rolloutMetaLine(CHILD_THREAD_ID), rolloutMetaLine(PARENT_THREAD_ID, GRANDPARENT_THREAD_ID)];

    expect(sniffRolloutForkLineage(lines, CHILD_THREAD_ID)).toBeUndefined();
  });

  it('treats a self-referencing fork source as no signal', () => {
    const lines = [rolloutMetaLine(CHILD_THREAD_ID, CHILD_THREAD_ID)];

    expect(sniffRolloutForkLineage(lines, CHILD_THREAD_ID)).toBeUndefined();
  });

  it('skips blank and malformed lines before the metadata record', () => {
    const lines = ['', '   ', 'not json at all', rolloutMetaLine(CHILD_THREAD_ID, PARENT_THREAD_ID)];

    expect(sniffRolloutForkLineage(lines, CHILD_THREAD_ID)).toEqual({
      parentAdapterSessionId: PARENT_THREAD_ID,
    });
  });

  it('returns undefined when the window holds no session_meta record', () => {
    expect(sniffRolloutForkLineage([responseLine('a'), responseLine('b')], CHILD_THREAD_ID)).toBeUndefined();
  });

  it('returns undefined for an empty window', () => {
    expect(sniffRolloutForkLineage([], CHILD_THREAD_ID)).toBeUndefined();
  });

  it('ignores a non-string fork source', () => {
    const line = JSON.stringify({
      timestamp: '2026-09-16T23:09:48.711Z',
      type: 'session_meta',
      payload: { id: CHILD_THREAD_ID, forked_from_id: 42 },
    });

    expect(sniffRolloutForkLineage([line], CHILD_THREAD_ID)).toBeUndefined();
  });

  it('ignores a session_meta record without a payload object', () => {
    const line = JSON.stringify({ timestamp: '2026-09-16T23:09:48.711Z', type: 'session_meta' });

    expect(sniffRolloutForkLineage([line], CHILD_THREAD_ID)).toBeUndefined();
  });
});

describe('sniffRolloutFork (bounded head read)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codex-fork-sniff-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Write a rollout file into the temp dir.
   * @param name - File name
   * @param lines - JSONL lines to write
   * @returns Absolute path of the written file
   */
  async function writeRollout(name: string, lines: readonly string[]): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
    return path;
  }

  it('detects fork lineage from a real rollout file', async () => {
    const path = await writeRollout('fork.jsonl', [
      rolloutMetaLine(CHILD_THREAD_ID, PARENT_THREAD_ID),
      rolloutMetaLine(PARENT_THREAD_ID),
      responseLine('inherited turn'),
    ]);

    await expect(sniffRolloutFork(path, CHILD_THREAD_ID)).resolves.toEqual({
      parentAdapterSessionId: PARENT_THREAD_ID,
    });
  });

  it('returns undefined for a root rollout file', async () => {
    const path = await writeRollout('root.jsonl', [rolloutMetaLine(CHILD_THREAD_ID), responseLine('first turn')]);

    await expect(sniffRolloutFork(path, CHILD_THREAD_ID)).resolves.toBeUndefined();
  });

  it('returns undefined for a missing file instead of throwing', async () => {
    await expect(sniffRolloutFork(join(dir, 'does-not-exist.jsonl'), CHILD_THREAD_ID)).resolves.toBeUndefined();
  });

  it('returns undefined for an empty file', async () => {
    const path = join(dir, 'empty.jsonl');
    await writeFile(path, '', 'utf8');

    await expect(sniffRolloutFork(path, CHILD_THREAD_ID)).resolves.toBeUndefined();
  });

  it('still finds the metadata record when the file far exceeds the read window', async () => {
    const filler = Array.from({ length: 400 }, (_, i) => responseLine('x'.repeat(512) + String(i)));
    const path = await writeRollout('large.jsonl', [rolloutMetaLine(CHILD_THREAD_ID, PARENT_THREAD_ID), ...filler]);

    await expect(sniffRolloutFork(path, CHILD_THREAD_ID)).resolves.toEqual({
      parentAdapterSessionId: PARENT_THREAD_ID,
    });
  });

  it('fails open when the metadata record is longer than the read window', async () => {
    // A session_meta line past the byte cap is truncated to unparseable JSON;
    // the sniff must report no signal rather than guess a parent.
    const oversized = JSON.stringify({
      timestamp: '2026-09-16T23:09:48.711Z',
      type: 'session_meta',
      payload: {
        id: CHILD_THREAD_ID,
        forked_from_id: PARENT_THREAD_ID,
        base_instructions: { text: 'y'.repeat(SNIFF_MAX_BYTES + 1024) },
      },
    });
    const path = await writeRollout('oversized.jsonl', [oversized, responseLine('turn')]);

    await expect(sniffRolloutFork(path, CHILD_THREAD_ID)).resolves.toBeUndefined();
  });
});
