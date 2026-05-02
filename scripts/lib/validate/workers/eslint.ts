#!/usr/bin/env tsx
/**
 * ESLint validation worker process.
 *
 * Runs in isolated process with its own V8 heap.
 * Receives input via stdin, outputs results via stdout.
 * @packageDocumentation
 */

import { loadESLint } from '../util/tool-loader.js';
import { validateESLint } from '../validators/eslint-validator.js';
import { createValidatorWorker } from './worker-factory.js';

/**
 * Main worker entry point.
 */
const main = createValidatorWorker({
  toolName: 'eslint',
  loadTool: async (searchPaths) => {
    const { ctor, local } = await loadESLint(searchPaths);
    return { tool: ctor ?? null, local: local ?? undefined };
  },
  runValidation: validateESLint,
  errorHandler: {
    noConfigPattern: /no eslint configuration|couldn['']t find a configuration/i,
    noConfigReason: 'no-eslint-config',
  },
});

main().catch((err) => {
  console.error('ESLint worker fatal error:', err);
  process.exit(1);
});
