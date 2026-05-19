import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import type { ValidationResult } from '../types.js';
import type { BiomeCli } from '../util/tool-loader.js';
import type { ValidatorContext } from '../util/validator-context.js';

const BIOME_SUPPORTED_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.cts',
  '.js',
  '.json',
  '.jsonc',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

const BIOME_IGNORED_PATH_SEGMENTS = new Set([
  '.next',
  '.yarn',
  'build',
  'coverage',
  'dist',
  'fixtures',
  '__fixtures__',
  'node_modules',
  'release',
]);

const MAX_BIOME_DIAGNOSTICS = 200;
const BIOME_FILE_CHUNK_SIZE = 250;

interface BiomeRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: {
      uri?: string;
    };
    region?: {
      startLine?: number;
      startColumn?: number;
      endLine?: number;
      endColumn?: number;
    };
  };
}

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: {
    text?: string;
  };
  locations?: SarifLocation[];
}

interface SarifReport {
  runs?: Array<{
    results?: SarifResult[];
  }>;
}

/**
 * Checks if Biome can process a file with the configured formatter surface.
 * @param file - Absolute file path.
 * @returns True when the file extension is supported by Biome formatting.
 */
function isBiomeSupportedFile(file: string): boolean {
  if (!BIOME_SUPPORTED_EXTENSIONS.has(path.extname(file))) {
    return false;
  }

  const relativePath = path.relative(process.cwd(), file);
  const pathSegments = relativePath.split(path.sep);
  return pathSegments.every((segment) => !BIOME_IGNORED_PATH_SEGMENTS.has(segment));
}

/**
 * Runs the Biome launcher through the current Node executable.
 * @param biome - Resolved Biome CLI metadata.
 * @param args - Arguments passed to `biome`.
 * @returns Captured Biome process result.
 */
async function runBiome(biome: BiomeCli, args: string[]): Promise<BiomeRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [biome.binPath, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

/**
 * Reads the SARIF reporter payload emitted by Biome.
 * @param reportPath - Absolute path to the reporter output file.
 * @returns Parsed SARIF report, or an empty report when no report exists.
 */
async function readSarifReport(reportPath: string): Promise<SarifReport> {
  let output: string;
  try {
    output = await fs.readFile(reportPath, 'utf-8');
  } catch {
    return {};
  }

  const parsed = JSON.parse(output) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }

  return parsed as SarifReport;
}

/**
 * Converts SARIF levels to validator severities.
 * @param level - SARIF result level.
 * @returns Validation severity.
 */
function mapLevel(level: string | undefined): ValidationResult['severity'] {
  if (level === 'warning' || level === 'warn') return 'warning';
  if (level === 'note' || level === 'info') return 'info';
  return 'error';
}

/**
 * Converts a SARIF artifact URI to an absolute path.
 * @param uri - SARIF artifact URI.
 * @returns Absolute file path, or undefined when no URI is present.
 */
function resolveSarifArtifactPath(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  if (uri.startsWith('file://')) return fileURLToPath(uri);
  return path.isAbsolute(uri) ? uri : path.resolve(process.cwd(), uri);
}

/**
 * Reads files before a fix run so changed files can be reported precisely.
 * @param files - Absolute paths to capture.
 * @returns Original file contents keyed by path.
 */
