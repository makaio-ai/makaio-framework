import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { safeParseExtensionDescriptor, type ExtensionDescriptor } from '@makaio/contracts';
import {
  ExtensionVerifyError,
  createVerifyState,
  failVerification,
  formatSchemaIssues,
  recordCheck,
  type ExtensionVerifyCheckResult,
  type ExtensionVerifyDiagnostic,
  type ExtensionVerifyDiagnosticCode,
  type ExtensionVerifyFailureResult,
  type ExtensionVerifyResult,
  type ExtensionVerifyState,
} from './extension-verify-model.js';
import { resolveDeclaredEntrypoints } from './extension-verify-entrypoints.js';
import { verifyBrowserEntrypoint, verifyCliEntrypoint, verifyServerEntrypoint } from './extension-verify-runtime.js';

export { ExtensionVerifyError };
export type {
  ExtensionVerifyCheckResult,
  ExtensionVerifyDiagnostic,
  ExtensionVerifyDiagnosticCode,
  ExtensionVerifyFailureResult,
  ExtensionVerifyResult,
};

/**
 * Options for {@link verifyExtensionWorkspace}.
 */
export interface ExtensionVerifyOptions {
  /** Extension root to verify. Defaults to the current working directory. */
  readonly cwd?: string;
}

/**
 * Verify a local extension workspace against the descriptor-owned build contract.
 *
 * This is intentionally local and filesystem-based: it reads `descriptor.json`
 * from the target directory, validates the descriptor schema, resolves every
 * declared entrypoint through the shared `src/<stem>.ts` then `dist/<stem>.mjs`
 * convention, and checks each surface's runtime contract.
 * @param options - Verification options.
 * @returns Verified root plus the parsed entrypoints and per-check results.
 * @throws ExtensionVerifyError When verification fails.
 */
export async function verifyExtensionWorkspace(options: ExtensionVerifyOptions = {}): Promise<ExtensionVerifyResult> {
  const rootDir = path.resolve(options.cwd ?? process.cwd());
  const state = createVerifyState(rootDir);
  const descriptor = await loadDescriptor(state);

  if (descriptor.execution === 'detached') {
    // Detached extensions run as child processes and have no entrypoints to
    // verify — the transport config is validated by the schema at parse time.
    return {
      ok: true,
      rootDir,
      entrypoints: {},
      checks: [...state.checks],
      diagnostics: [],
    };
  }

  const resolvedEntrypoints = resolveDeclaredEntrypoints(state, descriptor.entrypoints);

  await verifyServerEntrypoint(state, descriptor.entrypoints.server, resolvedEntrypoints.server);
  await verifyBrowserEntrypoint(state, descriptor.entrypoints.browser, resolvedEntrypoints.browser);
  await verifyCliEntrypoint(state, descriptor.entrypoints.cli, resolvedEntrypoints.cli);

  return {
    ok: true,
    rootDir,
    entrypoints: descriptor.entrypoints,
    checks: [...state.checks],
    diagnostics: [],
  };
}

/**
 * Read and parse `descriptor.json`.
 * @param state - Mutable verification state.
 * @returns Parsed extension descriptor.
 */
async function loadDescriptor(state: ExtensionVerifyState): Promise<ExtensionDescriptor> {
  const descriptorPath = path.join(state.rootDir, 'descriptor.json');
  const rawDescriptor = await readDescriptorFile(state, descriptorPath);

  let parsedDescriptor: unknown;
  try {
    parsedDescriptor = JSON.parse(rawDescriptor);
  } catch (error) {
    return failDescriptorCheck(state, descriptorPath, {
      code: 'descriptor.invalid-json',
      message: `descriptor.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      filePath: descriptorPath,
    });
  }

  const parseResult = safeParseExtensionDescriptor(parsedDescriptor);
  if (!parseResult.success) {
    return failDescriptorCheck(state, descriptorPath, {
      code: 'descriptor.invalid-schema',
      message: `descriptor.json is invalid: ${formatSchemaIssues(parseResult.error.issues)}`,
      filePath: descriptorPath,
    });
  }

  state.entrypoints = parseResult.data.entrypoints;
  recordCheck(state, {
    check: 'descriptor',
    status: 'passed',
    filePath: descriptorPath,
    diagnostics: [],
  });
  return parseResult.data;
}

/**
 * Read the descriptor file from disk.
 * @param state - Mutable verification state.
 * @param descriptorPath - Absolute descriptor path.
 * @returns Raw descriptor file contents.
 */
async function readDescriptorFile(state: ExtensionVerifyState, descriptorPath: string): Promise<string> {
  try {
    return await readFile(descriptorPath, 'utf8');
  } catch (error) {
    return failDescriptorCheck(state, descriptorPath, {
      code: 'descriptor.read-failed',
      message: `Failed to read descriptor.json: ${error instanceof Error ? error.message : String(error)}`,
      filePath: descriptorPath,
    });
  }
}

/**
 * Record a failed descriptor check and throw a typed verification error.
 * @param state - Mutable verification state.
 * @param descriptorPath - Absolute descriptor path.
 * @param diagnostic - Structured descriptor diagnostic.
 * @returns Never.
 */
function failDescriptorCheck(
  state: ExtensionVerifyState,
  descriptorPath: string,
  diagnostic: ExtensionVerifyDiagnostic,
): never {
  return failVerification(state, {
    check: 'descriptor',
    status: 'failed',
    filePath: descriptorPath,
    diagnostics: [diagnostic],
  });
}
