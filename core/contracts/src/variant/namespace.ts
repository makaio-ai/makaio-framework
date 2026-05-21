/**
 * Variant namespace definition.
 *
 * Import `./schemas` when only pure Zod schemas are needed. Composition roots
 * register this namespace explicitly.
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
import { createBusNamespace } from '@makaio/core';
import { VariantSchemas } from './schemas.js';

/**
 * Variant namespace definition.
 * Provides typed subjects for variant detection and upgrade operations.
 */
export const VariantNamespace = createBusNamespace('host:variant', VariantSchemas);

/**
 * Variant subjects for type-safe bus operations.
 * Use these with MakaioBus.request(), MakaioBus.on(), etc.
 */
export const VariantSubjects = VariantNamespace.subjects;
