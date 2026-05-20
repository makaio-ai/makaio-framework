#!/usr/bin/env bun
/**
 * Prototype: bun test reporter using the WebKit Inspector Protocol.
 *
 * Connects to bun's built-in inspector via WebSocket for structured,
 * real-time test events. Detects bun crashes (TypeError etc.) and
 * aborts immediately with an honest error instead of hanging.
 *
 * @example
 * ```bash
 * bun scripts/lib/bun-test-inspector.ts .bun.test.
 * AI_AGENT=1 bun scripts/lib/bun-test-inspector.ts .bun.test.
 * ```
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const quiet = 'AI_AGENT' in process.env;
const debug = 'DEBUG_INSPECTOR' in process.env;
const useColors = !('NO_COLOR' in process.env) && !quiet;
const C = useColors
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };

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

// endregion

// region ── helpers ──────────────────────────────────────────────────────────

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

// region ── inspector client ─────────────────────────────────────────────────

interface InspectorHandle {
  tests: Map<number, TestInfo>;
  errors: TestError[];
  crashed: boolean;
  ready: Promise<void>;
  closed: Promise<void>;
}

/**
 * @param wsUrl - WebSocket inspector URL
 * @param onCrash - called when a LifecycleReporter.error is detected
 */
function connectInspector(wsUrl: string, onCrash?: () => void): InspectorHandle {
  const handle: InspectorHandle = {
    tests: new Map(),
    errors: [],
    crashed: false,
    ready: Promise.resolve(),
    closed: Promise.resolve(),
  };
  let msgId = 1;
  let resolveReady: () => void;
  let resolveClosed: () => void;
  handle.ready = new Promise<void>((r) => { resolveReady = r; });
  handle.closed = new Promise<void>((r) => { resolveClosed = r; });

  const enableTestId = 1;
  const enableLifecycleId = 2;

  const ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    if (debug) process.stderr.write(`[dbg] ws open, enabling reporters\n`);
    ws.send(JSON.stringify({ id: enableTestId, method: 'TestReporter.enable' }));
    ws.send(JSON.stringify({ id: enableLifecycleId, method: 'LifecycleReporter.enable' }));
    msgId = 3;
  });

  ws.addEventListener('error', (e) => {
    if (debug) process.stderr.write(`[dbg] ws error: ${(e as ErrorEvent).message ?? 'unknown'}\n`);
    resolveReady!();
    resolveClosed();
  });

  const enabledAcks = new Set<number>();

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));

    if (debug && !msg.method) process.stderr.write(`[dbg] ws resp id=${msg.id} ${JSON.stringify(msg.result ?? msg.error ?? '').slice(0, 80)}\n`);
    if (debug && msg.method) {
      const extra = msg.method === 'TestReporter.found' && msg.params?.url
        ? ` [${msg.params.url.replace(/^file:\/\//, '').split('/').pop()}]`
        : '';
      process.stderr.write(`[dbg] ${msg.method} ${msg.params?.name ?? msg.params?.id ?? ''}${extra}\n`);
    }

    if (msg.id === enableTestId || msg.id === enableLifecycleId) {
      enabledAcks.add(msg.id);
      if (enabledAcks.size === 2) {
        if (debug) process.stderr.write(`[dbg] both reporters enabled, ready!\n`);
        resolveReady!();
      }
    }

    if (!msg.method) return;

    switch (msg.method) {
      case 'TestReporter.found': {
        const p = msg.params;
        handle.tests.set(p.id, {
          id: p.id,
          name: p.name,
          url: p.url ?? '',
          line: p.line ?? 0,
          parentId: p.parentId ?? null,
          type: p.type ?? 'test',
        });
        break;
      }
      case 'TestReporter.start':
        break;
      case 'TestReporter.end': {
        const p = msg.params;
        const t = handle.tests.get(p.id);
        if (t) {
          t.status = p.status;
          t.elapsed = p.elapsed;
        }
        break;
      }
      case 'LifecycleReporter.error': {
        handle.errors.push(msg.params);
        handle.crashed = true;
        onCrash?.();
        break;
      }
    }
  });

  ws.addEventListener('close', () => {
    if (debug) process.stderr.write(`[dbg] ws closed, tests collected: ${handle.tests.size}\n`);
    resolveClosed();
  });

  return handle;
}

// endregion

// region ── error formatting ─────────────────────────────────────────────────

function formatError(e: TestError): string {
  const lines: string[] = [];

  // Header: TypeError: message
  lines.push(`${C.r}${C.b}${e.name}${C.x}: ${e.message}`);

  // Location: file:line:col
  for (let i = 0; i < e.urls.length; i++) {
    const rel = relPath(e.urls[i]!);
    const line = e.lineColumns[i * 2];
    const col = e.lineColumns[i * 2 + 1];
    if (line != null) {
      lines.push(`  ${C.d}at ${rel}:${line}:${col ?? 0}${C.x}`);
    } else {
      lines.push(`  ${C.d}at ${rel}${C.x}`);
    }
  }

  // Source context: first sourceLine is the error line, rest is context
  if (e.sourceLines.length > 0) {
    const errorLine = e.sourceLines[0]?.trim();
    if (errorLine) {
      lines.push(`  ${C.r}→ ${errorLine}${C.x}`);
    }
  }

  return lines.join('\n');
}

// endregion

// region ── result formatting ────────────────────────────────────────────────

