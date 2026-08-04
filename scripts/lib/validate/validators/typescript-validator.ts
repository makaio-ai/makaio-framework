import * as fssync from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import chalk from 'chalk';
import { minimatch } from 'minimatch';
import ts from 'typescript';
import type { ValidatorContext } from '../util/validator-context.js';
import { loadTypeScript } from '../util/tool-loader.js';

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
const TSGO_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Formats a monotonic elapsed time for verbose validator logging.
 * @param startMs - Start timestamp from performance.now()
 * @returns Elapsed seconds with one decimal place
 */
function formatElapsedSeconds(startMs: number): string {
  return ((performance.now() - startMs) / 1000).toFixed(1);
}

/**
 * Parses flat tsgo CLI output into structured diagnostics.
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
 *
 * `--pretty false` is **required, not cosmetic**: {@link parseTsgoDiagnostics}
 * reads the flat `file(line,col): error TSxxxx: message` form, and a tsgo build
 * that formats prettily on a pipe (colour codes, a summary table) matches none
 * of it — so every diagnostic parses away to nothing and the run reports clean.
 * A type checker that cannot fail is worse than none, so the format the parser
 * depends on is pinned here rather than inherited from the terminal.
 *
 * tsgo uses exit code 0 for clean checks and exit code 2 when diagnostics
 * are found. Stdout is always parsed regardless of exit code — even crashes
 * may emit partial diagnostics worth capturing. Only spawn failures (the
 * process never started) return null.
 * @param tsgoPath - Absolute path to the tsgo binary
 * @param tsConfigFile - Path to tsconfig.json to check
 * @param verbose - Whether to emit progress while tsgo runs
 * @returns Parsed diagnostics, or null on spawn failure
 */
function runTsgoCheck(tsgoPath: string, tsConfigFile: string, verbose = false): Promise<TsgoDiagnostic[] | null> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const displayConfig = path.relative(process.cwd(), tsConfigFile) || tsConfigFile;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (verbose) {
      console.error(chalk.gray(`[tsgo] Checking ${displayConfig}...`));
      heartbeat = setInterval(() => {
        console.error(chalk.gray(`[tsgo] Still checking ${displayConfig} (${formatElapsedSeconds(startedAt)}s)...`));
      }, TSGO_HEARTBEAT_INTERVAL_MS);
      heartbeat.unref?.();
    }

    const clearHeartbeat = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };

    const child = spawn(tsgoPath, ['--noEmit', '--pretty', 'false', '--project', tsConfigFile], {
      cwd: process.cwd(),
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on('close', () => {
      clearHeartbeat();
      if (verbose) {
        console.error(chalk.gray(`[tsgo] Finished ${displayConfig} in ${formatElapsedSeconds(startedAt)}s`));
      }
      resolve(parseTsgoDiagnostics(stdout));
    });
    child.on('error', () => {
      clearHeartbeat();
      resolve(null);
    });
  });
}

/**
 * Reads the project file graph from tsgo without loading TypeScript in-process.
 * @param tsgoPath - Absolute path to the tsgo binary
 * @param tsConfigFile - Path to tsconfig.json to inspect
 * @param verbose - Whether to emit progress while tsgo runs
 * @returns Files included by the project, or null on spawn failure
 */
