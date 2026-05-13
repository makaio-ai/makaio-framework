import type { IMakaioBus } from '@makaio/bus-core';
import type { HandlerForSubjectDefinition } from '@makaio/core';
import { BaseService } from '@makaio/service-base';
import { ToolErrorCodes } from '@makaio/tools-core';
import safeRegex from 'safe-regex2';
import { ShellSubjects } from './bus/namespace.js';
import { ShellManager } from './manager/shell-manager.js';
import type { ShellInstance } from './manager/shell-instance.js';
import type { GrepMatch, OutputLine, ShellConstraints } from './types.js';
import { DEFAULT_CONSTRAINTS } from './types.js';

/**
 * Owns shell process lifecycle for the shell extension.
 */
export class ShellService extends BaseService {
  public readonly manager: ShellManager;

  /**
   * Creates the shell service.
   * @param bus - Runtime bus for shell service RPC handlers.
   * @param manager - Optional manager for tests.
   */
  public constructor(bus: IMakaioBus, manager = new ShellManager()) {
    super(bus);
    this.manager = manager;
  }

  protected onInit(): void {
    this.manager.startCleanupTimer();

    this.registerHandler(ShellSubjects.exec, async (ctx) => {
      const constraints = this.mergeConstraints(ctx.payload.context.constraints);
      const timeout =
        ctx.payload.input.timeout === undefined ? undefined : Math.min(ctx.payload.input.timeout, constraints.timeout);
      try {
        const instance = await this.manager.create({
          command: ctx.payload.input.command,
          cwd: ctx.payload.input.cwd ?? ctx.payload.context.cwd,
          env: ctx.payload.input.env ?? {},
          platform: ctx.payload.context.platform,
          colors: ctx.payload.input.colors ?? false,
          timeout,
          constraints,
        });
        ctx.setResult({ shellId: instance.shellId, pid: instance.pid, shell: instance.shell });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Max concurrent shells')) {
          throw new Error(`${ToolErrorCodes.RESOURCE_EXHAUSTED}: ${message}`);
        }
        throw new Error(`${ToolErrorCodes.EXECUTION_ERROR}: ${message}`);
      }
    });

    this.registerHandler(ShellSubjects.status, (ctx) => {
      const instance = this.requireShell(ctx.payload.shellId);
      const stats = instance.getBufferStats();
      ctx.setResult({
        shellId: instance.shellId,
        status: instance.getStatus(),
        exitCode: instance.getExitCode(),
        stdoutSize: stats.stdoutSize,
        stderrSize: stats.stderrSize,
        truncated: stats.truncated,
        runtimeMs: instance.getRuntimeMs(),
      });
    });

    this.registerHandler(ShellSubjects.kill, async (ctx) => {
      const instance = this.requireShell(ctx.payload.shellId);
      const signal = ctx.payload.signal ?? 'SIGTERM';
      ctx.setResult({ killed: await instance.kill(signal), signal });
    });

    this.registerHandler(ShellSubjects.output, (ctx) => {
      const instance = this.requireShell(ctx.payload.shellId);
      const output = instance.getOutput(
        ctx.payload.stream ?? 'both',
        ctx.payload.offset ?? 0,
        ctx.payload.limit ?? 10000,
      );
      ctx.setResult({
        content: output.content,
        stream: output.stream,
        offset: output.offset,
        totalSize: output.totalSize,
        hasMore: output.hasMore,
      });
    });

    this.registerHandler(ShellSubjects.grep, (ctx) => this.handleGrep(ctx));

