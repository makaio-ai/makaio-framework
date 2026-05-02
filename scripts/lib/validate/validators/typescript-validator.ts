import * as fssync from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { minimatch } from 'minimatch';
import type { ValidatorContext } from '../util/validator-context.js';
import { loadTypeScript } from '../util/tool-loader.js';
import {
  getTypeCheckRelevantOptions,
  createOptionsFingerprint,
  groupConfigsByFingerprint,
  type ParsedConfigInfo,
} from '../util/tsconfig-dedup.js';

// ---------------------------------------------------------------------------
// tsgo subprocess support
// ---------------------------------------------------------------------------

/**
 * Locates the tsgo binary shipped by @typescript/native-preview.
 * @param cwd - Workspace root used to locate node_modules/.bin
 * @param platform - Platform used to select npm/Yarn shim names
 * @returns Absolute path to tsgo, or null if the package is not installed.
 */
export function findTsgoBinary(
  cwd: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  const binDir = path.resolve(cwd, 'node_modules/.bin');
  const candidateNames = platform === 'win32' ? ['tsgo.cmd', 'tsgo.exe', 'tsgo'] : ['tsgo'];
  const match = candidateNames.map((name) => path.join(binDir, name)).find((candidate) => fssync.existsSync(candidate));
  return match ?? null;
}

interface TsgoDiagnostic {
  /** Absolute path resolved against cwd */
  file: string;
  line: number;
  column: number;
  isError: boolean;
  code: number;
  message: string;
}

// Matches: /some/path.ts(10,5): error TS2345: message text
const TSGO_DIAG_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) TS(\d+): (.+)$/;

/**
 * Parses flat tsgo/tsc CLI output into structured diagnostics.
 * Context / detail continuation lines that don't match the pattern are ignored.
 * @param output - Raw stdout captured from the tsgo process
 * @returns Parsed diagnostics
 */
function parseTsgoDiagnostics(output: string): TsgoDiagnostic[] {
  const result: TsgoDiagnostic[] = [];
  for (const line of output.split('\n')) {
    const m = TSGO_DIAG_RE.exec(line);
    if (!m) continue;
    result.push({
      file: path.resolve(m[1]!.trim()),
      line: parseInt(m[2]!, 10),
      column: parseInt(m[3]!, 10),
      isError: m[4] === 'error',
      code: parseInt(m[5]!, 10),
      message: m[6]!,
    });
  }
  return result;
}

/**
 * Spawns tsgo --noEmit for the given tsconfig and returns all diagnostics.
 * Stdout is piped and parsed; stderr is inherited for debug visibility.
 * @param tsgoPath - Absolute path to the tsgo binary
 * @param tsConfigFile - Path to tsconfig.json to check
 * @returns Parsed diagnostics, or null when tsgo did not complete successfully
 */
