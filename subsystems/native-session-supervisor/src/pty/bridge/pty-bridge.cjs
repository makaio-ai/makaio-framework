/**
 * PTY Bridge — Node.js subprocess
 *
 * Runs under plain Node.js (not Bun) so it can load the node-pty native addon.
 * Speaks newline-delimited JSON-RPC over stdin/stdout, multiplexing any number
 * of PTY sessions for the Bun host process.
 *
 * Protocol (stdin, Bun → bridge):
 *   { "id": <number>, "cmd": "spawn", "file": <string>, "args": <string[]>,
 *     "options": { "cwd"?: <string>, "name"?: <string>, "cols"?: <number>,
 *                  "rows"?: <number>, "env"?: <Record<string,string>> } }
 *   { "id": <number>, "cmd": "input",  "ptyId": <number>, "data": <base64> }
 *   { "id": <number>, "cmd": "resize", "ptyId": <number>, "cols": <number>, "rows": <number> }
 *   { "id": <number>, "cmd": "kill",   "ptyId": <number>, "signal"?: <string> }
 *
 * Protocol (stdout, bridge → Bun):
 *   { "id": <number>, "ptyId": <number>, "event": "spawned", "pid": <number>, "process": <string> }
 *   { "ptyId": <number>, "event": "data",  "data": <base64> }
 *   { "ptyId": <number>, "event": "exit",  "exitCode": <number>, "signal": <number> }
 *   { "id": <number>,   "event": "error", "message": <string> }
 */

'use strict';

const pty = require('node-pty');
const readline = require('readline');

/** @type {Map<number, import('node-pty').IPty>} */
const sessions = new Map();

let nextPtyId = 1;

/**
 * Emit a JSON-RPC event to the Bun host via stdout.
 * @param {Record<string, unknown>} payload
 * @example
 */
function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

/**
 * Log a debug message to stderr (never interferes with the JSON-RPC protocol).
 * @param {string} message
 * @example
 */
function debug(message) {
  process.stderr.write(`[pty-bridge] ${message}\n`);
}

/**
 * Kill and delete all active PTY sessions.
 * @example
 */
function disposeAll() {
  for (const [id, proc] of sessions) {
    try {
      proc.kill();
    } catch {
      // Ignore — process may have already exited.
    }
    sessions.delete(id);
  }
}

/**
 * Handle a "spawn" command.
 * @param {{ id: number; file: string; args: string[]; options: Record<string, unknown> }} cmd
 * @example
 */
function handleSpawn(cmd) {
  const ptyId = nextPtyId++;
  const { id, file, args, options } = cmd;

  /** @type {import('node-pty').IWindowsPtyForkOptions | import('node-pty').IPtyForkOptions} */
  const spawnOptions = {
    name: typeof options.name === 'string' ? options.name : 'xterm-256color',
    cols: typeof options.cols === 'number' ? options.cols : 80,
    rows: typeof options.rows === 'number' ? options.rows : 24,
    cwd: typeof options.cwd === 'string' ? options.cwd : undefined,
    env:
      options.env !== null && typeof options.env === 'object' && !Array.isArray(options.env)
        ? /** @type {Record<string, string>} */ (options.env)
        : undefined,
  };

  let proc;
  try {
    proc = pty.spawn(file, args, spawnOptions);
  } catch (err) {
    emit({ id, event: 'error', message: err instanceof Error ? err.message : String(err) });
    return;
  }

  sessions.set(ptyId, proc);
  debug(`spawned ptyId=${ptyId} pid=${proc.pid} file=${file}`);

  emit({ id, ptyId, event: 'spawned', pid: proc.pid, process: proc.process });

  proc.onData((raw) => {
    // node-pty exposes terminal bytes as a JS "binary string"; latin1 preserves
    // the 1:1 byte mapping before we base64-wrap it for the JSON transport.
    emit({ ptyId, event: 'data', data: Buffer.from(raw, 'latin1').toString('base64') });
  });

  proc.onExit(({ exitCode, signal }) => {
    debug(`ptyId=${ptyId} exited exitCode=${exitCode} signal=${signal}`);
    sessions.delete(ptyId);
    emit({ ptyId, event: 'exit', exitCode, signal: signal ?? 0 });
  });
}

/**
 * Handle an "input" command — write base64-decoded data to the PTY.
 * @param {{ id: number; ptyId: number; data: string }} cmd
 * @example
 */
function handleInput(cmd) {
  const proc = sessions.get(cmd.ptyId);
  if (!proc) {
    emit({ id: cmd.id, event: 'error', message: `unknown ptyId: ${cmd.ptyId}` });
    return;
  }
  // Decode back from the byte-preserving latin1 string used on the backend side.
  const decoded = Buffer.from(cmd.data, 'base64').toString('latin1');
  proc.write(decoded);
}

/**
 * Handle a "resize" command.
 * @param {{ id: number; ptyId: number; cols: number; rows: number }} cmd
 * @example
 */
function handleResize(cmd) {
  const proc = sessions.get(cmd.ptyId);
  if (!proc) {
    emit({ id: cmd.id, event: 'error', message: `unknown ptyId: ${cmd.ptyId}` });
    return;
  }
  proc.resize(cmd.cols, cmd.rows);
}

/**
 * Handle a "kill" command.
 * @param {{ id: number; ptyId: number; signal?: string }} cmd
 * @example
 */
function handleKill(cmd) {
  const proc = sessions.get(cmd.ptyId);
  if (!proc) {
    emit({ id: cmd.id, event: 'error', message: `unknown ptyId: ${cmd.ptyId}` });
    return;
  }
  proc.kill(cmd.signal ?? 'SIGHUP');
}

// ── Stdin / readline setup ───────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  /** @type {Record<string, unknown>} */
  let cmd;
  try {
    cmd = JSON.parse(trimmed);
  } catch (err) {
    debug(`malformed JSON: ${trimmed}`);
    return;
  }

  try {
    switch (cmd.cmd) {
      case 'spawn':
        handleSpawn(/** @type {Parameters<typeof handleSpawn>[0]} */ (cmd));
        break;
      case 'input':
        handleInput(/** @type {Parameters<typeof handleInput>[0]} */ (cmd));
        break;
      case 'resize':
        handleResize(/** @type {Parameters<typeof handleResize>[0]} */ (cmd));
        break;
      case 'kill':
        handleKill(/** @type {Parameters<typeof handleKill>[0]} */ (cmd));
        break;
      default:
        debug(`unknown command: ${String(cmd.cmd)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    debug(`error handling command: ${message}`);
    if (cmd && cmd.id != null) {
      emit({ id: cmd.id, event: 'error', message });
    }
  }
});

// When the host closes stdin the bridge shuts down cleanly.
rl.on('close', () => {
  debug('stdin closed — shutting down');
  disposeAll();
  process.exit(0);
});

// ── Signal handling ──────────────────────────────────────────────────────────

/**
 *
 * @param signal
 * @example
 */
function shutdown(signal) {
  debug(`received ${signal} — shutting down`);
  disposeAll();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
