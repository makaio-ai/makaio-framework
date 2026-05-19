#!/usr/bin/env tsx
/**
 * Biome validation worker process.
 *
 * Runs in isolated process with its own V8 heap.
 * Receives input via stdin, outputs results via stdout.
 * @packageDocumentation
 */

import { loadBiome } from '../util/tool-loader.js';
import { validateBiome } from '../validators/biome-validator.js';
import { createValidatorWorker } from './worker-factory.js';

/**
 * Main worker entry point.
 */
const main = createValidatorWorker({
  toolName: 'biome',
  loadTool: async (searchPaths) => {
    const { mod, local } = await loadBiome(searchPaths);
    return { tool: mod ?? null, local: local ?? undefined };
  },
  runValidation: validateBiome,
  noFilesReason: 'no-biome-supported-files',
});

main().catch((err) => {
  console.error('Biome worker fatal error:', err);
  process.exit(1);
});
