/**
 * Converts Zod object schemas into Commander commands.
 *
 * Reads CLI metadata from Zod's `.meta()` (description, short flags,
 * positional markers) and wires up parsing, validation, and handler dispatch.
 * Commander is an implementation detail — extensions never import it.
 */
import { z } from 'zod';
import type { IMakaioBus } from '@makaio/bus-core';
import type { CliSubcommandEntry, CliContribution, FieldSchema } from '@makaio/kernel/cli';
import { INTERACTIVE_SUBCOMMAND, getMeta, isBooleanSchema, isNumberSchema } from '@makaio/kernel/cli';
import { toCliLongOptionName } from './flag-names.js';
import { createProcessCommandContext, evaluateBeforeRunGate } from './command-runtime.js';
import { parseNumericArg } from './cli-arg-parsers.js';
import { findOrCreateCommand, claimSubcommandName, type CommandInstance } from './command-tree.js';

/**
 * Determine whether the current process has a real interactive terminal.
 * @param stdio - Process stdio handles to inspect.
 * @returns `true` when both stdin and stdout are TTYs.
 */
export function hasInteractiveTerminal(stdio: Pick<NodeJS.Process, 'stdin' | 'stdout'> = process): boolean {
  return stdio.stdin.isTTY === true && stdio.stdout.isTTY === true;
}

/**
 * Format the interactive-terminal error shown to CLI users.
 * @param commandName - Top-level command name.
 * @returns A human-readable error message.
 */
export function formatInteractiveTerminalError(commandName: string): string {
  return (
    `'makaio ${commandName}' requires an interactive terminal. ` +
    `Use 'makaio ${commandName} --help' for available subcommands.`
  );
}

/**
 * Register a {@link CliContribution} as a Commander subcommand tree.
 *
 * The bus is pre-connected and shared across the entire CLI invocation.
 * When `null` (server unreachable, auth failure, or timeout), commands
 * still register for `--help` visibility but actions fail with a
 * contextual error message from `connectionError`.
 * @param program - The root Commander program or parent command.
 * @param contribution - The plugin's CLI contribution.
 * @param bus - Pre-connected bus instance, or `null` when the connection failed.
 * @param connectionError - Human-readable reason the bus connection failed.
 */
export function registerContribution(
  program: CommandInstance,
  contribution: CliContribution,
  bus: IMakaioBus | null,
  connectionError?: string,
): void {
  const { cmd, created } = findOrCreateCommand(program, contribution.name, contribution.description);

  for (const sub of contribution.subcommands) {
    if (!claimSubcommandName(cmd, sub.name, `${contribution.name} ${sub.name}`, 'contribution')) continue;
    registerSubcommand(cmd, sub, bus, connectionError, contribution.beforeRun);
  }

  if (created && contribution.interactive) {
    const interactiveHandler = contribution.interactive;
    const contributionBeforeRun = contribution.beforeRun;
    cmd.action(async () => {
      if (!hasInteractiveTerminal()) {
        console.error(formatInteractiveTerminalError(contribution.name));
        process.exitCode = 1;
        return;
      }
      const gate = await evaluateBeforeRunGate(
        contributionBeforeRun,
        { subcommandName: INTERACTIVE_SUBCOMMAND, args: {}, bus },
        connectionError,
      );
      if (!gate.allowed) {
        console.error(gate.message);
        process.exitCode = gate.exitCode;
        return;
      }
      try {
        await interactiveHandler({ bus });
      } catch (err) {
        console.error(`Command failed:`, err instanceof Error ? err.message : err);
        process.exitCode = 1;
      }
    });
  }
}

/**
 * Register a single {@link CliSubcommandEntry} on a parent Commander command.
 *
 * Walks the Zod schema's shape, reads `.meta()` from each field, and creates
 * the corresponding Commander options/arguments.
 * @param parent - The parent Commander command to attach the subcommand to.
 * @param entry - The subcommand definition (schema + handler).
 * @param bus - Pre-connected bus instance, or `null` when the connection failed.
 * @param connectionError - Human-readable reason the bus connection failed.
 * @param beforeRun - Optional pre-execution gate from the contribution.
 */
