#!/usr/bin/env tsx
/**
 * Prettier validation worker process.
 *
 * Runs in isolated process with its own V8 heap.
 * Receives input via stdin, outputs results via stdout.
 * @packageDocumentation
 */

import { loadPrettier } from '../util/tool-loader.js';
import { validatePrettier } from '../validators/prettier-validator.js';
import { createValidatorWorker } from './worker-factory.js';

/**
 * Main worker entry point.
 */
const main = createValidatorWorker({
  toolName: 'prettier',
  loadTool: async (searchPaths) => {
    const { mod, local } = await loadPrettier(searchPaths);
    return { tool: mod ?? null, local: local ?? undefined };
  },
  runValidation: validatePrettier,
});

main().catch((err) => {
  console.error('Prettier worker fatal error:', err);
  process.exit(1);
});
