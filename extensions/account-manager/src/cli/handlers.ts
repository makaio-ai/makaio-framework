/**
 * Non-interactive CLI handlers for the account-manager subcommands.
 *
 * Each handler calls bus RPCs against the running AccountManager service and
 * writes human-readable output via `ctx.output`. Errors are written via
 * `ctx.output.error` and `ctx.setExitCode(1)` is used on failure.
 */
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { Account } from '../bus/schemas.js';
import { requireBus } from '@makaio/kernel/cli';
import type { CommandContext } from '@makaio/kernel/cli';
import type { IMakaioBus } from '@makaio/bus-core';
import { displayLabel, displayMeta } from '../utils/format-account-display.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Find the clientId that owns a given accountId by scanning all available
 * sources.
 * @param bus - Connected bus instance.
 * @param accountId - Account identifier to look up.
 * @returns The owning clientId, or `undefined` if not found.
 */
async function findClientForAccount(
  bus: IMakaioBus,
  accountId: string,
  // Account IDs are stable UUIDs assigned at first detection (pre-release;
  // no legacy fingerprint-based IDs exist). They are not derived from
  // credential content and remain constant across token rotations and
  // process restarts. Collision across different clients is astronomically
  // unlikely, so returning the first match is safe without ambiguity detection.
): Promise<string | undefined> {
  const { sources } = await bus.request(AccountManagerSubjects.accounts.getSources, {});
  const results = await Promise.all(
    sources
      .filter((s) => s.available)
      .map(async (s) => {
        const { accounts } = await bus.request(AccountManagerSubjects.accounts.list, {
          clientId: s.clientId,
        });
        return accounts.some((a) => a.id === accountId) ? s.clientId : undefined;
      }),
  );
  return results.find((id) => id !== undefined);
}

/**
 * Wraps a CLI handler body with consistent error handling.
 * Bus rejections and unexpected errors are written via `ctx.output.error`
 * with exitCode=1 set, matching the handler's own error contract.
 * @param ctx - The current command context.
 * @param action - The async handler body to execute.
 */
