import type { CompilerOptions, ParsedCommandLine } from 'typescript';
import path from 'path';

/**
 * Compiler options that only affect emit, not type-checking.
 * These are excluded when comparing configs for deduplication.
 */
const EMIT_ONLY_OPTIONS: Set<keyof CompilerOptions> = new Set([
  'outDir',
  'outFile',
  'declarationDir',
  'declaration',
  'declarationMap',
  'emitDeclarationOnly',
  'sourceMap',
  'inlineSourceMap',
  'inlineSources',
  'mapRoot',
  'sourceRoot',
  'removeComments',
  'emitBOM',
  'newLine',
  'preserveConstEnums',
  'noEmit',
  'tsBuildInfoFile',
  'incremental',
  'composite',
]);

/**
 * Parsed config info for deduplication.
 */
export interface ParsedConfigInfo {
  configPath: string;
  parsed: ParsedCommandLine;
  fingerprint: string;
  filesToValidate: string[];
}

/**
 * Extracts type-check-relevant compiler options, excluding emit-only options.
 * @param options - Full compiler options from parsed tsconfig
 * @returns Filtered options relevant for type checking
 */
export function getTypeCheckRelevantOptions(options: CompilerOptions): Partial<CompilerOptions> {
  const relevant: Partial<CompilerOptions> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!EMIT_ONLY_OPTIONS.has(key as keyof CompilerOptions)) {
      (relevant as Record<string, unknown>)[key] = value;
    }
  }
  return relevant;
}

/**
 * Creates a stable fingerprint for compiler options to enable deduplication.
 * @param options - Compiler options to fingerprint
 * @param configPath - Path to the tsconfig that produced these options
 * @returns Stable string fingerprint
 */
export function createOptionsFingerprint(options: Partial<CompilerOptions>, configPath: string): string {
  const sorted = Object.keys(options)
    .sort()
    .reduce(
      (acc, key) => {
        acc[key] = (options as Record<string, unknown>)[key];
        return acc;
      },
      {} as Record<string, unknown>,
    );

  // Config directory affects module/type resolution (node_modules lookup, typeRoots).
  // Treat configs in different directories as distinct programs, even with identical
  // compiler options, to avoid cross-project type pollution.
  return JSON.stringify({
    options: sorted,
    configDir: path.dirname(configPath),
  });
}

/**
 * Groups parsed configs by their type-check-relevant options fingerprint.
 * Configs with identical fingerprints can share a single TypeScript program.
 * @param configs - Array of parsed config info
 * @returns Map of fingerprint to configs sharing that fingerprint
 */
export function groupConfigsByFingerprint(configs: ParsedConfigInfo[]): Map<string, ParsedConfigInfo[]> {
  const groups = new Map<string, ParsedConfigInfo[]>();
  for (const config of configs) {
    const list = groups.get(config.fingerprint) ?? [];
    list.push(config);
    groups.set(config.fingerprint, list);
  }
  return groups;
}