function runTsgoListFiles(tsgoPath: string, tsConfigFile: string, verbose = false): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const displayConfig = path.relative(process.cwd(), tsConfigFile) || tsConfigFile;
    if (verbose) {
      console.error(chalk.gray(`[tsgo] Listing files for ${displayConfig}...`));
    }

    const child = spawn(tsgoPath, ['--listFilesOnly', '--project', tsConfigFile], {
      cwd: process.cwd(),
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.on('close', () => {
      if (verbose) {
        console.error(chalk.gray(`[tsgo] Listed files for ${displayConfig} in ${formatElapsedSeconds(startedAt)}s`));
      }
      resolve(
        new Set(
          stdout
            .split('\n')
            .map((line) => path.resolve(line.trim()))
            .filter(Boolean),
        ),
      );
    });
    child.on('error', () => {
      resolve(null);
    });
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
 * @param verbose - Whether to emit progress while tsgo runs
 * @returns All files that were checked, or null on spawn failure
 */
async function validateWithTsgo(
  filesByConfig: Map<string, string[]>,
  tsgoPath: string,
  ctx: ValidatorContext,
  verbose = false,
): Promise<string[] | null> {
  const allCheckedFiles: string[] = [];
  const diagCache = new Map<string, TsgoDiagnostic[] | null>();

  for (const configPath of filesByConfig.keys()) {
    if (!diagCache.has(configPath)) {
      diagCache.set(configPath, await runTsgoCheck(tsgoPath, configPath, verbose));
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
    const rootConfig = ts.parseConfigFileTextToJson(
      rootTsConfigPath,
      fssync.readFileSync(rootTsConfigPath, 'utf-8'),
    ).config;
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
 * Validates TypeScript files using a specific tsconfig.
 *
 * Reads the project graph via tsgo, runs tsgo --noEmit for the given config,
 * and filters diagnostics to files in the validation set.
 * @param files - All files being validated (absolute paths)
 * @param tsConfigFile - Explicit tsconfig path to use (absolute path)
 * @param ctx - Validator context for storing results
 * @param verbose - Whether to show detailed progress logging
 * @returns Promise resolving to object with filesChecked
 */
export async function validateTypeScriptWithConfig(
  files: string[],
  tsConfigFile: string,
  ctx: ValidatorContext,
  verbose?: boolean,
): Promise<{ filesChecked: string[] }> {
  const tsFiles = filterTsFilesByRootConfig(files.filter((f) => f.endsWith('.ts') || f.endsWith('.tsx')));

  if (tsFiles.length === 0) {
    return { filesChecked: [] };
  }

  const tsgoPath = findTsgoBinary();
  if (!tsgoPath) {
    throw new Error('tsgo binary not found. Install @typescript/native-preview as a devDependency.');
  }

  const projectFiles = await runTsgoListFiles(tsgoPath, tsConfigFile, verbose);
  if (projectFiles === null) {
    throw new Error(`tsgo --listFilesOnly failed for ${tsConfigFile}`);
  }

  const filesToValidate = tsFiles.filter((file) => projectFiles.has(path.resolve(file)));
  if (filesToValidate.length === 0) {
    return { filesChecked: [] };
  }

  const tsgoCheckedFiles = await validateWithTsgo(new Map([[tsConfigFile, filesToValidate]]), tsgoPath, ctx, verbose);
  if (tsgoCheckedFiles === null) {
    throw new Error(`tsgo --noEmit failed for ${tsConfigFile}`);
  }
  return { filesChecked: tsgoCheckedFiles };
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

/**
 * Validates TypeScript files by discovering tsconfig.json for each file.
 *
 * Groups files by their nearest tsconfig.json, then runs tsgo --noEmit for
 * each unique config. Requires tsgo to be installed.
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

  const tsgoPath = findTsgoBinary();
  if (!tsgoPath) {
    throw new Error('tsgo binary not found. Install @typescript/native-preview as a devDependency.');
  }

  const filesByConfig = groupFilesByNearestConfig(tsFiles);
  const totalStart = performance.now();

  const firstConfigPath = filesByConfig.keys().next().value;
  const ts = await loadTypeScript(firstConfigPath!, tsNs);
  if (!ts) throw new Error('Could not load TypeScript');

  if (verbose) {
    console.error(chalk.gray(`[tsgo] Parsing ${filesByConfig.size} tsconfig.json files...`));
  }

  const filteredFilesByConfig = new Map<string, string[]>();

  for (const [configPath, configFiles] of filesByConfig.entries()) {
    const parsed = parseConfigWithErrorLogging(configPath, ts);
    if (!parsed) continue;

    const filesToValidate = filterFilesIncludedByConfig(configFiles, parsed);
    if (filesToValidate.length === 0) continue;

    filteredFilesByConfig.set(configPath, filesToValidate);
  }

  const checkedFiles = await validateWithTsgo(filteredFilesByConfig, tsgoPath, ctx, verbose);
  if (checkedFiles === null) {
    throw new Error('tsgo --noEmit failed during discovery-based validation');
  }

  if (verbose) {
    const totalElapsed = ((performance.now() - totalStart) / 1000).toFixed(1);
    console.error(chalk.gray(`[tsgo] Total: ${totalElapsed}s`));
  }

  return { filesChecked: checkedFiles };
}
