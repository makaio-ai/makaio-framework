/**
 * Fork lineage sniff for Claude Code transcript files.
 *
 * When Claude Code forks a session, the child process receives a new
 * `session_id` and its transcript file contains JSONL lines copied from
 * the parent session.  Claude Code **rewrites** the `sessionId` of most
 * inherited records to the child's own ID during the copy — only specific
 * user-type records keep the parent's ID.  The one reliable signal at
 * fork time is therefore positional, not positional-from-the-start: the
 * **most recent** user record of a freshly forked transcript carries the
 * parent's session ID, because the fork copies the parent's conversation
 * up to (and including) the user message that was forked from, and the
 * child has not produced any user message of its own yet.
 *
 * This module reads a bounded window from the transcript **tail** and
 * scans it backward, enabling the hook normalizer path to distinguish a
 * fork child (`startMode: 'fork'`) from a plain resume
 * (`startMode: 'resume'`) at session-start time.
 *
 * ## Detection invariant
 *
 * The last user-type record in the transcript decides:
 *
 * - **Foreign `sessionId`** → fresh fork.  The transcript importer's own
 *   boundary detector rests on the same premise (a session's most recent
 *   user record carries its own ID once the session has user content), so
 *   a foreign last-user-record uniquely identifies a fork child and its
 *   direct parent — including nested forks, where earlier foreign IDs
 *   belong to grandparents but the *last* one is the actual parent.
 * - **Own `sessionId`** → no fork signal.  Either a plain resume, or a
 *   restart of a fork child whose lineage was already registered at fork
 *   time.
 * - **No user record in the window** → inconclusive; return `undefined`
 *   and defer to the full transcript import.  Fork registration uses
 *   fill-once semantics — a reported parent is never overwritten — so a
 *   guessed parent would be permanently wrong, whereas deferring is safe.
 *
 * Anchoring the window at end-of-file is what makes the rule sound under
 * a byte cap: no user record can exist *after* the window, so the last
 * user record found inside it is the last user record of the file.
 *
 * ## Design principles
 *
 * - **Pure detection core**: {@link sniffForkLineage} operates on an array
 *   of raw JSONL lines and the hook's own session ID.  No I/O, no bus, no
 *   dependencies beyond the language runtime.
 * - **Bounded I/O wrapper**: {@link sniffTranscriptFork} reads at most
 *   {@link SNIFF_MAX_BYTES} from the transcript tail.  The bound prevents
 *   blocking the hook path on large transcript files.
 * - **Fail-safe**: any I/O or parse error falls back to `undefined` (no
 *   fork signal), so hook processing is never blocked by a sniff failure.
 * - **No forkPointMessageId**: that field is enriched later by the full
 *   transcript import (fill-once semantics already implemented in ingestion).
 * @packageDocumentation
 */

import { open } from 'node:fs/promises';

/**
 * Maximum number of bytes to read from the transcript tail for fork
 * detection.  128 KiB covers dozens of JSONL lines (typical user message
 * lines are 200–2000 bytes) while keeping the blocking window small.
 *
 * There is deliberately no separate line cap: the byte bound already
 * limits total parse work, and the backward scan stops at the first
 * user-type record anyway, so even a pathological window of many tiny
 * lines costs at most one pass over 128 KiB.
 */
export const SNIFF_MAX_BYTES = 128 * 1024;

/**
 * Result of the fork lineage sniff.
 *
 * Returned only when a foreign session ID is detected; `undefined` means
 * no fork signal was found.
 */
export interface ForkSniffResult {
  /** Adapter session ID of the parent session. */
  readonly parentAdapterSessionId: string;
}

