/**
 * Fork lineage sniff for Codex rollout files.
 *
 * Codex records every thread as a JSONL *rollout* file. The first line is the
 * thread's own `session_meta` record; when the thread was created by forking
 * another thread, that record carries `forked_from_id` — the parent thread id.
 * Codex then copies the parent's persisted rollout items verbatim into the
 * child file, so the parent's own `session_meta` line appears *later* in the
 * same file.
 *
 * ## Why a sniff is needed
 *
 * The `SessionStart` hook payload has no lineage field at all: it carries
 * `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`,
 * `permission_mode` and `source` — nothing else. A fork also reports
 * `source: 'startup'`, exactly like a brand-new thread, so the hook alone
 * cannot distinguish the two. `transcript_path` points at the rollout file
 * the CLI has just materialized for the starting thread, which makes the
 * rollout head the only lineage source available at session-start time.
 *
 * ## Detection invariant
 *
 * The **first** `session_meta` record in the file is the file's own. Any later
 * `session_meta` record was copied from an ancestor and must be ignored, so the
 * scan stops at the first one it can parse:
 *
 * - `forked_from_id` present and different from the starting thread's own id
 *   → fork child; that id is the direct parent.
 * - `forked_from_id` absent (or equal to the own id, which would be a
 *   self-reference and is never a usable parent) → no fork signal.
 * - No parseable `session_meta` inside the window → inconclusive; return
 *   `undefined`. Fork registration is fill-once on the ingestion side, so a
 *   guessed parent would be permanently wrong while deferring is safe.
 *
 * Anchoring the window at the start of the file is what makes the rule sound
 * under a byte cap: the decisive record is the first one, so no earlier record
 * can exist outside the window.
 *
 * ## Design principles
 *
 * - **Pure detection core**: {@link sniffRolloutForkLineage} operates on raw
 *   JSONL lines. No I/O, no bus, no dependencies beyond the language runtime.
 * - **Bounded I/O wrapper**: {@link sniffRolloutFork} reads at most
 *   {@link SNIFF_MAX_BYTES} from the rollout head, so the hook path never
 *   blocks on a large rollout file.
 * - **Fail-open**: any I/O or parse error yields `undefined` (no fork signal);
 *   hook processing is never blocked by a sniff failure.
 * @packageDocumentation
 */

import { open } from 'node:fs/promises';

/**
 * Maximum number of bytes to read from the rollout head for fork detection.
 *
 * The decisive record is the first line, but that line embeds the thread's
 * `base_instructions`, which can run to several kilobytes. 128 KiB leaves ample
 * headroom for it while keeping the blocking window small. A `session_meta`
 * line longer than the window yields a truncated, unparseable JSON fragment and
 * therefore no signal — the fail-open outcome, not a wrong parent.
 */
export const SNIFF_MAX_BYTES = 128 * 1024;

/** Rollout item discriminator for the thread metadata record. */
const SESSION_META_TYPE = 'session_meta';

/**
 * Result of the fork lineage sniff.
 *
 * Returned only when the rollout's own `session_meta` names a foreign parent
 * thread; `undefined` means no fork signal was found.
 */
export interface CodexForkSniffResult {
  /** Adapter session id of the parent thread. */
  readonly parentAdapterSessionId: string;
}

/**
 * Read `forked_from_id` from a parsed rollout line when it is the file's own
 * `session_meta` record.
 *
 * Codex serializes its rollout items with an externally tagged representation,
 * so the record on disk has a `type` discriminator and a `payload` body; the
 * metadata record flattens the thread metadata into that `payload`.
 * @param parsed - Parsed JSONL record from the rollout head
 * @returns The parent thread id, `undefined` when the record names no parent,
 *   or `null` when the record is not a `session_meta` record at all
 */
function readForkParent(parsed: Record<string, unknown>): string | undefined | null {
  if (parsed['type'] !== SESSION_META_TYPE) return null;
  const payload = parsed['payload'];
  if (typeof payload !== 'object' || payload === null) return undefined;
  const forkedFromId = (payload as Record<string, unknown>)['forked_from_id'];
  return typeof forkedFromId === 'string' && forkedFromId.length > 0 ? forkedFromId : undefined;
}

/**
 * Detect fork lineage from raw rollout JSONL lines.
 *
 * Scans the provided window **forward** from the first line. The window must be
 * anchored at the start of the rollout file (see {@link sniffRolloutFork});
 * under that anchoring, the first `session_meta` record found is the file's own
 * and decides the outcome. Later `session_meta` records belong to ancestors
 * copied into the fork and are never consulted.
 * @param lines - Raw JSONL lines from the rollout head (may include empty
 *   strings, partial lines, or non-JSON data)
 * @param hookSessionId - Session id reported by the hook payload (the starting
 *   thread's own id)
 * @returns Fork sniff result when the own `session_meta` names a foreign
 *   parent, or `undefined` for a plain start / no signal / inconclusive window
 */
export function sniffRolloutForkLineage(
  lines: readonly string[],
  hookSessionId: string,
): CodexForkSniffResult | undefined {
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Malformed or partial line — skip silently.
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;

    const forkParent = readForkParent(parsed);
    // Not a session_meta record — keep scanning for the file's own one.
    if (forkParent === null) continue;
    // The file's own session_meta decides; a self-reference is not a parent.
    if (forkParent === undefined || forkParent === hookSessionId) return undefined;
    return { parentAdapterSessionId: forkParent };
  }

  return undefined;
}

/**
 * Read at most {@link SNIFF_MAX_BYTES} from the head of the rollout file.
 *
 * The final element is dropped when the file is larger than the window: it is a
 * partial line whose parse would fail anyway, and dropping it keeps the caller
 * from treating truncated JSON as data.
 * @param rolloutPath - Absolute path to the rollout JSONL file
 * @returns Raw lines from the file head, or `undefined` on any I/O error
 */
async function readRolloutHead(rolloutPath: string): Promise<string[] | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(rolloutPath, 'r');
    const { size } = await fh.stat();
    const readLength = Math.min(size, SNIFF_MAX_BYTES);
    const buf = Buffer.alloc(readLength);
    const { bytesRead } = await fh.read(buf, 0, readLength, 0);
    const lines = buf.toString('utf8', 0, bytesRead).split('\n');
    if (size > SNIFF_MAX_BYTES) lines.pop();
    return lines;
  } catch {
    // File does not exist, permission denied, or other I/O error.
    return undefined;
  } finally {
    await fh?.close();
  }
}

/**
 * Sniff the rollout file at session-start time to detect fork lineage.
 *
 * Combines the bounded head read with the pure forward-scanning detection core.
 * Because the window is anchored at the start of the file, a byte cap can never
 * produce a wrong parent: the decisive record — the file's own `session_meta` —
 * is either inside the window or the sniff returns `undefined`. Returns
 * `undefined` (no fork signal) on any error; hook processing must never be
 * blocked by a sniff failure.
 * @param rolloutPath - Absolute path to the rollout JSONL file, as reported by
 *   the hook payload's `transcript_path`
 * @param hookSessionId - Session id reported by the hook payload
 * @returns Fork sniff result, or `undefined` when no fork is detected or the
 *   sniff cannot be performed
 */
export async function sniffRolloutFork(
  rolloutPath: string,
  hookSessionId: string,
): Promise<CodexForkSniffResult | undefined> {
  try {
    const lines = await readRolloutHead(rolloutPath);
    if (lines === undefined) return undefined;
    return sniffRolloutForkLineage(lines, hookSessionId);
  } catch {
    // Defensive: any unexpected error falls back to no-signal.
    return undefined;
  }
}