function printResults(h: InspectorHandle, elapsed: number): void {
  const testCases = [...h.tests.values()].filter((t) => t.type === 'test');
  const passed = testCases.filter((t) => t.status === 'pass');
  const failed = testCases.filter((t) => t.status === 'fail');
  const skipped = testCases.filter((t) => t.status === 'skip' || t.status === 'todo');
  const timedOut = testCases.filter((t) => t.status === 'timeout');
  const files = new Set(testCases.map((t) => t.url).filter(Boolean));

  const logFile = process.env.MAKAIO_TEST_LOG;
  if (logFile) {
    const paths = [...files]
      .map((u) => u.replace(/^file:\/\//, ''))
      .filter((p) => p.endsWith('.bun.test.ts'));
    if (paths.length > 0) appendFileSync(logFile, paths.join('\n') + '\n');
  }

  // Per-test output (non-quiet only)
  if (!quiet) {
    for (const t of testCases) {
      const name = fullName(h.tests, t);
      const ms = t.elapsed != null ? ` [${nsToMs(t.elapsed)}ms]` : '';

      if (t.status === 'pass') {
        process.stderr.write(`${C.g}✓${C.x} ${name}${ms}\n`);
      } else if (t.status === 'fail' || t.status === 'timeout') {
        const rel = relPath(t.url);
        process.stderr.write(`${C.r}✗${C.x} ${name}${ms}  ${C.d}${rel}:${t.line}${C.x}\n`);
      } else if (t.status === 'skip' || t.status === 'todo') {
        process.stderr.write(`${C.y}○${C.x} ${name} (${t.status})\n`);
      }
    }
  }

  // Failure details (always shown)
  if (failed.length > 0 || timedOut.length > 0) {
    process.stderr.write('\n');
    for (const t of [...failed, ...timedOut]) {
      const name = fullName(h.tests, t);
      const rel = relPath(t.url);
      process.stderr.write(`${C.r}FAIL${C.x} ${name}\n`);
      process.stderr.write(`  ${C.d}${rel}:${t.line}${C.x}\n`);
    }
  }

  // Lifecycle errors (always shown)
  if (h.errors.length > 0) {
    process.stderr.write('\n');
    for (const e of h.errors) {
      process.stderr.write(formatError(e) + '\n\n');
    }
  }

  // Crash banner
  if (h.crashed) {
    process.stderr.write(
      `${C.r}${C.b}ABORT${C.x}: bun crashed after processing ${files.size} files — results are incomplete\n`,
    );
    process.stderr.write(
      `${C.d}Use --per-file mode for isolated, reliable runs${C.x}\n\n`,
    );
  }

  // Summary
  const parts: string[] = [];
  if (passed.length > 0) parts.push(`${C.g}${passed.length} pass${C.x}`);
  if (failed.length > 0) parts.push(`${C.r}${failed.length} fail${C.x}`);
  if (timedOut.length > 0) parts.push(`${C.r}${timedOut.length} timeout${C.x}`);
  if (skipped.length > 0) parts.push(`${C.y}${skipped.length} skip${C.x}`);

  const secs = (elapsed / 1000).toFixed(2);
  const fileLabel = h.crashed ? `${files.size} of ? files` : `${files.size} files`;
  process.stdout.write(`${parts.join(' | ')} across ${fileLabel} [${secs}s]\n`);
}

// endregion

// region ── gate server ──────────────────────────────────────────────────────

interface Gate {
  port: number;
  open: () => void;
  close: () => void;
}

function createGate(): Gate {
  let resolve: () => void;
  const ready = new Promise<void>((r) => { resolve = r; });
  let opened = false;

  const server = Bun.serve({
    port: 0,
    fetch() {
      if (opened) return new Response('go', { status: 200 });
      return ready.then(() => new Response('go', { status: 200 }));
    },
  });

  return {
    port: server.port,
    open() { opened = true; resolve!(); },
    close() { server.stop(true); },
  };
}

// endregion

// region ── main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    rawArgs.push('**/*.bun.test.ts');
  }
  const bunArgs = expandGlobs(rawArgs);
  const startTime = Date.now();

  const gate = createGate();
  if (debug) process.stderr.write(`[dbg] gate server on port ${gate.port}\n`);

  // Strip AI_AGENT from child env — it breaks bun's inspector WebSocket handshake
  const childEnv = { ...process.env, __INSPECTOR_GATE_PORT: String(gate.port) };
  delete childEnv.AI_AGENT;

  const child = spawn('bun', ['test', '--inspect', '--isolate', ...bunArgs], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: childEnv,
  });

  child.stdout!.on('data', () => {});

  const processExit = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1));
  });

  const wsUrl = await new Promise<string | null>((resolve) => {
    let buf = '';
    let found = false;
    child.stderr!.on('data', (chunk: Buffer) => {
      if (found) return;
      buf += chunk.toString();
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) {
        found = true;
        resolve(m[0]);
      }
    });
    child.on('close', () => { if (!found) resolve(null); });
  });

  if (!wsUrl) {
    process.stderr.write('Failed to obtain inspector WebSocket URL\n');
    gate.close();
    process.exitCode = await processExit;
    return;
  }

  const inspector = connectInspector(wsUrl, () => {
    setTimeout(() => child.kill('SIGKILL'), 500);
  });

  await inspector.ready;
  if (debug) process.stderr.write(`[dbg] inspector ready, opening gate\n`);
  gate.open();

  const code = await processExit;
  await inspector.closed;
  gate.close();

  const elapsed = Date.now() - startTime;
  printResults(inspector, elapsed);

  process.exitCode = inspector.crashed || code !== 0 ? 1 : 0;
}

main();

// endregion
