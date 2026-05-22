/**
 * Generic upload-files handler for LogImportRegistry.
 *
 * Handles file upload requests for any registered importer by base64-decoding
 * each uploaded file and running the full import pipeline.
 * @packageDocumentation
 */
import type { IMakaioBus } from '@makaio/bus-core';
import { LogImportSubjects } from './namespace.js';
import type { LogImporterRegistration } from './types.js';
import { importFromFileContent } from './generic-import-handlers.js';

/**
 * Register generic uploadFiles handler.
 *
 * Handles file upload requests for any registered importer.
 * @param bus - Bus instance
 * @param getRegistration - Function to look up registration by name
 * @returns Cleanup function
 */
export function registerGenericUploadFilesHandler(
  bus: IMakaioBus,
  getRegistration: (name: string) => LogImporterRegistration | undefined,
): () => void {
  return bus.on(LogImportSubjects.uploadFiles, async (ctx) => {
    const { adapterName, files } = ctx.payload;

    const registration = getRegistration(adapterName);
    if (!registration) {
      ctx.setResult({
        adapterName,
        filesProcessed: files.length,
        sessionsImported: 0,
        errors: files.map((f) => ({ filename: f.filename, error: 'No importer registered for this adapter' })),
      });
      return;
    }

    const { importer, logFilePattern, adapterName: registeredAdapterName, id: adapterId } = registration;
    const isJsonl = logFilePattern.endsWith('.jsonl');

    let sessionsImported = 0;
    const errors: Array<{ filename: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = Buffer.from(file.contentBase64, 'base64').toString('utf8');
        await importFromFileContent({
          bus,
          importer,
          content,
          isJsonl,
          adapterName: registeredAdapterName,
          adapterId,
          sourceFilePath: file.filename,
        });
        sessionsImported++;
      } catch (error) {
        errors.push({
          filename: file.filename,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    ctx.setResult({ adapterName, filesProcessed: files.length, sessionsImported, errors });
  });
}