/**
 * Detect fork lineage from raw JSONL transcript lines.
 *
 * Scans the provided window **backward** from the last line.  The window
 * must be anchored at the end of the transcript (see
 * {@link sniffTranscriptFork}); under that anchoring, the first user-type
 * record found — i.e. the file's last user record — decides:
 *
 * - foreign `sessionId` → fresh fork; that ID is the direct parent.  No
 *   later foreign record can exist because nothing follows the window.
 * - own `sessionId` → `undefined`; the session already has user content
 *   of its own (plain resume, or a fork-child restart whose registration
 *   already happened at fork time).
 * - no user-type record in the window → `undefined`.  Inconclusive; the
 *   full transcript import classifies from the whole file.  Deferring is
 *   safe, whereas a guessed parent would be permanent under the fill-once
 *   registration semantics.
 * @param lines - Raw JSONL lines from the transcript tail (may include
 *   empty strings, partial lines, or non-JSON data)
 * @param hookSessionId - Session ID reported by the hook payload (the
 *   child's own ID)
 * @returns Fork sniff result when the last user record in the window is
 *   foreign, or `undefined` for a plain resume / no signal / inconclusive
 *   window
 */
export function sniffForkLineage(lines: readonly string[], hookSessionId: string): ForkSniffResult | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Malformed or partial line — skip silently.
      continue;
    }

    // Only user-type message records are decisive (the same filter the
    // import-layer fork-detector uses for boundary resolution).
    if (parsed['type'] !== 'user') continue;

    // Claude Code JSONL uses camelCase `sessionId` on message records.
    const lineSessionId = parsed['sessionId'];
    if (typeof lineSessionId !== 'string' || lineSessionId.length === 0) continue;

    return lineSessionId !== hookSessionId ? { parentAdapterSessionId: lineSessionId } : undefined;
  }

  // No user-type record in the window — inconclusive; defer to the full
  // transcript import.
  return undefined;
}

/**
 * Bounded read of a transcript file's tail, split into lines.
 *
 * Stats the file and reads the last `min(size, SNIFF_MAX_BYTES)` bytes in
 * a single positioned read.  When the read starts mid-file, the first
 * "line" is a fragment of a record whose beginning was cut off; the
 * parser would reject it anyway via its JSON try/catch, but it is
 * discarded here explicitly so the returned window contains only lines
 * that start at a real line boundary.
 * @param transcriptPath - Absolute path to the JSONL transcript file
 * @returns Array of raw lines, or `undefined` on I/O error
 */
async function readTranscriptTail(transcriptPath: string): Promise<string[] | undefined> {
  let fh: import('node:fs/promises').FileHandle | undefined;
  try {
    fh = await open(transcriptPath, 'r');
    const { size } = await fh.stat();
    const readLength = Math.min(size, SNIFF_MAX_BYTES);
    const offset = Math.max(0, size - SNIFF_MAX_BYTES);
    const buf = Buffer.alloc(readLength);
    const { bytesRead } = await fh.read(buf, 0, readLength, offset);
    const lines = buf.toString('utf8', 0, bytesRead).split('\n');
    if (offset > 0) lines.shift();
    return lines;
  } catch {
    // File does not exist, permission denied, or other I/O error.
    return undefined;
  } finally {
    await fh?.close();
  }
}

/**
 * Sniff the transcript file at session-start time to detect fork lineage.
 *
 * Combines the bounded tail read with the pure backward-scanning
 * detection core.  Because the window is anchored at end-of-file, a byte
 * cap can never cause a wrong parent: the decisive record — the file's
 * last user record — is either inside the window or the sniff returns
 * `undefined` and defers to the full transcript import.  Returns
 * `undefined` (no fork signal) on any error — hook processing must never
 * be blocked by a sniff failure.
 * @param transcriptPath - Absolute path to the JSONL transcript file
 * @param hookSessionId - Session ID reported by the hook payload
 * @returns Fork sniff result, or `undefined` when no fork is detected or
 *   the sniff cannot be performed
 */
export async function sniffTranscriptFork(
  transcriptPath: string,
  hookSessionId: string,
): Promise<ForkSniffResult | undefined> {
  try {
    const lines = await readTranscriptTail(transcriptPath);
    if (lines === undefined) return undefined;
    return sniffForkLineage(lines, hookSessionId);
  } catch {
    // Defensive: any unexpected error falls back to no-signal.
    return undefined;
  }
}
