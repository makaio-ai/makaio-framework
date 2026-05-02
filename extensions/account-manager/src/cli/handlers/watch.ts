/**
 * Handler for the `account-manager watch` subcommand.
 *
 * Outputs bus events as NDJSON (one JSON line per event) to stdout.
 * Suitable for piping to `jq` or log aggregators.
 *
 * The interactive dashboard is now built into the main `account-manager` TUI,
 * so `watch` is exclusively a machine-consumable event stream.
 */
import { AccountManagerSubjects } from '../../bus/namespace.js';
import type { CommandContext } from '@makaio/kernel/cli';

/**
 * Write a single NDJSON line.
 * @param ctx - CLI command context.
 * @param type - The event type discriminant.
 * @param payload - The event payload.
 */
function emit(ctx: Pick<CommandContext<unknown>, 'output'>, type: string, payload: unknown): void {
  ctx.output.write(`${JSON.stringify({ ...flattenPayload(payload), type })}\n`);
}

/**
 * Handler for `makaio account-manager watch`.
 *
 * Subscribes to all account-manager bus events and writes each as a single
 * JSON line to `ctx.output`. Resolves when `ctx.signal` is aborted (e.g. on
 * SIGINT).
 * @param ctx - CLI command context with parsed arguments and bus access.
 */
export async function handleWatch(ctx: CommandContext<unknown>): Promise<void> {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    ctx.bus.on(AccountManagerSubjects.credentials.detected, (busCtx) => {
      emit(ctx, 'credentials.detected', busCtx.payload);
    }),
    ctx.bus.on(AccountManagerSubjects.credentials.switched, (busCtx) => {
      emit(ctx, 'credentials.switched', busCtx.payload);
    }),
    ctx.bus.on(AccountManagerSubjects.credentials.refreshed, (busCtx) => {
      emit(ctx, 'credentials.refreshed', busCtx.payload);
    }),
    ctx.bus.on(AccountManagerSubjects.credentials.error, (busCtx) => {
      emit(ctx, 'credentials.error', busCtx.payload);
    }),
    ctx.bus.on(AccountManagerSubjects.usage.updated, (busCtx) => {
      emit(ctx, 'usage.updated', busCtx.payload);
    }),
    ctx.bus.on(AccountManagerSubjects.accounts.metadataPatched, (busCtx) => {
      emit(ctx, 'accounts.metadataPatched', busCtx.payload);
    }),
  );

  await new Promise<void>((resolve) => {
    let cleanedUp = false;
    const onAbort = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      ctx.signal.removeEventListener('abort', onAbort);
      cleanups.forEach((fn) => fn());
      resolve();
    };
    // Register the listener BEFORE checking aborted to close the TOCTOU window:
    // if the signal fires between addEventListener and the check, the listener
    // catches it; if it already fired, the check below catches it. { once: true }
    // ensures the listener auto-removes so onAbort runs exactly once.
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) {
      onAbort();
    }
  });
}

/**
 * Spread a payload object's enumerable own properties at the top level.
 *
 * Keeps the NDJSON line flat for easy `jq` consumption while preserving nested
 * objects within field values. Arrays and primitives are wrapped under a
 * `value` key so the output is always a plain object.
 * @param payload - The bus event payload.
 * @returns A plain object whose properties can be spread into the NDJSON record.
 */
function flattenPayload(payload: unknown): Record<string, unknown> {
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return { value: payload };
}
