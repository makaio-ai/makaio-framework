/**
 * Synchronous descriptor metadata reading for Vite dev and build configuration.
 *
 * Reads and validates the minimal `descriptor.json` subset that Vite-time
 * browser entry discovery needs, without importing framework runtime sources.
 * Consumed at Vite config evaluation time, which is synchronous, so filesystem
 * operations use the `*Sync` Node.js APIs.
 * @packageDocumentation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Minimal descriptor shape needed for browser entry discovery. */
export interface ExtensionDescriptor {
  /** Descriptor name used in runtime extension URLs. */
  readonly name: string;
  /** Surface entrypoint declarations. */
  readonly entrypoints?: {
    /** Browser entrypoint declaration. */
    readonly browser?: true | string;
  };
  /** Bare npm specifiers the browser entry reaches, pre-bundled eagerly by hosts. */
  readonly prebundleDependencies?: readonly string[];
}

/**
 * Read and validate a descriptor in the supplied descriptor root.
 * @param descriptorRoot - Absolute directory containing `descriptor.json`.
 * @returns Valid extension descriptor, or `undefined` when invalid.
 */
export function readExtensionDescriptor(descriptorRoot: string): ExtensionDescriptor | undefined {
  const descriptorPath = path.join(descriptorRoot, 'descriptor.json');
  try {
    const raw = JSON.parse(fs.readFileSync(descriptorPath, 'utf-8')) as unknown;
    return parseExtensionDescriptor(raw);
  } catch (error) {
    console.warn(
      `[extensions] Skipping invalid descriptor at ${descriptorPath}:`,
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}

/**
 * Parse the descriptor fields needed for browser entry discovery.
 * @param raw - Raw descriptor JSON.
 * @returns Parsed descriptor.
 */
function parseExtensionDescriptor(raw: unknown): ExtensionDescriptor {
  if (!isRecord(raw)) throw new Error('descriptor must be an object');
  const name = raw['name'];
  if (typeof name !== 'string' || name.length === 0) throw new Error('descriptor.name must be a non-empty string');
  const prebundleDependencies = parsePrebundleDependencies(raw['prebundleDependencies']);
  const entrypoints = raw['entrypoints'];
  if (entrypoints === undefined) {
    if (prebundleDependencies !== undefined) {
      throw new Error('descriptor.prebundleDependencies requires a browser entrypoint');
    }
    return { name };
  }
  if (!isRecord(entrypoints)) throw new Error('descriptor.entrypoints must be an object');

  const browser = entrypoints['browser'];
  if (browser === undefined) {
    if (prebundleDependencies !== undefined) {
      throw new Error('descriptor.prebundleDependencies requires a browser entrypoint');
    }
    return { name, entrypoints: {} };
  }
  if (browser !== true && typeof browser !== 'string') {
    throw new Error('descriptor.entrypoints.browser must be true or a string');
  }
  if (typeof browser === 'string' && !isSafeEntrypointStem(browser)) {
    throw new Error(`descriptor.entrypoints.browser is not a contained entrypoint stem: ${browser}`);
  }
  return {
    name,
    entrypoints: { browser },
    ...(prebundleDependencies !== undefined ? { prebundleDependencies } : {}),
  };
}

/**
 * Parse and validate the optional `prebundleDependencies` descriptor field.
 * @param raw - Raw descriptor field value.
 * @returns Validated specifier list, or `undefined` when the field is absent.
 */
function parsePrebundleDependencies(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (
    !Array.isArray(raw) ||
    !raw.every((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
  ) {
    throw new Error('descriptor.prebundleDependencies must be an array of non-blank strings');
  }
  return raw;
}

/**
 * Check whether a descriptor entrypoint stem is path-contained by construction.
 * @param stem - Entrypoint stem from descriptor metadata.
 * @returns Whether the stem can be resolved below the extension root.
 */
function isSafeEntrypointStem(stem: string): boolean {
  if (stem.length === 0 || path.isAbsolute(stem)) return false;
  const normalized = stem.replaceAll(path.win32.sep, path.posix.sep);
  return !normalized.split('/').some((segment) => segment === '..' || segment.length === 0);
}

/**
 * Check whether a value is a string-keyed object.
 * @param value - Value to inspect.
 * @returns Whether the value is a record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
