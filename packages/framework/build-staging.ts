import { cpSync, mkdirSync, rmSync } from 'node:fs';

/** Completed isolated output from one framework build group. */
export interface FrameworkBuildStage {
  /** Stable group name used for diagnostics and merge ordering. */
  readonly name: string;
  /** Absolute directory containing the group's completed build output. */
  readonly path: string;
}

/**
 * Assemble isolated framework build stages into one distribution directory.
 *
 * Stages are applied in caller order so any identical shared chunk is merged
 * deterministically while group-owned entrypoints coexist in the final tree.
 * @param stages - Completed build stages in deterministic merge order.
 * @param destination - Final framework distribution directory.
 */
export function mergeFrameworkBuildStages(stages: readonly FrameworkBuildStage[], destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const stage of stages) {
    cpSync(stage.path, destination, { recursive: true, force: true });
  }
}
