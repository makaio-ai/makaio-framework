/**
 * CLI RPC handler implementations for the ExtensionCoordinator.
 *
 * Extracted from the coordinator to keep that file within its line budget.
 * Both functions are pure with respect to the coordinator's internal state —
 * they receive only the minimal dependencies they need.
 */
import type { IMakaioBus } from '@makaio/bus-core';
import type { CliManifest } from '@makaio/contracts';
import { toCliArgManifests } from '../cli/schema-introspection.js';
import { CliSchemas } from '../bus/cli/schemas.js';
import type { CliContribution, OutputWriter } from '../cli/types.js';
import type { z } from 'zod';

// ---------------------------------------------------------------------------
// cli.listContributions
// ---------------------------------------------------------------------------

/**
 * Build the serializable CLI manifest list for the `cli.listContributions` RPC.
 * @param contributions - Collected CLI contributions from loaded packages.
 * @returns An array of manifest objects with serialized subcommand argument metadata.
 */
export function handleListContributions(contributions: ReadonlyArray<CliContribution>): CliManifest[] {
  return contributions.map((cli) => ({
    name: cli.name,
    description: cli.description,
    hasInteractive: !!cli.interactive,
    subcommands: cli.subcommands.map((sub) => ({
      name: sub.name,
      description: sub.description,
      args: toCliArgManifests(sub.schema),
    })),
  }));
}

// ---------------------------------------------------------------------------
// cli.execute
// ---------------------------------------------------------------------------

/**
 * Execute a CLI subcommand for the `cli.execute` RPC.
 *
 * Validates the payload against the subcommand's Zod schema, runs the
 * handler with a buffering {@link OutputWriter}, and returns captured output.
 */

/** Inferred request type for `cli.execute`. */
type ExecuteRequest = z.infer<typeof CliSchemas.execute.request>;
/** Inferred response type for `cli.execute`. */
type ExecuteResponse = z.infer<typeof CliSchemas.execute.response>;

/**
 * Execute a CLI subcommand for the `cli.execute` RPC.
 * @param payload - The validated request payload from the bus.
 * @param contributions - Collected CLI contributions from loaded packages.
 * @param bus - Bus instance forwarded to the handler's {@link CommandContext}.
 * @returns The execution result with exit code, stdout, and stderr lines.
 */
export async function handleExecute(
  payload: ExecuteRequest,
  contributions: ReadonlyArray<CliContribution>,
  bus: IMakaioBus,
): Promise<ExecuteResponse> {
  const { command, subcommand, args } = payload;

  const contribution = contributions.find((c) => c.name === command);
  if (!contribution) {
    return { exitCode: 1, stdout: [], stderr: [`Unknown command: ${command}`] };
  }

  const entry = contribution.subcommands.find((s) => s.name === subcommand);
  if (!entry) {
    return { exitCode: 1, stdout: [], stderr: [`Unknown subcommand: ${subcommand}`] };
  }

  const parsed = entry.schema.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => {
      const path = i.path.join('.') || '(root)';
      return `  ${path}: ${i.message}`;
    });
    return { exitCode: 1, stdout: [], stderr: ['Validation failed:', ...issues] };
  }

  if (contribution.beforeRun) {
    try {
      const gate = await contribution.beforeRun({
        subcommandName: subcommand,
        args: (parsed.data as Record<string, unknown>) ?? {},
        bus,
      });
      if (!gate.proceed) {
        return { exitCode: gate.exitCode ?? 1, stdout: [], stderr: [gate.message] };
      }
    } catch (err) {
      return {
        exitCode: 1,
        stdout: [],
        stderr: [`beforeRun hook failed: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }

  const stdout: string[] = [];
  const stderr: string[] = [];
  const output: OutputWriter = {
    write: (text) => stdout.push(text),
    error: (text) => stderr.push(text),
  };

  let exitCode = 0;
  // Remote RPC execution has no process-level abort signal; use a never-aborting
  // signal so the CommandContext contract (signal is always present) is satisfied.
  // Long-running commands like `watch` are designed for direct CLI invocation
  // (where SIGINT wiring exists), not for RPC dispatch which buffers all output.
  const signal = new AbortController().signal;
  try {
    await entry.handler({
      args: parsed.data,
      bus,
      output,
      signal,
      setExitCode: (nextExitCode) => {
        exitCode = nextExitCode;
      },
    });
  } catch (err) {
    if (exitCode === 0) {
      exitCode = 1;
    }
    stderr.push(err instanceof Error ? err.message : String(err));
  }

  return { exitCode, stdout, stderr };
}
