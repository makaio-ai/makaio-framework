/**
 * Variant namespace registration — has side effects (registers on the bus).
 *
 * For pure Zod schemas without side effects, import `./schemas` instead.
 * @example
 * ```typescript
 * // Query the current variant
 * const info = await MakaioBus.request(VariantSubjects.getInfo, {});
 * console.log(info.variant); // 'base' | 'cef'
 *
 * // Request an upgrade (stub in Task 8)
 * const result = await MakaioBus.request(VariantSubjects.requestUpgrade, {
 *   targetVariant: 'cef',
 * });
 *
 * // Track upgrade progress
 * MakaioBus.on(VariantSubjects.upgradeProgress, (ctx) => {
 *   const { status, percent } = ctx.payload;
 *   console.log('Upgrade:', status, percent);
 * });
 * ```
 */
import { MakaioBus } from '@makaio/bus-core';
import { VariantSchemas } from './schemas.js';

/**
 * Variant namespace registration.
 * Provides typed subjects for variant detection and upgrade operations.
 */
export const VariantNamespace = MakaioBus.registerNamespace('host:variant', VariantSchemas);

/**
 * Variant subjects for type-safe bus operations.
 * Use these with MakaioBus.request(), MakaioBus.on(), etc.
 */
export const VariantSubjects = VariantNamespace.subjects;