function runTsgoCheck(tsgoPath: string, tsConfigFile: string): Promise<TsgoDiagnostic[] | null> {
  return new Promise((resolve) => {
    const child = spawn(tsgoPath, ['--noEmit', '--project', tsConfigFile], {
      cwd: process.cwd(),
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on('close', (code) => resolve(code === 0 ? parseTsgoDiagnostics(stdout) : null));
    child.on('error', () => resolve(null));
  });
}

/**
 * Feeds tsgo diagnostics into the validator context, filtered to the requested file set.
 * @param diagnostics - All diagnostics returned by tsgo (full-project scope)
 * @param filesToValidate - Only errors for files in this set are reported
 * @param ctx - Validator context
 */
function processTsgoDiagnostics(
  diagnostics: TsgoDiagnostic[],
  filesToValidate: Set<string>,
  ctx: ValidatorContext,
): void {
  for (const d of diagnostics) {
    if (!filesToValidate.has(d.file)) continue;
    ctx.addResult(d.file, {
      tool: 'typescript',
      message: d.message,
      severity: d.isError ? 'error' : 'warning',
      line: d.line,
      column: d.column,
      ruleId: `TS${d.code}`,
      fixable: false,
    });
  }
}

/**
 * Validates a set of files grouped by tsconfig using tsgo subprocesses.
 * Each unique tsconfig path is checked at most once; results are filtered
 * to the files that belong to each group.
 * @param filesByConfig - Map of tsconfig path → files to validate
 * @param tsgoPath - Absolute path to the tsgo binary
 * @param ctx - Validator context
 * @returns All files that were checked, or null when tsgo failed
 */
async function validateWithTsgo(
  filesByConfig: Map<string, string[]>,
  tsgoPath: string,
  ctx: ValidatorContext,
): Promise<string[] | null> {
  const allCheckedFiles: string[] = [];
  const diagCache = new Map<string, TsgoDiagnostic[] | null>();

  for (const configPath of filesByConfig.keys()) {
    if (!diagCache.has(configPath)) {
      diagCache.set(configPath, await runTsgoCheck(tsgoPath, configPath));
    }
    const diagnostics = diagCache.get(configPath)!;
    if (diagnostics === null) {
      return null;
    }
  }

  for (const [configPath, configFiles] of filesByConfig) {
    const diagnostics = diagCache.get(configPath)!;
    const filesToValidate = new Set(configFiles.map((f) => path.resolve(f)));
    processTsgoDiagnostics(diagnostics, filesToValidate, ctx);
    allCheckedFiles.push(...configFiles);
  }

  return allCheckedFiles;
}

/**
 * Finds the nearest tsconfig.json file by walking up the directory tree.
 *
 * Walks up from the file's directory to the filesystem root, returning the
 * first tsconfig.json found.
 * @param filePath - File path to start searching from
 * @returns Path to tsconfig.json or null if not found
 */
export function findNearestTsConfig(filePath: string): string | null {
  let currentDir = path.dirname(filePath);
  const rootDir = path.parse(currentDir).root;

  while (currentDir !== rootDir) {
    const configPath = path.join(currentDir, 'tsconfig.json');
    if (fssync.existsSync(configPath)) {
      return configPath;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break; // Reached root
    currentDir = parentDir;
  }

  return null;
}

/**
 * Filters TypeScript files based on root tsconfig exclude patterns.
 *
 * Reads the root tsconfig.json and filters out files matching its exclude
 * patterns using minimatch for glob pattern matching.
 * @param tsFiles - TypeScript files to filter (absolute paths)
 * @returns Filtered list of TypeScript files not excluded by root config
 */
export function filterTsFilesByRootConfig(tsFiles: string[]): string[] {
  const rootTsConfigPath = path.resolve(process.cwd(), 'tsconfig.json');
  if (!fssync.existsSync(rootTsConfigPath)) {
    return tsFiles;
  }

  try {
    const rootConfig = JSON.parse(fssync.readFileSync(rootTsConfigPath, 'utf-8'));
    const rootExcludePatterns: string[] = rootConfig.exclude || [];

    // Pre-compile minimatch matchers outside the filter loop for performance
    const matchers = rootExcludePatterns.map((pattern) => {
      // Use minimatch for proper glob pattern matching
      return (filePath: string) => {
        const relativePath = path.relative(process.cwd(), filePath);
        // Normalize path separators for consistent matching across platforms
        const normalizedPath = relativePath.split(path.sep).join('/');
        return minimatch(normalizedPath, pattern, {
          matchBase: true,
          dot: true,
        });
      };
    });

    // Filter out files matching root exclude patterns, but preserve files that
    // have their own nearer tsconfig (e.g. platform-specific apps). Those files
    // should be validated against their own project config, not dropped globally.
    return tsFiles.filter((file) => {
      const matchesRootExclude = matchers.some((matcher) => matcher(file));
      if (!matchesRootExclude) {
        return true;
      }

      const nearestConfig = findNearestTsConfig(file);
      if (!nearestConfig) {
        return false;
      }

      return path.resolve(nearestConfig) !== rootTsConfigPath;
    });
  } catch {
    // Ignore errors reading root config
    return tsFiles;
  }
}

/**
 * Groups files by their nearest tsconfig.json.
 * @param tsFiles - TypeScript files to group (absolute paths)
 * @returns Map of tsconfig path to files using that config
 */
function groupFilesByNearestConfig(tsFiles: string[]): Map<string, string[]> {
  const filesByConfig = new Map<string, string[]>();
  for (const file of tsFiles) {
    const configPath = findNearestTsConfig(file);
    if (!configPath) continue;
    const list = filesByConfig.get(configPath) ?? [];
    list.push(file);
    filesByConfig.set(configPath, list);
  }
  return filesByConfig;
}

/**
 * Processes TypeScript diagnostics and adds them to the validator context.
 * @param diagnostics - All diagnostics from TypeScript
 * @param filesToValidate - Set of files we want to validate
 * @param ts - TypeScript namespace
 * @param ctx - Validator context for storing results
 */
function processDiagnostics(
  diagnostics: readonly import('typescript').Diagnostic[],
  filesToValidate: Set<string>,
  ts: typeof import('typescript'),
  ctx: ValidatorContext,
): void {
  for (const diagnostic of diagnostics) {
    if (!diagnostic.file) continue;
    const file = diagnostic.file.fileName;
    if (!filesToValidate.has(file)) continue;
    const start = diagnostic.start || 0;
    const { line, character } = ts.getLineAndCharacterOfPosition(diagnostic.file, start);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    const isError = diagnostic.category === ts.DiagnosticCategory.Error;
    ctx.addResult(file, {
      tool: 'typescript',
      message,
      severity: isError ? 'error' : 'warning',
      line: line + 1,
      column: character + 1,
      ruleId: `TS${diagnostic.code}`,
      fixable: false,
    });
  }
}

/**
 * Validates TypeScript files using a specific tsconfig.
 *
 * Creates a TypeScript program with the specified config and collects
 * diagnostics for the requested files. Filters diagnostics to only include
 * files in the validation set.
 * @param files - All files being validated (absolute paths)
 * @param tsConfigFile - Explicit tsconfig path to use (absolute path)
 * @param ctx - Validator context for storing results
 * @param tsNs - Existing TypeScript namespace (will be loaded if not provided)
 * @returns Promise resolving to object with filesChecked
 */
export async function validateTypeScriptWithConfig(
  files: string[],
  tsConfigFile: string,
  ctx: ValidatorContext,
  tsNs?: typeof import('typescript'),
): Promise<{ filesChecked: string[] }> {
  const tsFiles = filterTsFilesByRootConfig(files.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx')));

  if (tsFiles.length === 0) {
    return { filesChecked: [] };
  }

  const ts = await loadTypeScript(tsConfigFile, tsNs);
  const { config } = ts.readConfigFile(tsConfigFile, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(tsConfigFile));

  // Intersect with the config's file list so we only report files the program
  // actually includes. Without this, files preserved by filterTsFilesByRootConfig
  // (because they have a nearer tsconfig) would be counted as checked but never
  // actually type-checked by this program.
  const checkedFiles = filterFilesIncludedByConfig(tsFiles, parsed);

  // Prefer tsgo when installed — subprocess call, ~10x faster than tsc programmatic API.
  const tsgoPath = findTsgoBinary();
  if (tsgoPath) {
    if (parsed.errors.length === 0 && checkedFiles.length > 0) {
      const tsgoCheckedFiles = await validateWithTsgo(new Map([[tsConfigFile, checkedFiles]]), tsgoPath, ctx);
      if (tsgoCheckedFiles !== null) {
        return { filesChecked: tsgoCheckedFiles };
      }
    } else {
      return { filesChecked: checkedFiles };
    }
  }

  if (parsed.errors.length === 0 && checkedFiles.length > 0) {
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: { ...parsed.options, noEmit: true },
    });
    const filesToValidate = new Set(checkedFiles);
    const allDiagnostics = [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSemanticDiagnostics(),
      ...program.getSyntacticDiagnostics(),
    ];
    processDiagnostics(allDiagnostics, filesToValidate, ts, ctx);
  }

  return { filesChecked: checkedFiles };
}

/**
 * Parses tsconfig and logs errors if any occur.
 * @param configPath - Path to tsconfig.json
 * @param ts - TypeScript namespace
 * @returns Parsed config or null if errors occurred
 */
function parseConfigWithErrorLogging(
  configPath: string,
  ts: typeof import('typescript'),
): import('typescript').ParsedCommandLine | null {
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.dirname(configPath));

  if (parsed.errors.length > 0) {
    console.error(chalk.red(`Error parsing ${configPath}:`));
    parsed.errors.forEach((error) => {
      const message = ts.flattenDiagnosticMessageText(error.messageText, '\n');
      console.error(`  ${message}`);
    });
    return null;
  }

  return parsed;
}

/**
 * Selects requested files that are included by a parsed tsconfig.
 * @param configFiles - Files associated with the tsconfig
 * @param parsed - Parsed TypeScript configuration
 * @returns Files that TypeScript actually includes in the project
 */
function filterFilesIncludedByConfig(configFiles: string[], parsed: import('typescript').ParsedCommandLine): string[] {
  const parsedFileSet = new Set(parsed.fileNames.map((f) => path.resolve(f)));
  return configFiles.filter((file) => parsedFileSet.has(path.resolve(file)));
}

// NOTE: do NOT change without explicit human approval
/* eslint max-lines-per-function: ["error", { "max": 150 }] */
/**
 * Validates TypeScript files by discovering tsconfig.json for each file.
 *
 * Groups files by their nearest tsconfig.json (walking up directory tree),
 * then deduplicates configs with identical type-check-relevant compiler options.
 * Configs sharing the same options use a single TypeScript program for efficiency.
 * @param files - All files being validated (absolute paths)
 * @param ctx - Validator context for storing results
 * @param tsNs - Existing TypeScript namespace (will be loaded if not provided)
 * @param verbose - Whether to show detailed progress logging
 * @returns Promise resolving to object with filesChecked
 */
export async function validateTypeScriptByDiscovery(
  files: string[],
  ctx: ValidatorContext,
  tsNs?: typeof import('typescript'),
  verbose?: boolean,
): Promise<{ filesChecked: string[] }> {
  const tsFiles = filterTsFilesByRootConfig(files.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx')));

  if (tsFiles.length === 0) {
    return { filesChecked: [] };
  }

  const filesByConfig = groupFilesByNearestConfig(tsFiles);
  const allCheckedFiles: string[] = [];
  const totalStart = performance.now();

  // Load TypeScript once
  const firstConfigPath = filesByConfig.keys().next().value;
  const ts = await loadTypeScript(firstConfigPath!, tsNs);
  if (!ts) throw new Error('Could not load TypeScript');

  // Phase 1: Parse all configs and compute fingerprints
  if (verbose) {
    console.error(chalk.gray(`[tsc] Parsing ${filesByConfig.size} tsconfig.json files...`));
  }
  const parsedConfigs: ParsedConfigInfo[] = [];

  for (const [configPath, configFiles] of filesByConfig.entries()) {
    const parsed = parseConfigWithErrorLogging(configPath, ts);
    if (!parsed) continue;

    const filesToValidate = filterFilesIncludedByConfig(configFiles, parsed);

    if (filesToValidate.length === 0) continue;

    const relevantOptions = getTypeCheckRelevantOptions(parsed.options);
    const fingerprint = createOptionsFingerprint(relevantOptions, configPath);

    parsedConfigs.push({
      configPath,
      parsed,
      fingerprint,
      filesToValidate,
    });
  }

  // Prefer tsgo when installed — subprocess call, ~10x faster than tsc programmatic API.
  const tsgoPath = findTsgoBinary();
  if (tsgoPath) {
    const filteredFilesByConfig = new Map(parsedConfigs.map((config) => [config.configPath, config.filesToValidate]));
    const checkedFiles = await validateWithTsgo(filteredFilesByConfig, tsgoPath, ctx);
    if (checkedFiles !== null) {
      return { filesChecked: checkedFiles };
    }
  }

  // Phase 2: Group by fingerprint to deduplicate
  const configGroups = groupConfigsByFingerprint(parsedConfigs);
  const totalGroups = configGroups.size;
  if (verbose) {
    console.error(
      chalk.gray(`[tsc] Deduplicated ${parsedConfigs.length} configs into ${totalGroups} unique compiler option sets`),
    );
  }

  // Phase 3: Create one program per unique fingerprint
  let groupIndex = 0;
  for (const [_fingerprint, configs] of configGroups.entries()) {
    groupIndex++;
    const groupStart = performance.now();

    // Collect all files from all configs in this group
    const allFilesToValidate = new Set<string>();
    const allRootNames = new Set<string>();

    for (const config of configs) {
      for (const file of config.filesToValidate) {
        allFilesToValidate.add(file);
      }
      for (const file of config.parsed.fileNames) {
        allRootNames.add(file);
      }
    }

    allCheckedFiles.push(...allFilesToValidate);

    // Use options from first config (they're all equivalent for type-checking)
    const representativeConfig = configs[0];
    const program = ts.createProgram({
      rootNames: [...allRootNames],
      options: { ...representativeConfig.parsed.options, noEmit: true },
    });

    const allDiagnostics = [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSemanticDiagnostics(),
      ...program.getSyntacticDiagnostics(),
    ];

    processDiagnostics(allDiagnostics, allFilesToValidate, ts, ctx);

    if (verbose) {
      const elapsed = ((performance.now() - groupStart) / 1000).toFixed(1);
      const configNames = configs.map((c) => path.relative(process.cwd(), c.configPath)).join(', ');
      const configLabel = configs.length === 1 ? configNames : `${configs.length} configs`;
      console.error(
        chalk.gray(`[tsc] ${groupIndex}/${totalGroups} ${configLabel} (${allRootNames.size} files) ${elapsed}s`),
      );
    }
  }

  if (verbose) {
    const totalElapsed = ((performance.now() - totalStart) / 1000).toFixed(1);
    console.error(chalk.gray(`[tsc] Total: ${totalElapsed}s`));
  }

  return { filesChecked: allCheckedFiles };
}