async function readOriginalContents(files: string[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  await Promise.all(
    files.map(async (file) => {
      contents.set(file, await fs.readFile(file, 'utf-8'));
    }),
  );
  return contents;
}

/**
 * Adds SARIF results to the validation context.
 * @param report - SARIF report emitted by Biome.
 * @param ctx - Validator context for storing results.
 */
function addSarifResults(report: SarifReport, ctx: ValidatorContext): void {
  for (const run of report.runs ?? []) {
    for (const result of run.results ?? []) {
      const isFormatResult = result.ruleId === 'format';
      const location = result.locations?.[0];
      const region = location?.physicalLocation?.region;
      const file = resolveSarifArtifactPath(location?.physicalLocation?.artifactLocation?.uri);
      if (!file) {
        continue;
      }

      ctx.addResult(file, {
        tool: 'biome',
        message: isFormatResult
          ? 'File needs Biome formatting; run this validation command with --fix to update it.'
          : (result.message?.text ?? 'Biome issue'),
        severity: mapLevel(result.level),
        line: region?.startLine,
        column: region?.startColumn,
        endLine: region?.endLine,
        endColumn: region?.endColumn,
        fixable: isFormatResult,
        fixedAutomatically: false,
        ruleId: isFormatResult ? undefined : result.ruleId,
      });
    }
  }
}

/**
 * Counts SARIF results across all runs.
 * @param report - SARIF report emitted by Biome.
 * @returns Number of results.
 */
function countSarifResults(report: SarifReport): number {
  return (report.runs ?? []).reduce((count, run) => count + (run.results?.length ?? 0), 0);
}

/**
 * Splits a file list into bounded chunks for stable Biome CLI invocations.
 * @param files - Files to chunk.
 * @returns File chunks with at most `BIOME_FILE_CHUNK_SIZE` entries.
 */
function chunkFiles(files: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < files.length; index += BIOME_FILE_CHUNK_SIZE) {
    chunks.push(files.slice(index, index + BIOME_FILE_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * Adds auto-fix results for files changed by Biome.
 * @param originalContents - Original file contents before running Biome.
 * @param ctx - Validator context for storing results.
 */
async function addFixedResults(originalContents: Map<string, string>, ctx: ValidatorContext): Promise<void> {
  await Promise.all(
    Array.from(originalContents.entries()).map(async ([file, original]) => {
      const updated = await fs.readFile(file, 'utf-8');
      if (updated === original) {
        return;
      }

      ctx.addResult(file, {
        tool: 'biome',
        message: 'File was automatically fixed by Biome',
        severity: 'info',
        fixable: true,
        fixedAutomatically: true,
      });
    }),
  );
}

/**
 * Validates files with Biome formatting and baseline-clean lint rules.
 *
 * Biome currently replaces Prettier formatting for JavaScript, TypeScript,
 * JSON, and CSS files. It also owns ESLint-compatible rules that are clean for
 * this workspace. SCSS remains with Stylelint because Biome does not process
 * `.scss` files as of Biome 2.4.
 * @param files - Absolute file paths to validate.
 * @param biome - Resolved Biome CLI metadata.
 * @param ctx - Validator context for storing results.
 * @param autoFix - Whether to auto-fix formatting issues.
 * @returns Files checked by Biome.
 */
export async function validateBiome(
  files: string[],
  biome: BiomeCli,
  ctx: ValidatorContext,
  autoFix?: boolean,
): Promise<{ configFound: boolean; filesChecked: string[] }> {
  const filesChecked = files.filter(isBiomeSupportedFile);
  if (filesChecked.length === 0) {
    return { configFound: false, filesChecked };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-biome-'));
  const originalContents = autoFix ? await readOriginalContents(filesChecked) : undefined;
  try {
    for (const [chunkIndex, fileChunk] of chunkFiles(filesChecked).entries()) {
      const reportPath = path.join(tempDir, `report-${chunkIndex}.json`);
      const args = [
        'check',
        '--reporter=sarif',
        `--reporter-file=${reportPath}`,
        `--max-diagnostics=${MAX_BIOME_DIAGNOSTICS}`,
        '--assist-enabled=false',
        '--files-ignore-unknown=true',
        ...(autoFix ? ['--write'] : []),
        ...fileChunk,
      ];
      const result = await runBiome(biome, args);
      const report = await readSarifReport(reportPath);
      const resultCount = countSarifResults(report);
      addSarifResults(report, ctx);

      if (result.exitCode !== 0 && resultCount === 0) {
        throw new Error(result.stderr || result.stdout || `Biome exited with code ${result.exitCode}`);
      }
    }

    if (originalContents) {
      await addFixedResults(originalContents, ctx);
    }

    return { configFound: true, filesChecked };
  } finally {
    await fs.rm(tempDir, { force: true, recursive: true });
  }
}
