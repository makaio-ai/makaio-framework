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
