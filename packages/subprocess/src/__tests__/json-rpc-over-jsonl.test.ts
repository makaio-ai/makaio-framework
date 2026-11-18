import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJsonRpcClient } from '../json-rpc-client.js';
import type { IJsonRpcClient } from '../json-rpc-client.js';
import { createJsonlTransport } from '../jsonl-transport.js';
import type { IJsonlTransport } from '../types.js';

/**
 * JSON-RPC server that waits until two requests are outstanding, writes a line
 * that is not JSON (a stray log statement on stdout), and only then answers
 * both requests.
 */
const STRAY_LINE_SERVER_SCRIPT = `
const pending = [];
let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (line.trim()) pending.push(JSON.parse(line));
  }
  if (pending.length === 2) {
    process.stdout.write('stray log line with token=secret-value\\n');
    for (const request of pending.splice(0)) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method }) + '\\n');
    }
  }
});
`;

/**
 * Build a JSON-RPC server script that runs `onFirstRequest` with the parsed
 * `request` once the first complete request line arrives on stdin.
 * @param onFirstRequest - Script body executed for the first request.
 * @returns Node script source for `node -e`.
 */
function firstRequestServer(onFirstRequest: string): string {
  return `
let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf('\\n');
  if (newline === -1) return;
  const request = JSON.parse(buffer.slice(0, newline));
  ${onFirstRequest}
});
`;
}

/** Server that reads requests and never answers them. */
const SILENT_SERVER_SCRIPT = `
process.stdin.resume();
setInterval(() => {}, 1000);
`;

/**
 * Create a JSON-RPC client over a real JSONL subprocess transport.
 * @param processName - Diagnostic process name.
 * @param script - Node script source run by the subprocess.
 * @returns JSON-RPC client bound to the spawned subprocess, and its transport.
 */
function spawnChannel(processName: string, script: string): { client: IJsonRpcClient; transport: IJsonlTransport } {
  const transport = createJsonlTransport({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    processName,
    onStdoutEnd: 'terminal',
  });
  return { client: createJsonRpcClient(transport), transport };
}

describe('createJsonRpcClient over createJsonlTransport', () => {
  let client: IJsonRpcClient | undefined;
  let transport: IJsonlTransport | undefined;

  // Every case keeps its transport, so its child's bounded end is awaited here
  // and never overlaps the next case.
  afterEach(async () => {
    client?.close();
    client = undefined;
    await transport?.close();
    transport = undefined;
    vi.restoreAllMocks();
  });

  it('keeps pending requests correlated when the subprocess writes a malformed line', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ({ client, transport } = spawnChannel('stray-line-server', STRAY_LINE_SERVER_SCRIPT));

    const first = client.request<string>('first', {}, 10_000);
    const second = client.request<string>('second', {}, 10_000);

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('secret-value');
  });

  it('closes the client when the subprocess exits, so later requests reject immediately', async () => {
    ({ client, transport } = spawnChannel('crash-server', firstRequestServer('process.exit(3);')));

    await expect(client.request('first', {}, 0)).rejects.toThrow(
      'JSON-RPC transport ended unexpectedly: exited with code 3',
    );
    await expect(client.request('second', {}, 0)).rejects.toThrow('JSON-RPC client is closed');
  });

  it('rejects pending requests when the subprocess is killed by a signal', async () => {
    ({ client, transport } = spawnChannel(
      'signal-server',
      firstRequestServer('process.kill(process.pid, "SIGKILL");'),
    ));

    await expect(client.request('first', {}, 0)).rejects.toThrow(
      'JSON-RPC transport ended unexpectedly: exited with signal SIGKILL',
    );
  });

  it('closes the client when the subprocess writes a malformed line and then exits cleanly', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ({ client, transport } = spawnChannel(
      'clean-exit-server',
      firstRequestServer(`process.stdout.write('not json\\n', () => process.exit(0));`),
    ));

    await expect(client.request('first', {}, 0)).rejects.toThrow(
      'JSON-RPC transport ended unexpectedly: exited with code 0',
    );
    await expect(client.request('second', {}, 0)).rejects.toThrow('JSON-RPC client is closed');
  });

  it('settles a request whose response is still on stdout when the subprocess exits', async () => {
    // The server hands its stdout to a helper that answers after the server has
    // already exited cleanly, so `exit` deterministically precedes the response.
    ({ client, transport } = spawnChannel(
      'answer-after-exit-server',
      firstRequestServer(`
  const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'bye' });
  require('node:child_process').spawn(
    process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write(process.argv[1] + "\\\\n"), 100)', response],
    { stdio: ['ignore', 'inherit', 'ignore'] },
  );
  process.exit(0);`),
    ));

    await expect(client.request('shutdown', {}, 0)).resolves.toBe('bye');
  });

  it('drops the response to a server request answered after the subprocess exited', async () => {
    const handled = Promise.withResolvers<void>();
    const helper = Promise.withResolvers<number>();
    // A helper holds stdout well past the drain window, so the request is
    // answered while the exit has blocked writing and the end is still pending
    // (it comes only at the drain deadline), however slow the host is.
    ({ client, transport } = spawnChannel(
      'request-then-exit-server',
      `
const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
  stdio: ['ignore', 'inherit', 'ignore'],
});
helper.unref();
const lines = [
  { jsonrpc: '2.0', method: 'helper', params: { pid: helper.pid } },
  { jsonrpc: '2.0', id: 's1', method: 'approve', params: {} },
];
process.stdout.write(lines.map((line) => JSON.stringify(line) + '\\n').join(''), () => process.exit(0));`,
    ));
    client.onNotification('helper', (_method, params) => helper.resolve((params as { pid: number }).pid));
    client.onServerRequest(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      handled.resolve();
      return { approved: true };
    });
    const helperPid = await helper.promise;
    try {
      await handled.promise;
      // An escaped write failure would surface as an unhandled rejection here.
      await new Promise((resolve) => setImmediate(resolve));
      await expect(client.request('late', {}, 0)).rejects.toThrow('request-then-exit-server transport is not writable');
    } finally {
      try {
        process.kill(helperPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  it('settles a pending request when the transport is closed by its owner', async () => {
    ({ client, transport } = spawnChannel('silent-server', SILENT_SERVER_SCRIPT));
    const pending = client.request('never-answered', {}, 0);

    const end = await transport.close();

    expect(end.cause).toBe('requested');
    await expect(pending).rejects.toThrow('JSON-RPC transport stopped on request: exited with signal SIGTERM');
    await expect(client.request('later', {}, 0)).rejects.toThrow('JSON-RPC client is closed');
  });

  it('rejects a request issued after the stop intent at once, before the end is reported', async () => {
    ({ client, transport } = spawnChannel('stopping-server', SILENT_SERVER_SCRIPT));
    const closing = transport.close();

    await expect(client.request('too-late', {}, 0)).rejects.toThrow('stopping-server transport is not writable');
    expect(transport.status).toBe('ending');
    await closing;
  });

  it('rejects a request whose error response carries no error object', async () => {
    ({ client, transport } = spawnChannel(
      'null-error-server',
      firstRequestServer(
        `process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: null }) + '\\n');`,
      ),
    ));

    await expect(client.request('first', {}, 10_000)).rejects.toThrow(
      'JSON-RPC error response without an error object',
    );
  });
});
