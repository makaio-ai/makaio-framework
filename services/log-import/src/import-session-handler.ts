/**
 * Handler for log-import.importSession (lazy-load pick-up).
 *
 * When a user clicks a discovered session in the UI, this handler
 * reads the session's log file, imports all messages, and transitions
 * the session status from 'discovered' to 'active'.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';

import type { IMakaioBus } from '@makaio/bus-core';
import { LogImportSubjects } from './namespace.js';
import { AdapterSessionStorageSubjects } from '@makaio/services-core/session';

import { importFromFileContent } from './generic-import-handlers.js';
import type { LogImporterRegistration } from './types.js';

/**
 * Register the importSession handler.
 *
 * Responds to `log-import.importSession` by:
 * 1. Looking up the adapter session record to get `logFilePath`
 * 2. Reading the log file from disk
 * 3. Running the full import pipeline (parse → create session → store messages → activate)
 * 4. Returning `{ sessionId, messageCount }`
 * @param bus - Bus instance for communication
 * @param getRegistration - Function to look up a registration by adapter name
 * @returns Cleanup function to unsubscribe the handler
 */
export function registerImportSessionHandler(
  bus: IMakaioBus,
  getRegistration: (adapterName: string) => LogImporterRegistration | undefined,
): () => void {
  return bus.on(LogImportSubjects.importSession, async (ctx) => {
    const { adapterSessionId, adapterName } = ctx.payload;

    // Step 1: Look up the adapter session record to get logFilePath
    const { session: adapterSession } = await bus.request(AdapterSessionStorageSubjects.get, { adapterSessionId });

    if (!adapterSession) {
      throw new Error(`Adapter session not found: ${adapterSessionId}`);
    }

    if (!adapterSession.logFilePath) {
      throw new Error(
        `No log file path recorded for adapter session '${adapterSessionId}'. ` +
          `Re-run a discovery scan to populate the file path.`,
      );
    }

    // Step 2: Find the registered importer for this adapter
    const registration = getRegistration(adapterName);
    if (!registration) {
      throw new Error(`No importer registered for adapter '${adapterName}'`);
    }

    const { importer, logFilePattern, adapterName: registeredAdapterName, id: adapterId } = registration;
    const isJsonl = logFilePattern.endsWith('.jsonl');

    // Step 3: Read the log file from disk
    const content = await fs.readFile(adapterSession.logFilePath, 'utf8');

    // Step 4: Run the full import pipeline
    const { sessionId, messageCount } = await importFromFileContent({
      bus,
      importer,
      content,
      isJsonl,
      adapterName: registeredAdapterName,
      adapterId,
      sourceFilePath: adapterSession.logFilePath,
      persistedLogFilePath: adapterSession.logFilePath,
    });

    ctx.setResult({ sessionId, messageCount });
  });
}