function registerSubcommand(
  parent: CommandInstance,
  entry: CliSubcommandEntry,
  bus: IMakaioBus | null,
  connectionError?: string,
  beforeRun?: CliContribution['beforeRun'],
): void {
  const cmd = parent.command(entry.name).description(entry.description);

  const shape = entry.schema.shape;
  for (const [key, rawField] of Object.entries(shape)) {
    const fieldSchema = rawField as FieldSchema;
    const meta = getMeta(fieldSchema);
    const description = meta?.description ?? '';

    if (meta?.positional) {
      registerArgument(cmd, key, fieldSchema, meta, description);
    } else {
      registerOption(cmd, key, fieldSchema, meta, description);
    }
  }

  cmd.action(async () => {
    const rawOpts = cmd.opts();
    const rawArgs = collectPositionalArgs(cmd, shape);
    const merged = { ...rawOpts, ...rawArgs };

    const parsed = entry.schema.safeParse(merged);
    if (!parsed.success) {
      cmd.error(formatZodError(parsed.error));
      return;
    }

    const gate = await evaluateBeforeRunGate(
      beforeRun,
      { subcommandName: entry.name, args: parsed.data as Record<string, unknown>, bus },
      connectionError,
    );
    if (!gate.allowed) {
      console.error(gate.message);
      process.exitCode = gate.exitCode;
      return;
    }

    const { context, cleanup } = createProcessCommandContext(parsed.data, bus);
    try {
      await entry.handler(context);
    } catch (err) {
      console.error(`Command failed:`, err instanceof Error ? err.message : err);
      process.exitCode = 1;
    } finally {
      cleanup();
    }
  });
}

/**
 * Register a positional argument on a Commander command.
 * @param cmd - Commander command to add the argument to.
 * @param key - The schema field name.
 * @param fieldSchema - The Zod schema for this field.
 * @param meta - Resolved `.meta()` with CLI-specific fields.
 * @param description - Human-readable description.
 */
function registerArgument(
  cmd: CommandInstance,
  key: string,
  fieldSchema: FieldSchema,
  meta: z.GlobalMeta | undefined,
  description: string,
): void {
  const isOptional = fieldSchema.isOptional();
  const placeholder = (meta?.placeholder ?? key).replace(/^[<[]+|[>\]]+$/g, '');
  const argSyntax = isOptional ? `[${placeholder}]` : `<${placeholder}>`;
  if (isNumberSchema(fieldSchema)) {
    cmd.argument(argSyntax, description, parseNumericArg);
  } else {
    cmd.argument(argSyntax, description);
  }
}

/**
 * Register a named option on a Commander command.
 * @param cmd - Commander command to add the option to.
 * @param key - The schema field name (becomes `--key`).
 * @param fieldSchema - The Zod schema for this field.
 * @param meta - Resolved `.meta()` with CLI-specific fields.
 * @param description - Human-readable description.
 */
function registerOption(
  cmd: CommandInstance,
  key: string,
  fieldSchema: FieldSchema,
  meta: z.GlobalMeta | undefined,
  description: string,
): void {
  const longFlag = `--${toCliLongOptionName(key)}`;
  const shortFlag = meta?.short;
  const placeholder = meta?.placeholder ?? `<${key}>`;

  const isBoolean = isBooleanSchema(fieldSchema);
  const isNumber = isNumberSchema(fieldSchema);
  const flagParts = shortFlag ? `${shortFlag}, ${longFlag}` : longFlag;
  const flags = isBoolean ? flagParts : `${flagParts} ${placeholder}`;

  if (fieldSchema.isOptional()) {
    if (isNumber) {
      cmd.option(flags, description, parseNumericArg);
    } else {
      cmd.option(flags, description);
    }
  } else {
    if (isNumber) {
      cmd.requiredOption(flags, description, parseNumericArg);
    } else {
      cmd.requiredOption(flags, description);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect positional argument values from a Commander command.
 * @param cmd - The Commander command that was parsed.
 * @param shape - The Zod schema shape to find positional fields.
 * @returns An object mapping positional field names to their parsed values.
 */
function collectPositionalArgs(cmd: CommandInstance, shape: z.ZodRawShape): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const args = cmd.processedArgs;
  let argIndex = 0;

  for (const [key, rawField] of Object.entries(shape)) {
    const meta = getMeta(rawField as FieldSchema);
    if (meta?.positional && argIndex < args.length) {
      result[key] = args[argIndex];
      argIndex++;
    }
  }

  return result;
}

/**
 * Format a Zod error into a human-readable CLI error message.
 * @param error - The Zod validation error.
 * @returns A formatted error string.
 */
export function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
}
