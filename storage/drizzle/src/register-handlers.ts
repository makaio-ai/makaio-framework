import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionContext } from '@makaio/contracts';
import type { MakaioDatabase } from './types';

/**
 * Typed storage handler registration callback with `db` narrowed to
 * {@link MakaioDatabase}.
 *
 * Use this as the argument type for your handler registration function when
 * wrapping it with {@link registerDrizzleHandlers}.
 * @typeParam TSchema - Drizzle table schema record. Defaults to an empty schema.
 */
export type DrizzleHandlerRegistration<TSchema extends Record<string, unknown> = Record<string, never>> = (
  bus: IMakaioBus,
  db: MakaioDatabase<TSchema>,
  ctx: ExtensionContext,
) => (() => void) | void;

/**
 * Wraps a typed Drizzle handler registration into the
 * `(bus, db: unknown, ctx) => ...` shape required by
 * {@link MakaioExtension.storage.registerHandlers}.
 *
 * The single `db as MakaioDatabase` cast lives here — at the Drizzle
 * boundary — so package authors receive a fully-typed `db` without
 * repeating the unsafe cast at every registration site.
 * @param registration - Typed handler registration callback.
 * @returns Opaque callback compatible with the contracts-layer signature.
 */
export function registerDrizzleHandlers<TSchema extends Record<string, unknown> = Record<string, never>>(
  registration: DrizzleHandlerRegistration<TSchema>,
): (bus: IMakaioBus, db: unknown, ctx: ExtensionContext) => (() => void) | void {
  return (bus, db, ctx) => registration(bus, db as MakaioDatabase<TSchema>, ctx);
}
