/**
 * File utilities and generic scan handler for LogImportRegistry.
 *
 * Handles scan requests for any registered importer by walking the log
 * directory, parsing files, and upserting discovered imported sessions.
 * @packageDocumentation
 */
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IMakaioBus } from '@makaio/bus-core';
import type { LogImporter } from '@makaio/ai-adapters-core';
import { SessionStorageSubjects } from '@makaio/services-core/session';
import { LogImportSubjects } from './namespace.js';
import type { LogImporterRegistration } from './types.js';
import { matchesPattern } from './pattern-matching.js';
import { extractSessionMetadata, toImportUpsertPayload } from './lineage-metadata.js';

/**
 * Recursively find all files matching a pattern in a directory.
 * @param dir - Directory to search
 * @param pattern - File pattern to match (e.g., '*.jsonl', 'session.jsonl')
 * @param rootDir - Root directory used to compute relative paths for pattern matching
 * @returns Array of absolute file paths
 */
async function findLogFiles(dir: string, pattern: string, rootDir = dir): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await findLogFiles(fullPath, pattern, rootDir);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        const relativePath = relative(rootDir, fullPath).split(sep).join('/');
        if (!matchesPattern(relativePath, pattern)) continue;
        files.push(fullPath);
      }
    }
  } catch {
    // Directory doesn't exist or not readable
  }

  return files;
}

/**
 * Normalize a persisted log file path only when there is a deterministic absolute anchor.
 * @param persistedLogFilePath - Candidate durable path from caller/import metadata.
 * @param sourceFilePath - Absolute source file path when reading from disk.
 * @param cwd - Working directory metadata that may serve as an absolute anchor.
 * @returns Absolute durable path or undefined when the input would require guessing.
 */
export function normalizePersistedLogFilePath(
  persistedLogFilePath: string | undefined,
  sourceFilePath: string | undefined,
  cwd: string | null,
): string | undefined {
  if (persistedLogFilePath === undefined) {
    return undefined;
  }

  if (isAbsolute(persistedLogFilePath)) {
    return persistedLogFilePath;
  }

  if (sourceFilePath && isAbsolute(sourceFilePath)) {
    return resolve(dirname(sourceFilePath), persistedLogFilePath);
  }

  if (cwd && isAbsolute(cwd)) {
    return resolve(cwd, persistedLogFilePath);
  }

  return undefined;
}

/**
 * Parse records from file content.
 *
 * Handles both JSONL (line-delimited) and JSON (single object) formats.
 * @param content - File content as string
 * @param importer - Importer to use for parsing
 * @param isJsonl - Whether to treat as JSONL (default) or JSON
 * @param sourceFilePath - Optional path to source file (for importers that need path context)
 * @returns Array of parsed records
 */
export function parseFileContent<TRecord>(
  content: string,
  importer: LogImporter<TRecord>,
  isJsonl = true,
  sourceFilePath?: string,
): TRecord[] {
  const records: TRecord[] = [];

  if (isJsonl) {
    const lines = content.split('\n').filter((line) => line.trim());
    for (const line of lines) {
      const record = importer.parseRecord(line, sourceFilePath);
      if (record) {
        records.push(record);
      }
    }
  } else {
    // Single JSON object
    const record = importer.parseRecord(content, sourceFilePath);
    if (record) {
      records.push(record);
    }
  }

  return records;
}

/**
 * Register generic scan handler.
 *
 * Handles scan requests for any registered importer.
 * @param bus - Bus instance
 * @param getRegistration - Function to look up registration by name
 * @returns Cleanup function
 */
export function registerGenericScanHandler(
  bus: IMakaioBus,
  getRegistration: (name: string) => LogImporterRegistration | undefined,
): () => void {
  return bus.on(LogImportSubjects.scan, async (ctx) => {
    const { adapterName } = ctx.payload;

    const registration = getRegistration(adapterName);
    if (!registration) {
      ctx.setResult({ adapterName, sessionsFound: 0, newSessions: 0 });
      return;
    }

    const { importer, logFilePattern, adapterName: canonicalAdapterName } = registration;
    const logDirectory = importer.getLogDirectory();

    // Check if directory exists
    try {
      await fs.access(logDirectory);
    } catch {
      ctx.setResult({ adapterName, sessionsFound: 0, newSessions: 0 });
      return;
    }

    // Determine file format from pattern
    const isJsonl = logFilePattern.endsWith('.jsonl');

    // Find all matching log files
    const sessionFiles = await findLogFiles(logDirectory, logFilePattern);

    let sessionsFound = 0;
    let newSessions = 0;

    for (const filePath of sessionFiles) {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const records = parseFileContent(content, importer, isJsonl, filePath);

        if (records.length === 0) continue;

        // Extract session context to get metadata
        const context = importer.extractSessionContext(records);
        const metadata = extractSessionMetadata(context.sessionEvent);

        sessionsFound++;

        // Upsert to sessions (discover-only, no message import)
        const { created } = await bus.request(
          SessionStorageSubjects.importUpsert,
          toImportUpsertPayload(metadata, canonicalAdapterName, metadata.cwd, filePath, metadata.startedAt),
        );

        if (created) {
          newSessions++;
        }
      } catch (error) {
        console.warn(
          `[LogImportRegistry] Failed to process ${filePath}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    ctx.setResult({ adapterName, sessionsFound, newSessions });
  });
}
