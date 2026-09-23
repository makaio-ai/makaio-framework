/** Lazy host-appropriate production PTY backend. @packageDocumentation */

import type { IPtyBackend, IPtyProcess, IPtySpawnOptions } from './pty/types.js';

/**
 * Selects the runtime-appropriate PTY backend without loading the `node-pty`
 * native addon in a Bun host.
 */
export class LazyNodePtyBackend implements IPtyBackend {
  private backend: IPtyBackend | null = null;
  private backendPromise: Promise<IPtyBackend> | null = null;

  /**
   * @param createBackend - Lazy factory for the host's PTY backend.
   */
  public constructor(
    private readonly createBackend: () => Promise<IPtyBackend> = async () => {
      if (typeof (globalThis as Record<string, unknown>)['Bun'] !== 'undefined') {
        const { NodeBridgeBackend } = await import('./pty/node-bridge-backend.js');
        return new NodeBridgeBackend();
      }
      const { NodePtyBackend } = await import('./pty/node-pty-backend.js');
      return new NodePtyBackend();
    },
  ) {}

  /**
   * Spawn a PTY after resolving the native backend.
   * @param file - Executable path or name.
   * @param args - Argument list passed to the executable.
   * @param options - PTY spawn options.
   * @returns Spawned PTY process handle.
   */
  public async spawn(file: string, args: string[], options: IPtySpawnOptions): Promise<IPtyProcess> {
    return (await this.getBackend()).spawn(file, args, options);
  }

  /** Dispose the native backend when it has been loaded. */
  public async dispose(): Promise<void> {
    try {
      await (this.backend ?? (this.backendPromise ? await this.backendPromise : null))?.dispose?.();
    } finally {
      this.backend = null;
      this.backendPromise = null;
    }
  }

  private async getBackend(): Promise<IPtyBackend> {
    if (this.backend !== null) return this.backend;
    this.backendPromise ??= this.createBackend().then((backend) => {
      this.backend = backend;
      return backend;
    });
    try {
      return await this.backendPromise;
    } catch (error) {
      this.backendPromise = null;
      throw error;
    }
  }
}
