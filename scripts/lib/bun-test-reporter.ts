#!/usr/bin/env bun
/**
 * Compact bun test reporter that wraps `bun test --parallel` with JUnit XML
 * parsing for structured, CI-friendly output.
 *
 * Spawns bun test with `--reporter=junit`, mutes all raw output, and parses
 * the JUnit XML for a compact summary with clickable failure locations.
 * @example
 * ```bash
 * # Normal run with parallel
 * bun framework/scripts/lib/bun-test-reporter.ts --parallel .bun.test.
 *
 * # Per-file validation (each file gets its own bun test run with a timeout)
 * bun framework/scripts/lib/bun-test-reporter.ts --per-file --timeout 15 .bun.test.
 * ```
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let quiet = 'AI_AGENT' in process.env;
const useColors = !('NO_COLOR' in process.env) && !quiet;

const c = useColors
  ? { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { green: '', red: '', yellow: '', dim: '', bold: '', reset: '' };

// region ── arg parsing ──────────────────────────────────────────────────────

interface CliOptions {
  perFile: boolean;
  timeoutSecs: number;
  concurrency: number;
  verbose: boolean;
  bunArgs: string[];
}

/**
 *
 * @param argv
 */
function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { perFile: false, timeoutSecs: 0, concurrency: 8, verbose: false, bunArgs: [] };
  let i = 0;
  while (i < argv.length) {
    if (argv[i] === '--per-file') {
      opts.perFile = true;
      i++;
    } else if (argv[i] === '--timeout') {
      opts.timeoutSecs = parseInt(argv[++i]!, 10);
      i++;
    } else if (argv[i] === '--concurrency' || argv[i] === '-j') {
      opts.concurrency = parseInt(argv[++i]!, 10);
      i++;
    } else if (argv[i] === '--verbose' || argv[i] === '-v') {
      opts.verbose = true;
      i++;
    } else {
      opts.bunArgs.push(argv[i]!);
      i++;
    }
  }
  return opts;
}

// endregion

// region ── XML helpers ──────────────────────────────────────────────────────

/**
 *
 * @param attrs
 * @param name
 */
function extractAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`));
  return match ? decodeXmlEntities(match[1]!) : undefined;
}

/**
 *
 * @param s
 */
function decodeXmlEntities(s: string): string {
  return s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

// endregion

// region ── types ────────────────────────────────────────────────────────────

interface TestFailure {
  file: string;
  line: number;
  name: string;
  classname: string;
  type: string;
  message: string;
  sourceLine?: string;
}

interface ParseResult {
  failures: TestFailure[];
  totalTests: number;
  totalFailures: number;
  totalErrors: number;
  totalSkipped: number;
  fileCount: number;
}

// endregion

// region ── source context ───────────────────────────────────────────────────

/**
 *
 * @param file
 * @param line
 */
function readSourceLine(file: string, line: number): string | undefined {
  try {
    const lines = readFileSync(file, 'utf-8').split('\n');
    if (line > 0 && line <= lines.length) return lines[line - 1]?.trim();
  } catch {
    /* file not readable */
  }
  return undefined;
}

/**
 *
 * @param file
 */
function resolveFile(file: string): string {
  return file.startsWith('/private') ? file.replace(/^\/private/, '') : file;
}

/**
 *
 * @param absPath
 */
function relPath(absPath: string): string {
  const resolved = resolveFile(absPath);
  const cwd = process.cwd();
  return resolved.startsWith(cwd) ? resolved.slice(cwd.length + 1) : resolved;
}

// endregion

// region ── JUnit parser ─────────────────────────────────────────────────────

/**
 *
 * @param xml
 */
function parseJunitXml(xml: string): ParseResult {
  const failures: TestFailure[] = [];
  const files = new Set<string>();

  let totalTests = 0;
  let totalFailures = 0;
  let totalErrors = 0;
  let totalSkipped = 0;

  const suiteRe = /<testsuite\s+([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = suiteRe.exec(xml)) !== null) {
    totalTests += parseInt(extractAttr(m[1]!, 'tests') ?? '0');
    totalFailures += parseInt(extractAttr(m[1]!, 'failures') ?? '0');
    totalErrors += parseInt(extractAttr(m[1]!, 'errors') ?? '0');
    totalSkipped += parseInt(extractAttr(m[1]!, 'skipped') ?? '0');
  }

  const tcRe = /<testcase\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  while ((m = tcRe.exec(xml)) !== null) {
    const attrs = m[1]!;
    const inner = m[2] ?? '';
    const file = extractAttr(attrs, 'file') ?? '';
    if (file) files.add(file);

    const hasFailure = inner.includes('<failure');
    const hasError = inner.includes('<error');
    if (!hasFailure && !hasError) continue;

    const tag = hasFailure ? 'failure' : 'error';
    const fRe = new RegExp(`<${tag}\\s+([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`);
    const fMatch = inner.match(fRe);
    const fAttrs = fMatch?.[1] ?? '';
    const fText = fMatch?.[2]?.trim() ?? '';
    const line = parseInt(extractAttr(attrs, 'line') ?? '0');
    const resolved = resolveFile(file);

    failures.push({
      file: resolved,
      line,
      name: extractAttr(attrs, 'name') ?? '',
      classname: extractAttr(attrs, 'classname') ?? '',
      type: extractAttr(fAttrs, 'type') ?? 'Error',
      message: extractAttr(fAttrs, 'message') ?? fText,
      sourceLine: resolved && line > 0 ? readSourceLine(resolved, line) : undefined,
    });
  }

  return { failures, totalTests, totalFailures, totalErrors, totalSkipped, fileCount: files.size };
}

// endregion

// region ── output ───────────────────────────────────────────────────────────

/**
 *
 * @param results
 * @param elapsed
 * @param hungFiles
 */
function printResults(results: ParseResult, elapsed: number, hungFiles?: string[], crashedFiles?: string[]): void {
  const { failures, totalTests, totalFailures, totalErrors, totalSkipped, fileCount } = results;
  const passed = totalTests - totalFailures - totalSkipped - totalErrors;

  if (failures.length > 0) {
    if (!quiet) process.stderr.write(`\n${c.red}${c.bold}FAILURES:${c.reset}\n`);

    for (const f of failures) {
      const location = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      const label = f.classname ? `${f.classname} > ${f.name}` : f.name;

      if (quiet) {
        process.stderr.write(`${c.red}FAIL${c.reset} ${label}\n`);
        process.stderr.write(`  ${c.dim}${location}${c.reset}\n`);
      } else {
        process.stderr.write(`\n${c.red}✗${c.reset} ${label}\n`);
        process.stderr.write(`  ${c.dim}${location}${c.reset}\n`);
      }

      if (f.sourceLine) {
        process.stderr.write(`  ${c.dim}→ ${f.sourceLine}${c.reset}\n`);
      }
      if (f.message) {
        process.stderr.write(`  ${f.message.split('\n')[0]}\n`);
      }
    }

    if (!quiet) process.stderr.write('\n');
  }

  if (crashedFiles && crashedFiles.length > 0) {
    process.stderr.write(`\n${c.red}${c.bold}CRASHED (no test output):${c.reset}\n`);
    for (const cr of crashedFiles) {
      process.stderr.write(`  ${c.red}✗${c.reset} ${cr}\n`);
    }
    process.stderr.write('\n');
  }

  if (hungFiles && hungFiles.length > 0) {
    process.stderr.write(`\n${c.yellow}${c.bold}HUNG (timed out):${c.reset}\n`);
    for (const h of hungFiles) {
      process.stderr.write(`  ${c.yellow}⏱${c.reset} ${h}\n`);
    }
    process.stderr.write('\n');
  }

  const crashCount = crashedFiles?.length ?? 0;
  const failCount = totalFailures + crashCount;
  const parts: string[] = [];
  if (passed > 0) parts.push(`${c.green}${passed} pass${c.reset}`);
  if (failCount > 0) parts.push(`${c.red}${failCount} fail${c.reset}`);
  if (totalErrors > 0) parts.push(`${c.red}${totalErrors} error${c.reset}`);
  if (totalSkipped > 0) parts.push(`${c.yellow}${totalSkipped} skip${c.reset}`);
  if (hungFiles && hungFiles.length > 0) parts.push(`${c.yellow}${hungFiles.length} hung${c.reset}`);

  const secs = (elapsed / 1000).toFixed(2);
  process.stdout.write(`\n${parts.join(' | ')} across ${fileCount} files [${secs}s]\n`);
}

// endregion

// region ── per-file mode ────────────────────────────────────────────────────

interface SingleFileResult {
  status: 'pass' | 'fail' | 'hung';
  parsed?: ParseResult;
}

/**
 *
 * @param file
 * @param timeoutMs
 */
function runSingleFile(file: string, timeoutMs: number): Promise<SingleFileResult> {
  return new Promise((resolve) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'bun-pf-'));
    const junitFile = join(tmpDir, 'junit.xml');

    const child = spawn('bun', ['test', '--reporter=junit', `--reporter-outfile=${junitFile}`, file], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        try { rmSync(tmpDir, { recursive: true }); } catch { /* best-effort */ }
        resolve({ status: 'hung' });
      }
    }, timeoutMs);

    child.stdout!.on('data', () => {});
    child.stderr!.on('data', () => {});

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        let parsed: ParseResult | undefined;
        try {
          const xml = readFileSync(junitFile, 'utf-8');
          if (xml) parsed = parseJunitXml(xml);
        } catch { /* file may not exist */ }
        try { rmSync(tmpDir, { recursive: true }); } catch { /* best-effort */ }
        resolve({ status: code === 0 ? 'pass' : 'fail', parsed });
      }
    });
  });
}

/**
 *
 * @param opts
 */
async function perFileMain(opts: CliOptions): Promise<void> {
  const startTime = Date.now();
  const effectiveTimeout = opts.timeoutSecs > 0 ? opts.timeoutSecs : 30;
  const timeoutMs = effectiveTimeout * 1000;

  // Discover test files: use `bun test --list` or find
  const filter = opts.bunArgs.find((a) => !a.startsWith('--')) ?? '.bun.test.';
  const findCmd = `find . -name '*.bun.test.ts' -not -path '*/node_modules/*' -not -path '*/dist/*' | sort`;
  const allFiles = execSync(findCmd, { encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter((f) => f.includes(filter));

  const total = allFiles.length;
  const jobs = opts.concurrency;
  process.stderr.write(`Testing ${total} files individually (${effectiveTimeout}s timeout, ${jobs} concurrent)...\n\n`);

  let passFiles = 0;
  let failFiles = 0;
  let completed = 0;
  const allFailures: TestFailure[] = [];
  const crashedFiles: string[] = [];
  const hungFiles: string[] = [];
  let aggregatedTests = 0;
  let aggregatedSkipped = 0;

  async function processFile(f: string): Promise<void> {
    const rel = relPath(f);
    const { status, parsed } = await runSingleFile(f, timeoutMs);
    completed++;

    if (parsed) {
      aggregatedTests += parsed.totalTests;
      aggregatedSkipped += parsed.totalSkipped;
    }

    if (status === 'pass') {
      passFiles++;
      if (!quiet) process.stderr.write(`${c.green}✓${c.reset} [${completed}/${total}] ${rel}\n`);
    } else if (status === 'hung') {
      hungFiles.push(rel);
      process.stderr.write(`${c.yellow}⏱${c.reset} [${completed}/${total}] ${rel} ${c.yellow}(hung)${c.reset}\n`);
    } else {
      failFiles++;
      if (parsed && parsed.failures.length > 0) {
        allFailures.push(...parsed.failures);
      } else {
        crashedFiles.push(rel);
      }
      process.stderr.write(`${c.red}✗${c.reset} [${completed}/${total}] ${rel}\n`);
    }
  }

  // Run files with bounded concurrency
  const pending = [...allFiles];
  const active: Promise<void>[] = [];

  while (pending.length > 0 || active.length > 0) {
    while (active.length < jobs && pending.length > 0) {
      const f = pending.shift()!;
      const p = processFile(f).then(() => {
        active.splice(active.indexOf(p), 1);
      });
      active.push(p);
    }
    if (active.length > 0) await Promise.race(active);
  }

  const elapsed = Date.now() - startTime;
  const results: ParseResult = {
    failures: allFailures,
    totalTests: aggregatedTests,
    totalFailures: allFailures.length,
    totalErrors: 0,
    totalSkipped: aggregatedSkipped,
    fileCount: total,
  };

  printResults(results, elapsed, hungFiles, crashedFiles);
  process.exitCode = failFiles > 0 || hungFiles.length > 0 ? 1 : 0;
}

// endregion

// region ── batch mode (default) ─────────────────────────────────────────────

/**
 *
 * @param opts
 */
async function batchMain(opts: CliOptions): Promise<void> {
  const startTime = Date.now();

  const tmpDir = mkdtempSync(join(tmpdir(), 'bun-test-'));
  const junitFile = join(tmpDir, 'junit.xml');

  const child = spawn('bun', ['test', '--reporter=junit', `--reporter-outfile=${junitFile}`, ...opts.bunArgs], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let settled = false;

  // Global timeout for the entire run
  const timer =
    opts.timeoutSecs > 0
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill('SIGKILL');
            process.stderr.write(`\n${c.red}bun test killed after ${opts.timeoutSecs}s timeout${c.reset}\n`);
          }
        }, opts.timeoutSecs * 1000)
      : undefined;

  child.stdout!.on('data', () => {});

  const stderrChunks: Buffer[] = [];
  child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  return new Promise((resolve) => {
    child.on('close', (code) => {
      settled = true;
      if (timer) clearTimeout(timer);
      const elapsed = Date.now() - startTime;

      let junitXml = '';
      try {
        junitXml = readFileSync(junitFile, 'utf-8');
      } catch {
        /* file may not exist if bun crashed */
      }

      try {
        rmSync(tmpDir, { recursive: true });
      } catch {
        /* best-effort */
      }

      if (!junitXml) {
        const stderr = Buffer.concat(stderrChunks).toString().trim();
        process.stderr.write(`${c.red}bun test produced no output${c.reset}\n`);
        if (stderr) process.stderr.write(`${stderr}\n`);
        process.exitCode = code ?? 1;
        resolve();
        return;
      }

      const results = parseJunitXml(junitXml);
      printResults(results, elapsed);

      if (results.totalFailures === 0 && results.totalErrors === 0) {
        const stderr = Buffer.concat(stderrChunks).toString().trim();
        if (stderr) {
          process.stderr.write(`\n${c.yellow}stderr:${c.reset}\n${stderr}\n`);
        }
      }

      process.exitCode = results.totalFailures > 0 || results.totalErrors > 0 ? 1 : (code ?? 0);
      resolve();
    });
  });
}

// endregion

// region ── main ─────────────────────────────────────────────────────────────

const opts = parseArgs(process.argv.slice(2));
if (opts.verbose) quiet = false;

if (opts.perFile) {
  perFileMain(opts);
} else {
  batchMain(opts);
}

// endregion
