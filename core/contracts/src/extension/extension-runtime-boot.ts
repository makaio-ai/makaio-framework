/**
 * Runtime subsystems with exactly one executable owner per boot.
 *
 * These declarations are runtime-owned metadata on {@link MakaioExtension},
 * not descriptor discovery metadata. Boot uses them to select default
 * framework packages only when no loaded extension provides the same
 * executable responsibility.
 */
export interface ExtensionRuntimeOwnership {
  /** Owns the `session.sendMessage` orchestration handlers for this runtime. */
  readonly sessionOrchestrator?: boolean;
}

/**
 * Check whether one runtime ownership field is claimed.
 *
 * A field is claimed only when it is strictly `true` — `false`, `undefined`,
 * and an absent `ownership` object all mean "not claimed". This is the one
 * place that encodes the field-level `=== true` rule; the boot-time
 * single-owner selector (`findRuntimeOwners` in `@makaio/runtime-node`) calls
 * through this helper instead of re-testing the field itself, so the rule
 * cannot drift between call sites.
 * @param ownership - Runtime ownership declaration to inspect, or `undefined`.
 * @param field - Ownership field to check.
 * @returns `true` when `ownership[field]` is strictly `true`.
 */
export function isRuntimeOwnershipFieldClaimed<K extends keyof ExtensionRuntimeOwnership>(
  ownership: ExtensionRuntimeOwnership | undefined,
  field: K,
): boolean {
  return ownership?.[field] === true;
}
