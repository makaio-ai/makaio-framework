#!/usr/bin/env tsx
/**
 * Stylelint validation worker process.
 *
 * Runs in isolated process with its own V8 heap.
 * Receives input via stdin, outputs results via stdout.
 * @packageDocumentation
 */

import { loadStylelint } from '../util/tool-loader.js';
import { validateStylelint } from '../validators/stylelint-validator.js';
import { createValidatorWorker } from './worker-factory.js';

/**
 * Main worker entry point.
 */
const main = createValidatorWorker({
  toolName: 'stylelint',
  loadTool: async (searchPaths) => {
    const { mod, local } = await loadStylelint(searchPaths);
    return { tool: mod ?? null, local: local ?? undefined };
  },
  runValidation: validateStylelint,
  filterFiles: (files) => files.filter((f) => f.endsWith('.scss')),
  noFilesReason: 'no-scss-files',
  noToolReason: 'no-stylelint',
  errorHandler: {
    noConfigPattern: /no configuration provided|could not find/i,
    noConfigReason: 'no-stylelint-config',
  },
});

main().catch((err) => {
  console.error('Stylelint worker fatal error:', err);
  process.exit(1);
});
