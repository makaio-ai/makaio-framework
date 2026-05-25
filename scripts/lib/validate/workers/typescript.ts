#!/usr/bin/env tsx
/**
 * TypeScript validation worker process.
 *
 * Runs in an isolated Node process that parses tsconfig metadata and delegates
 * semantic graph checking to the native tsgo subprocess.
 * Receives input via stdin, outputs results via stdout.
 * @packageDocumentation
 */

import * as fssync from 'fs';
import * as path from 'path';
import { ValidatorContext } from '../util/validator-context.js';
import {
  validateTypeScriptWithConfig,
  validateTypeScriptByDiscovery,
  findNearestTsConfig,
} from '../validators/typescript-validator.js';
import type { FileValidationResults } from '../types.js';
import type { WorkerInput, WorkerOutput } from './types.js';
import { readStdin } from './worker-utils.js';

/**
 * Result of TypeScript configuration detection.
 */
interface TsConfigDetectionResult {
  /** TypeScript files filtered from input */
  tsFiles: string[];
  /** Explicit tsconfig path if provided */
  overrideTsConfig?: string;
  /** Whether the override config file exists */
  overrideExists: boolean;
  /** Set of discovered tsconfig paths */
  tsConfigPaths: Set<string>;
}

/**
 * Detects TypeScript configuration for the given files.
 * @param files - Files to validate
 * @param tsConfigFile - Explicit tsconfig path from options
 * @returns Configuration detection result
 */
function detectTsConfig(files: string[], tsConfigFile?: string): TsConfigDetectionResult {
  const tsFiles = files.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

  const overrideTsConfig = tsConfigFile ? path.resolve(process.cwd(), tsConfigFile) : undefined;
  const overrideExists = overrideTsConfig ? fssync.existsSync(overrideTsConfig) : false;

  const tsConfigPaths = new Set<string>();
  if (!overrideExists && tsFiles.length > 0) {
    for (const f of tsFiles) {
      const cfg = findNearestTsConfig(f);
      if (cfg) tsConfigPaths.add(cfg);
    }
  }

  return { tsFiles, overrideTsConfig, overrideExists, tsConfigPaths };
}

/**
 * Main worker entry point.
 */
async function main(): Promise<void> {
  const inputJson = await readStdin();
  const input: WorkerInput = JSON.parse(inputJson);

  const fileResults: FileValidationResults = {};
  const ctx = new ValidatorContext(fileResults);

  const tsConfig = detectTsConfig(input.files, input.options.tsConfigFile);

  // No TS files to validate
  if (tsConfig.tsFiles.length === 0) {
    process.stdout.write(
      JSON.stringify({
        success: true,
        results: {},
        status: { tool: 'typescript', status: 'skipped', reason: 'no-ts-files' },
      } satisfies WorkerOutput),
    );
    return;
  }

  // Explicit config specified but doesn't exist
  if (tsConfig.overrideTsConfig && !tsConfig.overrideExists) {
    process.stdout.write(
      JSON.stringify({
        success: true, // Treat as successful skip
        results: {},
        status: { tool: 'typescript', status: 'skipped', reason: 'no-tsconfig' },
      } satisfies WorkerOutput),
    );
    return;
  }

  // No tsconfig found via discovery
  if (!tsConfig.overrideTsConfig && tsConfig.tsConfigPaths.size === 0) {
    process.stdout.write(
      JSON.stringify({
        success: true, // Treat as successful skip
        results: {},
        status: { tool: 'typescript', status: 'skipped', reason: 'no-tsconfig' },
      } satisfies WorkerOutput),
    );
    return;
  }

  try {
    let result: { filesChecked: string[] };

    if (tsConfig.overrideTsConfig) {
      result = await validateTypeScriptWithConfig(input.files, tsConfig.overrideTsConfig, ctx, input.options.verbose);
    } else {
      result = await validateTypeScriptByDiscovery(input.files, ctx, undefined, input.options.verbose);
    }

    process.stdout.write(
      JSON.stringify({
        success: true,
        results: fileResults,
        status: {
          tool: 'typescript',
          status: 'ok',
          filesChecked: result.filesChecked,
        },
      } satisfies WorkerOutput),
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      JSON.stringify({
        success: false,
        results: fileResults,
        status: { tool: 'typescript', status: 'failed', error: errorMsg },
        error: errorMsg,
      } satisfies WorkerOutput),
    );
  }
}

main().catch((err) => {
  console.error('TypeScript worker fatal error:', err);
  process.exit(1);
});
