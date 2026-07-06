/**
 * Handler for log-import.importFile (file-path-addressable import trigger).
 *
 * Lets observers (hook-triggered ingestion, watcher fallbacks) request a full
 * import of a transcript file by path, without a prior discovery stub. The
 * import is a full re-parse from byte 0; exactly-once semantics come from
 * anchor/message idempotency and created-gated event emission in the turn
 * ingestion seam, not from this handler.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';

import type { IMakaioBus } from '@makaio/bus-core';
import type { TurnIngestionMarker } from '@makaio/contracts';
import { LogImportSubjects } from './namespace.js';
import { importFromFileContent } from './generic-import-handlers.js';
import type { LogImporterRegistration } from './types.js';

/** Response payload for `log-import.importFile`. */
type ImportFileResult =
  | { status: 'skipped'; reason: 'no-importer' | 'file-missing' }
  | { status: 'imported'; sessionId: string; messageCount: number; turnCount: number };

/**
 * Per-file advisory mutex: chains executions per filePath so concurrent
 * `importFile` requests for the same file run sequentially.
 *
 * This only reduces wasted concurrent double-parses of the same file — the
 * REAL exactly-once guarantee is anchor/message idempotency plus
 * created-gated events in the turn ingestion seam. A concurrent
 * watcher-driven import running in the orchestrator's own task track is NOT
 * covered by this mutex and relies on that idempotency alone.
 *
 * Each entry is the current chain tail (never rejecting); the next call
 * awaits it regardless of the previous outcome. The entry is deleted when
 * the chain drains (the stored tail is still the map value on settle).
 */
const importChainByFilePath = new Map<string, Promise<unknown>>();

/**
 * Execute one importFile request (registration lookup, stat, read, import).
 * @param bus - Bus instance used by the import pipeline
 * @param getRegistration - Registration lookup by adapter name
 * @param payload - Validated `log-import.importFile` request payload
 * @returns Handled skip result, or the import result on success
 * @throws Genuine importer/storage errors (only the two skip cases are handled results)
 */
async function executeImportFile(
  bus: IMakaioBus,
  getRegistration: (adapterName: string) => LogImporterRegistration | undefined,
  payload: { filePath: string; adapterName: string; ingestionMarker?: TurnIngestionMarker },
): Promise<ImportFileResult> {
  const { filePath, adapterName } = payload;

  // Graceful absence: framework-only hosts and the boot window before
  // contribution processing (registry loaded, importers not yet contributed)
  // must not error-spam. NEVER throw for a missing registration.
  const registration = getRegistration(adapterName);
  if (registration === undefined) {
    return { status: 'skipped', reason: 'no-importer' };
  }

  try {
    await fs.stat(filePath);
  } catch {
    return { status: 'skipped', reason: 'file-missing' };
  }

  const content = await fs.readFile(filePath, 'utf8');
  const isJsonl = registration.logFilePattern.endsWith('.jsonl');

  const { sessionId, messageCount, turnCount } = await importFromFileContent({
    bus,
    importer: registration.importer,
    content,
    isJsonl,
    adapterName: registration.adapterName,
    adapterId: registration.id,
    sourceFilePath: filePath,
    persistedLogFilePath: filePath,
    // Default 'live': importFile is the hook-triggered ingestion entry point;
    // historical callers pass 'backfill' explicitly.
    ingestionMarker: payload.ingestionMarker ?? 'live',
  });

  return { status: 'imported', sessionId, messageCount, turnCount };
}

/**
 * Register the importFile handler.
 *
 * Responds to `log-import.importFile` by parsing the given transcript file
 * with the registered importer for `adapterName` and persisting the resulting
 * segment tree (sessions, messages, turns). Per the subject's
 * graceful-absence contract, a missing importer registration or a missing
 * file yields a `skipped` result instead of an error; genuine importer or
 * storage failures propagate.
 * @param bus - Bus instance for communication
 * @param getRegistration - Function to look up a registration by adapter name
 * @returns Cleanup function to unsubscribe the handler
 */
export function registerImportFileHandler(
  bus: IMakaioBus,
  getRegistration: (adapterName: string) => LogImporterRegistration | undefined,
): () => void {
  return bus.on(LogImportSubjects.importFile, async (ctx) => {
    const { filePath } = ctx.payload;

    // Chain onto the previous execution for this file, regardless of outcome.
    const previous = importChainByFilePath.get(filePath) ?? Promise.resolve();
    const execution = previous.then(() => executeImportFile(bus, getRegistration, ctx.payload));

    // The stored tail never rejects, so later chains cannot inherit a rejection.
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    importChainByFilePath.set(filePath, tail);
    void tail.then(() => {
      // Delete only when this tail is still the newest link (chain drained).
      if (importChainByFilePath.get(filePath) === tail) {
        importChainByFilePath.delete(filePath);
      }
    });

    ctx.setResult(await execution);
  });
}
