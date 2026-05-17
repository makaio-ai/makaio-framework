#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { PublicProtocolNamespaces } from '../packages/contracts/src/protocol/catalog.js';
import type { MakaioProtocolManifest } from '../packages/contracts/src/protocol/types.js';
import { exportProtocolManifest, formatProtocolManifest } from './protocol/export-manifest.js';
import {
  generatePythonNamespaceInit,
  generatePythonNamespaceModule,
  generatePythonSubjects,
} from './bindings/python.js';
import {
  generatePythonPayloadsInit,
  generatePythonPayloadsModule,
  groupByNamespace,
} from './bindings/python-payloads.js';
import { generateRustSubjectsFile } from './bindings/rust.js';
import {
  PYTHON_GENERATED_DIR,
  PYTHON_PAYLOADS_DIR,
  PYTHON_SUBJECTS_PATH,
  RUST_SUBJECTS_PATH,
  SDK_PROTOCOL_MANIFEST_PATH,
} from './lib/sdk-generation-paths.js';

export interface SdkCodegenOptions {
  readonly check: boolean;
}

export interface GeneratedSdkFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Parse SDK codegen CLI arguments.
 * @param args - CLI arguments without node and script path.
 * @returns Parsed SDK codegen options.
 */
export function parseSdkCodegenArgs(args: readonly string[]): SdkCodegenOptions {
  let check = false;

  for (const arg of args) {
    if (arg === '--check') {
      check = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { check };
}

/**
 * Find generated files whose committed content differs from expected content.
 * @param files - Expected generated SDK files.
 * @param readText - Optional file reader used by tests.
 * @returns Paths whose current content differs from generated content.
 */
export async function findGeneratedFileDrift(
  files: readonly GeneratedSdkFile[],
  readText: (filePath: string) => Promise<string> = readUtf8,
): Promise<string[]> {
  const drift: string[] = [];

  for (const file of files) {
    let existing: string;
    try {
      existing = await readText(file.path);
    } catch {
      drift.push(file.path);
      continue;
    }

    if (existing !== file.content) {
      drift.push(file.path);
    }
  }

  return drift;
}

/**
 * Generate all committed SDK artifacts in memory.
 * @returns Expected generated SDK files and their content.
 */
export async function generateSdkFiles(): Promise<GeneratedSdkFile[]> {
  const manifest = exportProtocolManifest({ catalog: PublicProtocolNamespaces });
  const files: GeneratedSdkFile[] = [
    {
      path: SDK_PROTOCOL_MANIFEST_PATH,
      content: await generateFormattedManifest(manifest),
    },
    {
      path: PYTHON_SUBJECTS_PATH,
      content: generatePythonSubjects(manifest),
    },
  ];

  const groups = groupByNamespace(manifest.subjects);
  const namespaces = [...groups.keys()].sort();

  files.push({
    path: resolve(PYTHON_PAYLOADS_DIR, '__init__.py'),
    content: generatePythonPayloadsInit(),
  });
  for (const [namespace, subjects] of groups) {
    files.push({
      path: resolve(PYTHON_PAYLOADS_DIR, `${namespace}.py`),
      content: generatePythonPayloadsModule(namespace, subjects),
    });
  }

  for (const [namespace, subjects] of groups) {
    files.push({
      path: resolve(PYTHON_GENERATED_DIR, `${namespace}.py`),
      content: generatePythonNamespaceModule(namespace, subjects),
    });
  }
  files.push({
    path: resolve(PYTHON_GENERATED_DIR, '__init__.py'),
    content: generatePythonNamespaceInit(namespaces),
  });

  files.push({
    path: RUST_SUBJECTS_PATH,
    content: generateRustSubjectsFile(manifest, await readUtf8(RUST_SUBJECTS_PATH)),
  });

  return files;
}

/**
 * Run SDK code generation in write or check mode.
 * @param options - Codegen execution options.
 */
export async function runSdkCodegen(options: SdkCodegenOptions): Promise<void> {
  const files = await generateSdkFiles();

  if (options.check) {
    const drift = await findGeneratedFileDrift(files);
    if (drift.length > 0) {
      throw new Error(
        [
          'SDK codegen artifacts are stale. Run `yarn generate:sdk` and commit the generated files:',
          ...drift.map((filePath) => `- ${filePath}`),
        ].join('\n'),
      );
    }
    console.info('SDK codegen artifacts are up to date.');
    return;
  }

  for (const file of files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, 'utf8');
    console.info(`Generated: ${file.path}`);
  }
}

/**
 * Format the protocol manifest exactly as it is committed.
 * @param manifest - Protocol manifest to format.
 * @returns Formatted JSON manifest content.
 */
async function generateFormattedManifest(manifest: MakaioProtocolManifest): Promise<string> {
  const prettierConfig = (await resolveConfig(SDK_PROTOCOL_MANIFEST_PATH)) ?? {};
  return format(formatProtocolManifest(manifest), { ...prettierConfig, parser: 'json' });
}

/**
 * Read a UTF-8 file.
 * @param filePath - File path to read.
 * @returns File contents.
 */
async function readUtf8(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

/**
 * Determine whether this module is the process entrypoint.
 * @returns True when executed directly.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

if (isMainModule()) {
  try {
    await runSdkCodegen(parseSdkCodegenArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
