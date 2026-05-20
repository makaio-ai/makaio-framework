#!/usr/bin/env bun
/**
 * Per-file bun test inspector.
 *
 * Spawns one `bun test --inspect` per file for true process isolation,
 * each with its own WebSocket inspector connection. Works around bun's
 * --isolate bug where swapGlobalForTestIsolation drops the inspector
 * binding after the first batch of files.
 *
 * Uses a gate-preload to hold test execution until the inspector WebSocket
 * is subscribed, preventing the race where fast files finish before the
 * inspector connects.
 *
 * @example
 * ```bash
 * bun scripts/lib/bun-test-inspector-v2.ts
 * bun scripts/lib/bun-test-inspector-v2.ts '**‍/*.bun.test.ts'
 * AI_AGENT=1 bun scripts/lib/bun-test-inspector-v2.ts
 * DEBUG_INSPECTOR=1 bun scripts/lib/bun-test-inspector-v2.ts
 * ```
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';

const quiet = 'AI_AGENT' in process.env;
const debug = 'DEBUG_INSPECTOR' in process.env;
const useColors = !('NO_COLOR' in process.env) && !quiet;
const C = useColors
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

const CONCURRENCY = parseInt(process.env.INSPECTOR_CONCURRENCY ?? '8', 10);
const BASE_PORT = parseInt(process.env.INSPECTOR_BASE_PORT ?? '9274', 10);
const WS_TIMEOUT_MS = 5_000;

// region ── types ────────────────────────────────────────────────────────────

interface TestInfo {
  id: number;
  name: string;
  url: string;
  line: number;
  parentId: number | null;
  type: 'test' | 'describe';
  status?: string;
  elapsed?: number;
}

interface TestError {
  message: string;
  name: string;
  urls: string[];
  lineColumns: number[];
  sourceLines: string[];
}

interface FileResult {
  file: string;
  tests: Map<number, TestInfo>;
  errors: TestError[];
  crashed: boolean;
  exitCode: number;
}

// endregion

// region ── helpers ──────────────────────────────────────────────────────────

function dbg(msg: string): void {
  if (debug) process.stderr.write(`[dbg] ${msg}\n`);
}

function relPath(urlOrPath: string): string {
  let abs = urlOrPath.replace(/^file:\/\//, '');
  if (abs.startsWith('/private')) abs = abs.replace(/^\/private/, '');
  const cwd = process.cwd();
  return abs.startsWith(cwd) ? abs.slice(cwd.length + 1) : abs;
}

function fullName(tests: Map<number, TestInfo>, t: TestInfo): string {
  const parts: string[] = [t.name];
  let cur = t;
  const seen = new Set<number>([t.id]);
  while (cur.parentId != null) {
    if (seen.has(cur.parentId)) break;
    seen.add(cur.parentId);
    const parent = tests.get(cur.parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    cur = parent;
  }
  return parts.join(' > ');
}

function nsToMs(ns: number): string {
  return (ns / 1_000_000).toFixed(2);
}

function expandGlobs(args: string[]): string[] {
  const result: string[] = [];
  for (const arg of args) {
    if (arg.includes('*')) {
      const matches = Array.from(new Bun.Glob(arg).scanSync({ cwd: '.', onlyFiles: true }))
        .sort()
        .map((p) => (p.startsWith('./') ? p : `./${p}`));
      result.push(...(matches.length > 0 ? matches : [arg]));
    } else {
      result.push(arg);
    }
  }
  return result;
}

// endregion

// region ── gate server ──────────────────────────────────────────────────────

interface Gate {
  port: number;
  preloadPath: string;
  openFor: (file: string) => void;
  close: () => void;
}

function createGate(): Gate {
  const pending = new Map<string, () => void>();
  const opened = new Set<string>();

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const file = new URL(req.url).searchParams.get('f') ?? '';
      if (opened.has(file)) return new Response('go');
      return new Promise<Response>((resolve) => {
        pending.set(file, () => resolve(new Response('go')));
      });
    },
  });

  const preloadPath = pathResolve(dirname(new URL(import.meta.url).pathname), 'inspector-gate-preload-v2.ts');

  return {
    port: server.port,
    preloadPath,
    openFor(file: string) {
      opened.add(file);
      const cb = pending.get(file);
      if (cb) { cb(); pending.delete(file); }
    },
    close() { server.stop(true); },
  };
}

// endregion

// region ── per-file inspector ───────────────────────────────────────────────

async function runFile(file: string, port: number, gate: Gate): Promise<FileResult> {
  const result: FileResult = {
    file,
    tests: new Map(),
    errors: [],
    crashed: false,
    exitCode: 0,
  };

  const childEnv = {
    ...process.env,
    __INSPECTOR_GATE_PORT: String(gate.port),
    __INSPECTOR_GATE_FILE: file,
  };
  delete (childEnv as Record<string, string | undefined>).AI_AGENT;

  const child = spawn('bun', ['test', `--inspect=localhost:${port}`, '--preload', gate.preloadPath, file], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: childEnv,
  });

  child.stdout!.on('data', () => {});
  child.stderr!.on('data', () => {});

  const exitCode = new Promise<number>((r) => child.on('close', (code) => r(code ?? 1)));

  // Extract WS URL from stderr
  const wsUrl = await new Promise<string | null>((resolve) => {
    let buf = '';
    let found = false;
    child.stderr!.on('data', (chunk: Buffer) => {
      if (found) return;
      buf += chunk.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { found = true; resolve(m[0]); }
    });
    const timer = setTimeout(() => { if (!found) { found = true; resolve(null); } }, WS_TIMEOUT_MS);
    child.on('close', () => { clearTimeout(timer); if (!found) { found = true; resolve(null); } });
  });

  if (!wsUrl) {
    dbg(`${file}: no WS URL, opening gate anyway`);
    gate.openFor(file);
    result.exitCode = await exitCode;
    return result;
  }

  dbg(`${file}: connecting to ${wsUrl}`);

  let ws: WebSocket | null = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      ws = await new Promise<WebSocket>((resolve, reject) => {
        const s = new WebSocket(wsUrl);
        s.addEventListener('open', () => resolve(s));
        s.addEventListener('error', () => reject());
      });
      break;
    } catch {
      await Bun.sleep(10);
    }
  }
  if (!ws) {
    dbg(`${file}: WS connect failed after retries, opening gate`);
    gate.openFor(file);
    result.exitCode = await exitCode;
    return result;
  }

  // Enable reporters and collect events
  const inspectorDone = new Promise<void>((resolve) => {
    const acks = new Set<number>();

    ws.send(JSON.stringify({ id: 1, method: 'TestReporter.enable' }));
    ws.send(JSON.stringify({ id: 2, method: 'LifecycleReporter.enable' }));

    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));

      if (msg.id === 1 || msg.id === 2) {
        acks.add(msg.id);
        if (acks.size === 2) {
          dbg(`${file}: reporters enabled, opening gate`);
          gate.openFor(file);
        }
      }

      if (!msg.method) return;

      switch (msg.method) {
        case 'TestReporter.found': {
          const p = msg.params;
          result.tests.set(p.id, {
            id: p.id,
            name: p.name,
            url: p.url ?? '',
            line: p.line ?? 0,
            parentId: p.parentId ?? null,
            type: p.type ?? 'test',
          });
          break;
        }
        case 'TestReporter.end': {
          const p = msg.params;
          const t = result.tests.get(p.id);
          if (t) { t.status = p.status; t.elapsed = p.elapsed; }
          break;
        }
        case 'LifecycleReporter.error': {
          result.errors.push(msg.params);
          result.crashed = true;
          setTimeout(() => child.kill('SIGKILL'), 500);
          break;
        }
      }
    });

    ws.addEventListener('close', resolve);
  });

  result.exitCode = await exitCode;
  await inspectorDone;
  return result;
}

// endregion

// region ── pool ─────────────────────────────────────────────────────────────

async function runAll(files: string[], gate: Gate): Promise<FileResult[]> {
  const results: FileResult[] = [];
  let nextPort = BASE_PORT;
  let idx = 0;

  async function next(): Promise<void> {
    while (idx < files.length) {
      const i = idx++;
      const port = nextPort++;
      const file = files[i]!;
      dbg(`[${i + 1}/${files.length}] ${file} on port ${port}`);
      const r = await runFile(file, port, gate);
      results.push(r);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// endregion

// region ── output ───────────────────────────────────────────────────────────

function formatError(e: TestError): string {
  const lines: string[] = [];
  lines.push(`${C.r}${C.b}${e.name}${C.x}: ${e.message}`);
  for (let i = 0; i < e.urls.length; i++) {
    const rel = relPath(e.urls[i]!);
    const line = e.lineColumns[i * 2];
    const col = e.lineColumns[i * 2 + 1];
    lines.push(line != null ? `  ${C.d}at ${rel}:${line}:${col ?? 0}${C.x}` : `  ${C.d}at ${rel}${C.x}`);
  }
  if (e.sourceLines.length > 0) {
    const errorLine = e.sourceLines[0]?.trim();
    if (errorLine) lines.push(`  ${C.r}→ ${errorLine}${C.x}`);
  }
  return lines.join('\n');
}

function printResults(results: FileResult[], elapsed: number): void {
  const allTests: (TestInfo & { file: string })[] = [];
  for (const r of results) {
    for (const t of r.tests.values()) {
      if (t.type === 'test') allTests.push({ ...t, file: r.file });
    }
  }

  const passed = allTests.filter((t) => t.status === 'pass');
  const failed = allTests.filter((t) => t.status === 'fail');
  const skipped = allTests.filter((t) => t.status === 'skip' || t.status === 'todo');
  const timedOut = allTests.filter((t) => t.status === 'timeout');
  const files = new Set(allTests.map((t) => t.url || t.file).filter(Boolean));

  // Log file paths for MAKAIO_TEST_LOG
  const logFile = process.env.MAKAIO_TEST_LOG;
  if (logFile) {
    const paths = results
      .map((r) => r.file)
      .filter((p) => p.endsWith('.bun.test.ts'));
    if (paths.length > 0) appendFileSync(logFile, paths.map((p) => pathResolve(p)).join('\n') + '\n');
  }

  // Per-test output (non-quiet only)
  if (!quiet) {
    for (const t of allTests) {
      const name = fullName(results.find((r) => r.tests.has(t.id))!.tests, t);
      const ms = t.elapsed != null ? ` [${nsToMs(t.elapsed)}ms]` : '';
      if (t.status === 'pass') {
        process.stderr.write(`${C.g}✓${C.x} ${name}${ms}\n`);
      } else if (t.status === 'fail' || t.status === 'timeout') {
        const rel = relPath(t.url || t.file);
        process.stderr.write(`${C.r}✗${C.x} ${name}${ms}  ${C.d}${rel}:${t.line}${C.x}\n`);
      } else if (t.status === 'skip' || t.status === 'todo') {
        process.stderr.write(`${C.y}○${C.x} ${name} (${t.status})\n`);
      }
    }
  }

  // Failure details
  if (failed.length > 0 || timedOut.length > 0) {
    process.stderr.write('\n');
    for (const t of [...failed, ...timedOut]) {
      const name = fullName(results.find((r) => r.tests.has(t.id))!.tests, t);
      const rel = relPath(t.url || t.file);
      process.stderr.write(`${C.r}FAIL${C.x} ${name}\n`);
      process.stderr.write(`  ${C.d}${rel}:${t.line}${C.x}\n`);
    }
  }

  // Lifecycle errors
  for (const r of results) {
    for (const e of r.errors) {
      process.stderr.write('\n' + formatError(e) + '\n');
    }
  }

  // Crash banners
  const crashed = results.filter((r) => r.crashed);
  if (crashed.length > 0) {
    process.stderr.write(`\n${C.r}${C.b}CRASH${C.x}: ${crashed.length} file(s) crashed:\n`);
    for (const r of crashed) process.stderr.write(`  ${C.d}${r.file}${C.x}\n`);
    process.stderr.write('\n');
  }

  // Files with 0 captured tests
  const empty = results.filter((r) => [...r.tests.values()].filter((t) => t.type === 'test').length === 0 && !r.crashed);
  if (empty.length > 0) {
    process.stderr.write(`${C.y}${C.b}NOTE${C.x}: ${empty.length} file(s) had 0 captured test events:\n`);
    for (const r of empty) process.stderr.write(`  ${C.d}${r.file}${C.x}\n`);
    process.stderr.write('\n');
  }

  // Summary
  const parts: string[] = [];
  if (passed.length > 0) parts.push(`${C.g}${passed.length} pass${C.x}`);
  if (failed.length > 0) parts.push(`${C.r}${failed.length} fail${C.x}`);
  if (timedOut.length > 0) parts.push(`${C.r}${timedOut.length} timeout${C.x}`);
  if (skipped.length > 0) parts.push(`${C.y}${skipped.length} skip${C.x}`);

  const secs = (elapsed / 1000).toFixed(2);
  const fileCount = results.length;
  process.stdout.write(`${parts.join(' | ')} across ${fileCount} files [${secs}s]\n`);
}

// endregion

// region ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    rawArgs.push('**/*.bun.test.ts');
  }
  const files = expandGlobs(rawArgs);

  if (files.length === 0) {
    process.stderr.write('No test files found\n');
    process.exitCode = 1;
    return;
  }

  dbg(`${files.length} files, concurrency=${CONCURRENCY}, ports=${BASE_PORT}-${BASE_PORT + files.length - 1}`);

  const gate = createGate();
  dbg(`gate on port ${gate.port}`);

  const startTime = Date.now();
  const results = await runAll(files, gate);
  const elapsed = Date.now() - startTime;

  gate.close();
  printResults(results, elapsed);

  const anyFail = results.some((r) => r.crashed || r.exitCode !== 0);
  process.exitCode = anyFail ? 1 : 0;
}

main();

// endregion
