/**
 * Unit tests for the fork lineage sniff helper.
 *
 * Tests the pure backward-scanning detection core ({@link sniffForkLineage})
 * with realistic JSONL line shapes derived from the Claude Code transcript
 * format, plus the bounded tail-read I/O wrapper
 * ({@link sniffTranscriptFork}) against real temp files.
 * @packageDocumentation
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sniffForkLineage, sniffTranscriptFork, SNIFF_MAX_BYTES } from '../fork-sniff.js';

/** Child's own session ID as reported by the hook payload. */
const CHILD_SESSION_ID = 'bd59a5d5-1be4-4b1c-95f9-0f26bd67bec1';
/** Parent session ID kept on the fork-point user message. */
const PARENT_SESSION_ID = 'b94c6d71-788a-474c-9000-9864df18aa64';

/**
 * Build a minimal user-type JSONL line.
 * @param sessionId - Session ID to embed in the record
 * @param uuid - Message UUID
 * @returns JSON string matching Claude Code transcript format
 */
function userLine(sessionId: string, uuid = 'msg-001'): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: '/home/user/project',
    sessionId,
    version: '2.0.76',
    gitBranch: 'main',
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    uuid,
    timestamp: '2025-12-23T16:42:09.090Z',
  });
}

/**
 * Build a minimal assistant-type JSONL line.
 * @param sessionId - Session ID to embed in the record
 * @param uuid - Message UUID
 * @returns JSON string matching Claude Code transcript format
 */
function assistantLine(sessionId: string, uuid = 'msg-002'): string {
  return JSON.stringify({
    parentUuid: 'msg-001',
    isSidechain: false,
    cwd: '/home/user/project',
    sessionId,
    version: '2.0.76',
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
    uuid,
    timestamp: '2025-12-23T16:42:10.000Z',
  });
}

/**
 * Build a file-history-snapshot JSONL line (non-message type).
 * @returns JSON string matching Claude Code transcript format
 */
function snapshotLine(): string {
  return JSON.stringify({
    type: 'file-history-snapshot',
    messageId: 'msg-001',
    snapshot: { messageId: 'msg-001', trackedFileBackups: {}, timestamp: '2025-12-23T16:42:09.095Z' },
    isSnapshotUpdate: false,
  });
}

describe('sniffForkLineage', () => {
  describe('fresh fork detected (last user record is foreign)', () => {
    it('returns the parent when the tail ends with a foreign user record and trailing own assistant records', () => {
      // Mirrors the real fork_forked_forked_session.jsonl fixture shape at
      // fork time: Claude Code rewrites inherited records to the CHILD's
      // sessionId, and only the fork-point user record keeps the parent's
      // ID.  The transcript therefore reads own → own → FOREIGN user →
      // own assistant records, with no post-fork own user record yet.
      const lines = [
        snapshotLine(),
        userLine(CHILD_SESSION_ID, 'inherited-rewritten-user'),
        assistantLine(CHILD_SESSION_ID, 'inherited-rewritten-assistant'),
        userLine(PARENT_SESSION_ID, 'fork-point-user'),
        assistantLine(CHILD_SESSION_ID, 'inherited-rewritten-reply-1'),
        assistantLine(CHILD_SESSION_ID, 'inherited-rewritten-reply-2'),
      ];

      const result = sniffForkLineage(lines, CHILD_SESSION_ID);

      expect(result).toEqual({ parentAdapterSessionId: PARENT_SESSION_ID });
    });

    it('returns the LAST foreign session ID in a nested fork (grandparent → parent → child)', () => {
      // Nested fork: an earlier user record may keep the grandparent's ID,
      // but the actual parent is the LAST user record's sessionId.
      const grandparent = 'aaaaaaaa-0000-0000-0000-000000000000';
      const lines = [
        userLine(grandparent, 'from-grandparent'),
        assistantLine(CHILD_SESSION_ID, 'rewritten-1'),
        userLine(PARENT_SESSION_ID, 'from-parent'),
        assistantLine(CHILD_SESSION_ID, 'rewritten-2'),
      ];

      const result = sniffForkLineage(lines, CHILD_SESSION_ID);

      expect(result).toEqual({ parentAdapterSessionId: PARENT_SESSION_ID });
    });
  });

  describe('own last user record (no fork signal)', () => {
    it('returns undefined on a fork-child restart (own user record after the foreign one)', () => {
      // After the fork child produced its own user message, its restart
      // transcript ends with an own user record.  Lineage was already
      // registered at fork time, so the sniff must stay silent.
      const lines = [
        userLine(CHILD_SESSION_ID, 'inherited-rewritten'),
        userLine(PARENT_SESSION_ID, 'fork-point-user'),
        assistantLine(CHILD_SESSION_ID, 'rewritten-reply'),
        userLine(CHILD_SESSION_ID, 'own-post-fork'),
        assistantLine(CHILD_SESSION_ID, 'own-reply'),
      ];

      const result = sniffForkLineage(lines, CHILD_SESSION_ID);

      expect(result).toBeUndefined();
    });

    it('returns undefined on a plain resume (only own records)', () => {
      const lines = [snapshotLine(), userLine(CHILD_SESSION_ID, 'msg-001'), assistantLine(CHILD_SESSION_ID, 'msg-002')];

      const result = sniffForkLineage(lines, CHILD_SESSION_ID);

      expect(result).toBeUndefined();
    });
  });

  describe('inconclusive window (no user record)', () => {
    it('returns undefined when no user-type records exist in the window', () => {
      // Deferring is safe — the transcript import classifies from the full
      // file, whereas a guessed parent would be permanent under fill-once
      // registration.
      const lines = [snapshotLine(), assistantLine(CHILD_SESSION_ID, 'reply'), snapshotLine()];

      const result = sniffForkLineage(lines, CHILD_SESSION_ID);

      expect(result).toBeUndefined();
    });

    it('returns undefined for an empty line array', () => {
      const result = sniffForkLineage([], CHILD_SESSION_ID);

      expect(result).toBeUndefined();
    });
  });

  describe('malformed / partial lines', () => {
    it('tolerates a partial first line (mid-file tail read fragment)', () => {
      const fragment = userLine(PARENT_SESSION_ID, 'cut-off').slice(300);
      const lines = [fragment, userLine(PARENT_SESSION_ID, 'fork-point'), assistantLine(CHILD_SESSION_ID, 'reply')];

      const result = sniffForkLineage(lines, CHILD_SESSION_ID);

      expect(result).toEqual({ parentAdapterSessionId: PARENT_SESSION_ID });
    });

    it('skips non-JSON and empty lines while scanning backward', () => {
      const lines = [userLine(PARENT_SESSION_ID, 'fork-point'), '', '  ', 'this is not json', '{"truncated'];

      const result = sniffForkLineage(lines, CHILD_SESSION_ID);

      expect(result).toEqual({ parentAdapterSessionId: PARENT_SESSION_ID });
    });

    it('skips user records with missing sessionId', () => {
      const lineNoSessionId = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hello' },
        uuid: 'msg-no-sid',
      });
      const lines = [userLine(PARENT_SESSION_ID, 'fork-point'), lineNoSessionId];

      const result = sniffForkLineage(lines, CHILD_SESSION_ID);

      expect(result).toEqual({ parentAdapterSessionId: PARENT_SESSION_ID });
    });

    it('skips user records with empty-string sessionId', () => {
      const lineEmptySessionId = JSON.stringify({
        type: 'user',
        sessionId: '',
        message: { role: 'user', content: 'hello' },
        uuid: 'msg-empty-sid',
      });
      const lines = [userLine(PARENT_SESSION_ID, 'fork-point'), lineEmptySessionId];

      const result = sniffForkLineage(lines, CHILD_SESSION_ID);

      expect(result).toEqual({ parentAdapterSessionId: PARENT_SESSION_ID });
    });
  });
});

