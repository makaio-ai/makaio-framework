import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Persistent state for deterministic "new comments only" polling. */
export interface ReviewStateFile {
  /** File format version. */
  version: 1;
  /** Per-PR seen entry tracking. */
  pullRequests: Record<string, StoredPullRequestState>;
}

/** Stored seen IDs for a single pull request. */
interface StoredPullRequestState {
  /** Stable GitHub-backed IDs already observed for this PR. */
  seenEntryIds: string[];
  /** Last time the state was updated. */
  updatedAt: string;
}

/** Minimal shape required for persistent seen-ID tracking. */
export interface ReviewStateEntry {
  /** Stable GitHub-backed identifier. */
  id: string;
}

/**
 * Runtime check for a persisted pull-request state record.
 * @param value - Unknown parsed JSON value
 * @returns True when the value matches the stored PR state shape
 */
function isStoredPullRequestState(value: unknown): value is StoredPullRequestState {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { seenEntryIds?: unknown }).seenEntryIds) &&
    (value as { seenEntryIds: unknown[] }).seenEntryIds.every((entryId) => typeof entryId === 'string') &&
    typeof (value as { updatedAt?: unknown }).updatedAt === 'string'
  );
}

/**
 * Normalize persisted per-PR state entries, dropping malformed records.
 * @param value - Unknown parsed JSON value
 * @returns Safe per-PR state map
 */
function normalizePullRequestStates(value: unknown): Record<string, StoredPullRequestState> {
  if (typeof value !== 'object' || value === null) {
    return {};
  }

  const normalized: Record<string, StoredPullRequestState> = {};
  for (const [pullRequestKey, pullRequestState] of Object.entries(value)) {
    if (isStoredPullRequestState(pullRequestState)) {
      normalized[pullRequestKey] = {
        seenEntryIds: [...new Set(pullRequestState.seenEntryIds)].sort(),
        updatedAt: pullRequestState.updatedAt,
      };
    }
  }

  return normalized;
}

/**
 * Load persistent review state from disk, falling back to an empty state.
 * @param stateFilePath - Absolute path to the state file
 * @returns Parsed persistent state
 */
export async function loadReviewState(stateFilePath: string): Promise<ReviewStateFile> {
  try {
    const rawState = await readFile(stateFilePath, 'utf-8');
    const parsed = JSON.parse(rawState) as unknown;
    if (parsed && typeof parsed === 'object' && 'version' in parsed && parsed.version === 1) {
      return {
        version: 1,
        pullRequests: normalizePullRequestStates(
          'pullRequests' in parsed ? (parsed as { pullRequests?: unknown }).pullRequests : undefined,
        ),
      };
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  return { version: 1, pullRequests: {} };
}

/**
 * Persist review state to disk.
 * @param stateFilePath - Absolute path to the state file
 * @param state - State to persist
 */
export async function saveReviewState(stateFilePath: string, state: ReviewStateFile): Promise<void> {
  await mkdir(dirname(stateFilePath), { recursive: true });
  await writeFile(stateFilePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

/**
 * Filter entries against persistent seen IDs for the current pull request.
 * @param entries - Current actionable entries
 * @param state - Loaded review state
 * @param pullRequestKey - Stable key for the current pull request
 * @returns Entries not yet recorded as seen
 */
export function filterNewEntries<T extends ReviewStateEntry>(
  entries: T[],
  state: ReviewStateFile,
  pullRequestKey: string,
): T[] {
  const seenIds = new Set(state.pullRequests[pullRequestKey]?.seenEntryIds ?? []);
  const batchIds = new Set<string>();
  return entries.filter((entry) => {
    if (seenIds.has(entry.id) || batchIds.has(entry.id)) {
      return false;
    }

    batchIds.add(entry.id);
    return true;
  });
}

/**
 * Update persistent state with the current actionable entries for the pull request.
 * @param entries - Current actionable entries
 * @param state - Mutable review state
 * @param pullRequestKey - Stable key for the current pull request
 */
export function recordSeenEntries<T extends ReviewStateEntry>(
  entries: T[],
  state: ReviewStateFile,
  pullRequestKey: string,
): void {
  const existingIds = state.pullRequests[pullRequestKey]?.seenEntryIds ?? [];
  const seenIds = new Set(existingIds);
  for (const entry of entries) {
    seenIds.add(entry.id);
  }

  state.pullRequests[pullRequestKey] = {
    seenEntryIds: [...seenIds].sort(),
    updatedAt: new Date().toISOString(),
  };
}
