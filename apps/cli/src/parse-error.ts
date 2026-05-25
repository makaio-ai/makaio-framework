/**
 * Commander parse-error handling extracted from {@link main} to keep the
 * orchestration module under the line limit.
 * @packageDocumentation
 */

import { CommanderError } from 'commander';
import { resolveMakaioHome } from '@makaio/runtime-node';
import type { CommandInstance } from './command-tree.js';
import { shouldSuppressWarning, recordWarningShown } from './warning-debounce.js';

/** Why server-side command discovery is unavailable. */
export type FallbackReason = 'none' | 'unreachable' | 'connection-failed' | 'discovery-failed';

/** Root-level behavioral flags extracted before Commander parsing. */
export interface ParseErrorRootFlags {
  readonly debounceFailure: boolean;
  readonly noFailure: boolean;
}

/**
 * Handle a Commander parse error thrown by `exitOverride`.
 *
 * When the server is down, `writeErr` is suppressed to prevent the generic
 * Commander message from appearing before our custom unknownCommand message.
 * This helper re-surfaces validation errors that would otherwise be silently
 * swallowed, and always propagates the exit code.
 * @param err - The caught error from `parseAsync`.
 * @param argv - Raw process argv, used to extract the attempted command name.
 * @param fallback - Why server-side discovery is unavailable.
 * @param connectionError - Specific connection failure detail when available.
 * @param rootFlags - Root-level behavioral flags extracted before Commander parsing.
 */
export function handleParseError(
  err: unknown,
  argv: string[],
  fallback: FallbackReason,
  connectionError?: string,
  rootFlags?: ParseErrorRootFlags,
): void {
  const attemptedTopLevel = argv[2];
  const unknownName = err instanceof CommanderError ? extractUnknownCommandName(err) : undefined;
  const isTopLevelUnknown =
    fallback !== 'none' &&
    err instanceof CommanderError &&
    err.code === 'commander.unknownCommand' &&
    unknownName !== undefined &&
    unknownName === attemptedTopLevel;
  if (isTopLevelUnknown) {
    if (rootFlags?.noFailure) {
      process.exitCode = 0;
      return;
    }

    if (rootFlags?.debounceFailure) {
      const makaioHome = resolveMakaioHome();
      if (shouldSuppressWarning(makaioHome)) {
        process.exitCode = 0;
        return;
      }
      recordWarningShown(makaioHome);
    }

    const name = unknownName;
    const reason =
      fallback === 'unreachable'
        ? (connectionError ??
          'The server is not running — remote extension commands are unavailable.\nStart with: makaio serve')
        : fallback === 'connection-failed'
          ? (connectionError ?? 'The CLI could not connect to the running server.')
          : 'Command discovery failed — remote extension commands are unavailable.';
    console.error(`Unknown command "${name}". ${reason}`);
    process.exitCode = 1;
  } else if (err instanceof CommanderError) {
    if (fallback !== 'none' && err.code !== 'commander.helpDisplayed') {
      process.stderr.write(`${err.message}\n`);
    }
    process.exitCode = err.exitCode;
  } else {
    throw err;
  }
}

/**
 * Extract the actual unknown command token from a Commander parse error.
 * @param error - Commander error raised by `exitOverride`.
 * @returns The unknown command token, when present.
 */
function extractUnknownCommandName(error: CommanderError): string | undefined {
  const match = /unknown command '([^']+)'/.exec(error.message);
  return match?.[1];
}

/**
 * Apply fallback parse overrides to a command tree.
 *
 * Commander does not retroactively propagate `exitOverride()` or custom output
 * handlers from a parent command to already-registered children, so nested
 * unknown-subcommand failures must be overridden recursively.
 * @param command - Root of the command tree to update.
 */
export function applyFallbackOverrides(command: CommandInstance): void {
  command.exitOverride();
  command.configureOutput({ writeErr: () => {} });
  for (const child of command.commands) {
    applyFallbackOverrides(child as CommandInstance);
  }
}