describe('sniffTranscriptFork (bounded tail read)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fork-sniff-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * Write JSONL lines to a temp transcript file.
   * @param lines - Raw lines to join with newlines
   * @returns Absolute path to the written file
   */
  async function writeTranscript(lines: readonly string[]): Promise<string> {
    const path = join(dir, 'transcript.jsonl');
    await writeFile(path, lines.join('\n') + '\n', 'utf8');
    return path;
  }

  /**
   * Build filler snapshot-like lines totalling at least `bytes` bytes.
   * @param bytes - Minimum combined byte size of the filler lines
   * @returns Array of valid non-user JSONL lines
   */
  function fillerLines(bytes: number): string[] {
    const line = JSON.stringify({ type: 'file-history-snapshot', pad: 'x'.repeat(1024) });
    return Array.from({ length: Math.ceil(bytes / (line.length + 1)) }, () => line);
  }

  it('detects a fresh fork in a small file', async () => {
    const path = await writeTranscript([
      snapshotLine(),
      userLine(CHILD_SESSION_ID, 'inherited-rewritten'),
      userLine(PARENT_SESSION_ID, 'fork-point'),
      assistantLine(CHILD_SESSION_ID, 'rewritten-reply'),
    ]);

    const result = await sniffTranscriptFork(path, CHILD_SESSION_ID);

    expect(result).toEqual({ parentAdapterSessionId: PARENT_SESSION_ID });
  });

  it('detects the decisive record near EOF in a file larger than SNIFF_MAX_BYTES', async () => {
    // The head-anchored predecessor of this sniff would have missed this
    // fork entirely; anchoring the window at EOF makes the byte cap safe.
    const path = await writeTranscript([
      ...fillerLines(SNIFF_MAX_BYTES * 2),
      userLine(PARENT_SESSION_ID, 'fork-point'),
      assistantLine(CHILD_SESSION_ID, 'rewritten-reply'),
    ]);

    const result = await sniffTranscriptFork(path, CHILD_SESSION_ID);

    expect(result).toEqual({ parentAdapterSessionId: PARENT_SESSION_ID });
  });

  it('returns undefined when the only user record lies before the tail window', async () => {
    // The decisive record is outside the bounded window — inconclusive by
    // design; the full transcript import classifies from the whole file.
    const path = await writeTranscript([
      userLine(PARENT_SESSION_ID, 'far-before-window'),
      ...fillerLines(SNIFF_MAX_BYTES * 2),
    ]);

    const result = await sniffTranscriptFork(path, CHILD_SESSION_ID);

    expect(result).toBeUndefined();
  });

  it('returns undefined for a missing file (fail-safe)', async () => {
    const result = await sniffTranscriptFork(join(dir, 'does-not-exist.jsonl'), CHILD_SESSION_ID);

    expect(result).toBeUndefined();
  });

  it('returns undefined for an empty file', async () => {
    const path = join(dir, 'empty.jsonl');
    await writeFile(path, '', 'utf8');

    const result = await sniffTranscriptFork(path, CHILD_SESSION_ID);

    expect(result).toBeUndefined();
  });
});
