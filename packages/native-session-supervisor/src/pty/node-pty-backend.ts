/**
 * node-pty Backend
 *
 * Thin adapter that satisfies {@link IPtyBackend} by delegating to the
 * `node-pty` native addon. Keeping this in a dedicated module means the rest
 * of the runtime is free of the native-addon import and can be tested or
 * replaced without touching `node-pty`.
 * @packageDocumentation
 */

// node-pty 1.2.x is pre-release but intentional: it is the only release line
// that ships prebuilt native addons for Node.js >= 20. The stable 1.0.x /
// 1.1.x branches lack compatible binaries for current Node versions.
// Revisit when a stable 1.2.x is published upstream.
import * as pty from 'node-pty';
import type { IPtyBackend, IPtyProcess, IPtySpawnOptions } from './types.js';

/**
 * PTY backend backed by the `node-pty` native addon.
 *
 * This is the production backend for Node.js hosts. It should only be
 * instantiated where the native addon is available.
 */
export class NodePtyBackend implements IPtyBackend {
  /**
   * Spawn a new pseudoterminal via `node-pty`.
   * @param file - Executable path or name.
   * @param args - Argument list passed to the executable.
   * @param options - Terminal dimensions, cwd, env, and terminal name.
   * @returns A promise that resolves immediately with the `node-pty` process.
   */
  public spawn(file: string, args: string[], options: IPtySpawnOptions): Promise<IPtyProcess> {
    try {
      const ptyProcess = pty.spawn(file, args, options);
      const wrapped: IPtyProcess = {
        get pid() {
          return ptyProcess.pid;
        },
        get process() {
          return ptyProcess.process;
        },
        get cols() {
          return ptyProcess.cols;
        },
        get rows() {
          return ptyProcess.rows;
        },
        write: (data) => ptyProcess.write(data),
        resize: (cols, rows) => ptyProcess.resize(cols, rows),
        kill: (signal) => ptyProcess.kill(signal),
        onData: (listener) => ptyProcess.onData(listener),
        onExit: (listener) => ptyProcess.onExit(listener),
      };
      return Promise.resolve(wrapped);
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
