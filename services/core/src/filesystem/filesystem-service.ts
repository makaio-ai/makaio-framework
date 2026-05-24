import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IMakaioBus } from '@makaio/bus-core';
import { BaseService } from '@makaio/service-base';
import { FileSystemSubjects, FsSubjects } from './namespace.js';
import type { GlobEntry } from './schemas.js';
import { listDirectory } from './queries.js';

/**
 * FileSystemService provides filesystem browsing via bus requests.
 *
 * Handles:
 * - listSources: Returns this machine as an available source
 * - listDirectory: Lists directory contents
 * - getHomeDir: Returns home directory path
 * - glob: Pattern-based file search
 * - readFile: Read file content
 * - writeFile: Write file content
 * @example
 * ```typescript
 * const fsService = new FileSystemService(bus, 'local-machine', 'Local');
 * // BaseService lifecycle is explicit: call init() once before bus requests.
 * await fsService.init();
 *
 * const home = await bus.request(FileSystemSubjects.getHomeDir, {});
 * const listing = await bus.request(FileSystemSubjects.listDirectory, { path: home.path });
 * const files = await bus.request(FsSubjects.glob, { pattern: '**\/*.ts', cwd: '/project' });
 * const content = await bus.request(FsSubjects.readFile, { path: '/path/to/file.ts' });
 * ```
 */
export class FileSystemService extends BaseService {
  private readonly machineId: string;
  private readonly label: string;

  /**
   * Create a filesystem service instance for a specific machine source.
   * @param bus - Bus instance used to register request handlers
   * @param machineId - Machine identifier used for request routing
   * @param label - Human-readable source label (defaults to 'Local')
   */
  public constructor(bus: IMakaioBus, machineId: string, label: string = 'Local') {
    super(bus);
    this.machineId = machineId;
    this.label = label;
  }

  // NOTE: do NOT change without explicit human approval
  /* eslint max-lines-per-function: ["error", { "max": 120 }] */
  /**
   * Register bus handlers for filesystem operations.
   */
  protected async onInit(): Promise<void> {
    // listSources handler (broadcast-compatible: identifies itself for aggregation)
    this.registerHandler(FileSystemSubjects.listSources, (ctx) => {
      // Identify for broadcast aggregation (ctx.identify is present when called via broadcast())
      ctx.identify?.(this.machineId);
      ctx.setResult({
        sources: [{ machineId: this.machineId, label: this.label }],
      });
    });

    // listDirectory handler (machine-scoped via filter)
    this.addCleanup(
      this.bus.on(
        FileSystemSubjects.listDirectory,
        async (ctx) => {
          const targetPath = ctx.payload.path ?? os.homedir();
          const result = await listDirectory(targetPath, ctx.payload.options);
          ctx.setResult(result);
        },
        { filter: { machineId: this.machineId } },
      ),
    );

    // getHomeDir handler (machine-scoped via filter)
    this.addCleanup(
      this.bus.on(
        FileSystemSubjects.getHomeDir,
        (ctx) => {
          ctx.setResult({ path: os.homedir() });
        },
        { filter: { machineId: this.machineId } },
      ),
    );

    // glob handler - pattern-based file search (optionally machine-scoped)
    this.registerHandler(FsSubjects.glob, async (ctx) => {
      const { pattern, cwd, limit = 100, offset = 0, ignore = [], machineId } = ctx.payload;

      // If machineId specified, check if this service should handle
      if (machineId !== undefined && !this.shouldHandle(machineId)) {
        return; // Let another handler respond
      }

      const { globby } = await import('globby');

      const matches = await globby(pattern, {
        cwd,
        ignore: ['node_modules/**', '.git/**', ...ignore],
        absolute: true,
        onlyFiles: false,
        expandDirectories: false,
      });

      const total = matches.length;
      const truncated = offset + limit < total;
      const pageMatches = matches.slice(offset, offset + limit);

      const files: GlobEntry[] = await Promise.all(
        pageMatches.map(async (absolutePath) => {
          const relativePath = path.relative(cwd, absolutePath);
          let type: 'file' | 'directory' = 'file';
          let size: number | undefined;

          try {
            const stat = await fs.stat(absolutePath);
            type = stat.isDirectory() ? 'directory' : 'file';
            size = stat.isFile() ? stat.size : undefined;
          } catch {
            // Ignore stat errors, default to file
          }

          return { path: absolutePath, relativePath, type, size };
        }),
      );

      ctx.setResult({ files, truncated, total });
    });

    // readFile handler
    this.registerHandler(FsSubjects.readFile, async (ctx) => {
      const { path: filePath, machineId, encoding = 'utf-8' } = ctx.payload;

      // If machineId specified, check if this service should handle
      if (machineId !== undefined && !this.shouldHandle(machineId)) {
        return;
      }

      const content = await fs.readFile(filePath, { encoding: encoding as BufferEncoding });
      ctx.setResult({ content });
    });

    // writeFile handler
    this.registerHandler(FsSubjects.writeFile, async (ctx) => {
      const { path: filePath, content, machineId, encoding = 'utf-8' } = ctx.payload;

      // If machineId specified, check if this service should handle
      if (machineId !== undefined && !this.shouldHandle(machineId)) {
        return;
      }

      await fs.writeFile(filePath, content, { encoding: encoding as BufferEncoding });
      ctx.setResult({ success: true });
    });
  }

  /**
   * Check if this service should handle the request.
   * @param requestMachineId - The machineId from the request payload
   * @returns True if this service should handle the request
   */
  private shouldHandle(requestMachineId: string): boolean {
    return requestMachineId === this.machineId;
  }
}