async function withErrorHandling(
  ctx: Pick<CommandContext<unknown>, 'output' | 'setExitCode'>,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    ctx.output.error(`${error instanceof Error ? error.message : String(error)}\n`);
    ctx.setExitCode(1);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Handler for `makaio account-manager list`.
 *
 * Fetches all accounts from available sources and writes them to stdout in
 * either table or JSON format.
 * @param ctx - CLI command context with parsed arguments and bus access.
 */
export async function handleList(ctx: CommandContext<{ clientId?: string; format: 'table' | 'json' }>): Promise<void> {
  await withErrorHandling(ctx, async () => {
    const bus = requireBus(ctx);
    const { sources } = await bus.request(AccountManagerSubjects.accounts.getSources, {});
    const clientIds = ctx.args.clientId
      ? [ctx.args.clientId]
      : sources.filter((s) => s.available).map((s) => s.clientId);

    const allAccounts: Array<{ clientId: string; accounts: Account[] }> = [];

    for (const id of clientIds) {
      const { accounts } = await bus.request(AccountManagerSubjects.accounts.list, {
        clientId: id,
      });
      if (accounts.length > 0) {
        allAccounts.push({ clientId: id, accounts });
      }
    }

    if (ctx.args.format === 'json') {
      ctx.output.write(`${JSON.stringify(allAccounts, null, 2)}\n`);
      return;
    }

    for (const { clientId, accounts } of allAccounts) {
      ctx.output.write(`\n${clientId}\n`);
      for (const acc of accounts) {
        const marker = acc.active ? '●' : '○';
        const label = displayLabel(acc);
        const meta = displayMeta(acc.metadata);
        ctx.output.write(`  ${marker} ${label}${meta ? `  [${meta}]` : ''}${acc.active ? '  (active)' : ''}\n`);
      }
    }

    if (allAccounts.length === 0) {
      ctx.output.write('No accounts found.\n');
    }
  });
}

/**
 * Handler for `makaio account-manager switch <id>`.
 *
 * Activates the specified account, inferring the clientId from available
 * sources when it is not supplied explicitly.
 * @param ctx - CLI command context with parsed arguments and bus access.
 */
export async function handleSwitch(ctx: CommandContext<{ accountId: string; clientId?: string }>): Promise<void> {
  await withErrorHandling(ctx, async () => {
    const bus = requireBus(ctx);
    let clientId = ctx.args.clientId;

    if (!clientId) {
      clientId = await findClientForAccount(bus, ctx.args.accountId);
      if (!clientId) {
        ctx.output.error(`Account "${ctx.args.accountId}" not found.\n`);
        ctx.setExitCode(1);
        return;
      }
    }

    const result = await bus.request(AccountManagerSubjects.credentials.switch, {
      clientId,
      accountId: ctx.args.accountId,
    });

    if (result.success) {
      ctx.output.write(`Switched ${clientId} to ${ctx.args.accountId}\n`);
    } else {
      ctx.output.error(`Switch failed: ${result.error ?? 'unknown error'}\n`);
      ctx.setExitCode(1);
    }
  });
}

/**
 * Handler for `makaio account-manager label <id> <label>`.
 *
 * Sets a human-readable label on the specified account, inferring the
 * clientId from available sources when it is not supplied explicitly.
 * @param ctx - CLI command context with parsed arguments and bus access.
 */
export async function handleLabel(
  ctx: CommandContext<{ accountId: string; label: string; clientId?: string }>,
): Promise<void> {
  await withErrorHandling(ctx, async () => {
    const bus = requireBus(ctx);
    let clientId = ctx.args.clientId;

    if (!clientId) {
      clientId = await findClientForAccount(bus, ctx.args.accountId);
      if (!clientId) {
        ctx.output.error(`Account "${ctx.args.accountId}" not found.\n`);
        ctx.setExitCode(1);
        return;
      }
    }

    const result = await bus.request(AccountManagerSubjects.accounts.label, {
      clientId,
      accountId: ctx.args.accountId,
      label: ctx.args.label,
    });

    if (result.success) {
      ctx.output.write(`Labeled ${ctx.args.accountId} as "${ctx.args.label}"\n`);
    } else {
      ctx.output.error('Label update failed.\n');
      ctx.setExitCode(1);
    }
  });
}

/**
 * Handler for `makaio account-manager remove <id>`.
 *
 * Removes the specified account, inferring the clientId from available sources
 * when it is not supplied explicitly.
 * @param ctx - CLI command context with parsed arguments and bus access.
 */
export async function handleRemove(ctx: CommandContext<{ accountId: string; clientId?: string }>): Promise<void> {
  await withErrorHandling(ctx, async () => {
    const bus = requireBus(ctx);
    let clientId = ctx.args.clientId;

    if (!clientId) {
      clientId = await findClientForAccount(bus, ctx.args.accountId);
      if (!clientId) {
        ctx.output.error(`Account "${ctx.args.accountId}" not found.\n`);
        ctx.setExitCode(1);
        return;
      }
    }

    const result = await bus.request(AccountManagerSubjects.accounts.remove, {
      clientId,
      accountId: ctx.args.accountId,
    });

    if (result.success) {
      ctx.output.write(`Removed ${ctx.args.accountId} from ${clientId}\n`);
    } else {
      ctx.output.error('Remove failed.\n');
      ctx.setExitCode(1);
    }
  });
}

/**
 * Handler for `makaio account-manager sources`.
 *
 * Lists all detected credential sources with their availability status and
 * any configuration issues.
 * @param ctx - CLI command context with parsed arguments and bus access.
 */
export async function handleSources(ctx: CommandContext<Record<string, never>>): Promise<void> {
  await withErrorHandling(ctx, async () => {
    const bus = requireBus(ctx);
    const { sources } = await bus.request(AccountManagerSubjects.accounts.getSources, {});

    for (const source of sources) {
      const status = source.available ? '✓' : '✗';
      ctx.output.write(`${status} ${source.displayName} (${source.clientId})\n`);
      if (source.configIssue) {
        ctx.output.write(`  ⚠ ${source.configIssue.reason}\n`);
        ctx.output.write(`    ${source.configIssue.action}\n`);
      }
    }
  });
}
