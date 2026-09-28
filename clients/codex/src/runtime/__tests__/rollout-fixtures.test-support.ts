/**
 * Shared Codex rollout fixtures for the fork-sniff and fork-lineage tests.
 *
 * Kept dependency-free so the pure fork-sniff tests do not pull in the
 * session-service test support and its bus dependencies.
 */

/**
 * Build a rollout `session_meta` line as Codex serializes it.
 * @param threadId - Thread id of the record owner
 * @param forkedFromId - Parent thread id, omitted for a root thread
 * @returns Serialized JSONL line
 */
export function rolloutMetaLine(threadId: string, forkedFromId?: string): string {
  return JSON.stringify({
    timestamp: '2026-09-16T23:09:48.711Z',
    type: 'session_meta',
    payload: {
      session_id: threadId,
      id: threadId,
      ...(forkedFromId !== undefined && { forked_from_id: forkedFromId }),
      timestamp: '2026-09-16T23:09:48.711Z',
      cwd: '/workspace',
      originator: 'codex_cli_rs',
      cli_version: '0.158.0',
      source: 'cli',
    },
  });
}