    this.registerHandler(ShellSubjects.send, async (ctx) => {
      const instance = this.requireShell(ctx.payload.shellId);
      const bytesWritten = await instance.sendInput(ctx.payload.input);
      ctx.setResult({ sent: bytesWritten > 0, bytesWritten });
    });
  }

  protected async onDestroy(): Promise<void> {
    await this.manager.dispose();
  }

  /**
   * Handle a grep request: compile regex, scan lines, paginate, and build context.
   * @param ctx - Bus request context for the shell.grep subject
   */
  private handleGrep(ctx: Parameters<HandlerForSubjectDefinition<(typeof ShellSubjects)['grep']>>[0]): void {
    const instance = this.requireShell(ctx.payload.shellId);
    let regex: RegExp;
    try {
      if (!safeRegex(ctx.payload.pattern)) {
        throw new Error('Unsafe regex pattern detected');
      }
      regex = new RegExp(ctx.payload.pattern);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${ToolErrorCodes.VALIDATION_FAILED}: Invalid regex pattern: ${message}`);
    }

    const lines = instance.getLines(ctx.payload.stream ?? 'both');
    const matchingIndices: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (regex.test(lines[index]!.content)) {
        matchingIndices.push(index);
      }
    }

    const totalMatches = matchingIndices.length;
    const offset = ctx.payload.offset ?? 0;
    const maxMatches = ctx.payload.maxMatches ?? 10;
    const contextLines = ctx.payload.context ?? 2;

    ctx.setResult({
      matches: matchingIndices
        .slice(offset, offset + maxMatches)
        .map((matchIndex) => this.buildGrepMatch(lines, matchIndex, contextLines)),
      totalMatches,
      truncated: offset + maxMatches < totalMatches,
    });
  }

  /**
   * Build a single grep match result with before/after context lines.
   * @param lines - All output lines from the shell
   * @param matchIndex - Index of the matched line
   * @param contextLines - Number of context lines before and after
   * @returns Grep match object
   */
  private buildGrepMatch(lines: OutputLine[], matchIndex: number, contextLines: number): GrepMatch {
    const line = lines[matchIndex]!;
    const before: string[] = [];
    for (let index = Math.max(0, matchIndex - contextLines); index < matchIndex; index += 1) {
      before.push(lines[index]!.content);
    }
    const after: string[] = [];
    for (let index = matchIndex + 1; index <= Math.min(lines.length - 1, matchIndex + contextLines); index += 1) {
      after.push(lines[index]!.content);
    }
    return { lineNumber: line.lineNumber, stream: line.stream, line: line.content, before, after };
  }

  /**
   * Merge raw constraint payload with defaults to produce complete shell constraints.
   * @param rawConstraints - Raw constraints from the bus context (may be any shape)
   * @returns Fully populated ShellConstraints with defaults applied
   */
  private mergeConstraints(rawConstraints: unknown): Required<ShellConstraints> {
    const shellConstraints =
      rawConstraints && typeof rawConstraints === 'object' && 'shell' in rawConstraints
        ? ((rawConstraints as { shell?: Partial<Record<keyof ShellConstraints, unknown>> }).shell ?? {})
        : {};

    const positiveInteger = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
    const stringArray = (value: unknown, fallback: string[]): string[] =>
      Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...value] : fallback;
    const truncateMode =
      shellConstraints.truncateMode === 'head' ||
      shellConstraints.truncateMode === 'tail' ||
      shellConstraints.truncateMode === 'middle'
        ? shellConstraints.truncateMode
        : DEFAULT_CONSTRAINTS.truncateMode;

    return {
      timeout: positiveInteger(shellConstraints.timeout, DEFAULT_CONSTRAINTS.timeout),
      maxOutputSize: positiveInteger(shellConstraints.maxOutputSize, DEFAULT_CONSTRAINTS.maxOutputSize),
      truncateMode,
      allowedCommands: stringArray(shellConstraints.allowedCommands, DEFAULT_CONSTRAINTS.allowedCommands),
      blockedCommands: stringArray(shellConstraints.blockedCommands, DEFAULT_CONSTRAINTS.blockedCommands),
      allowedPaths: stringArray(shellConstraints.allowedPaths, DEFAULT_CONSTRAINTS.allowedPaths),
      maxConcurrentShells: positiveInteger(
        shellConstraints.maxConcurrentShells,
        DEFAULT_CONSTRAINTS.maxConcurrentShells,
      ),
      bufferRetentionMs: positiveInteger(shellConstraints.bufferRetentionMs, DEFAULT_CONSTRAINTS.bufferRetentionMs),
    };
  }

  /**
   * Look up a shell by ID or throw a structured RESOURCE_NOT_FOUND error.
   * @param shellId - Shell identifier to look up
   * @returns The ShellInstance for the given ID
   * @throws Error with RESOURCE_NOT_FOUND prefix if the shell does not exist
   */
  private requireShell(shellId: string): ShellInstance {
    const instance = this.manager.get(shellId);
    if (!instance) {
      throw new Error(`${ToolErrorCodes.RESOURCE_NOT_FOUND}: Shell not found: ${shellId}`);
    }
    return instance;
  }
}
