import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJsonRpcClient } from '../json-rpc-client.js';
import type { IJsonRpcClient } from '../json-rpc-client.js';
import { createJsonlTransport } from '../jsonl-transport.js';

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

/**
 * Create a JSON-RPC client over a real JSONL subprocess transport.
 * @param processName - Diagnostic process name.
 * @param script - Node script source run by the subprocess.
 * @returns JSON-RPC client bound to the spawned subprocess.
 */
function spawnClient(processName: string, script: string): IJsonRpcClient {
  return createJsonRpcClient(
    createJsonlTransport({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), processName }),
  );
}

describe('createJsonRpcClient over createJsonlTransport', () => {
  let client: IJsonRpcClient | undefined;

  afterEach(() => {
    client?.close();
    client = undefined;
    vi.restoreAllMocks();
  });

  it('keeps pending requests correlated when the subprocess writes a malformed line', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    client = spawnClient('stray-line-server', STRAY_LINE_SERVER_SCRIPT);

    const first = client.request<string>('first', {}, 10_000);
    const second = client.request<string>('second', {}, 10_000);

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('secret-value');
  });

  it('closes the client when the subprocess exits, so later requests reject immediately', async () => {
    client = spawnClient('crash-server', firstRequestServer('process.exit(3);'));

    await expect(client.request('first', {}, 0)).rejects.toThrow('crash-server exited with code 3');
    await expect(client.request('second', {}, 0)).rejects.toThrow('JSON-RPC client is closed');
  });

  it('rejects pending requests when the subprocess is killed by a signal', async () => {
    client = spawnClient('signal-server', firstRequestServer('process.kill(process.pid, "SIGKILL");'));

    await expect(client.request('first', {}, 0)).rejects.toThrow('signal-server exited with signal SIGKILL');
  });

  it('closes the client when the subprocess writes a malformed line and then exits cleanly', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    client = spawnClient(
      'clean-exit-server',
      firstRequestServer(`process.stdout.write('not json\\n', () => process.exit(0));`),
    );

    await expect(client.request('first', {}, 0)).rejects.toThrow('clean-exit-server exited with code 0');
    await expect(client.request('second', {}, 0)).rejects.toThrow('JSON-RPC client is closed');
  });

  it('settles a request whose response is still on stdout when the subprocess exits', async () => {
    // The server hands its stdout to a helper that answers after the server has
    // already exited cleanly, so `exit` deterministically precedes the response.
    client = spawnClient(
      'answer-after-exit-server',
      firstRequestServer(`
  const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'bye' });
  require('node:child_process').spawn(
    process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write(process.argv[1] + "\\\\n"), 100)', response],
    { stdio: ['ignore', 'inherit', 'ignore'] },
  );
  process.exit(0);`),
    );

    await expect(client.request('shutdown', {}, 0)).resolves.toBe('bye');
  });

  it('rejects a request whose error response carries no error object', async () => {
    client = spawnClient(
      'null-error-server',
      firstRequestServer(
        `process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: null }) + '\\n');`,
      ),
    );

    await expect(client.request('first', {}, 10_000)).rejects.toThrow(
      'JSON-RPC error response without an error object',
    );
  });
});
