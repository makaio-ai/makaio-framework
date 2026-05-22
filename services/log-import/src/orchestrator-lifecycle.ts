/**
 * Pure orchestrator lifecycle utilities for the log-import registry.
 *
 * These functions are extracted from the registry class so they can be
 * tested independently and reused without coupling to `this`.
 * @packageDocumentation
 */

import type { LogImportOrchestrator } from '@makaio/ai-adapters-core';
import type { OrchestratorEntry } from './types.js';

/**
 * Stop, dispose, and remove an orchestrator entry when present.
 *
 * Idempotent: safely handles missing entries and partially-started orchestrators.
 * The entry is always deleted from the map, even if stop or dispose throws.
 * @param orchestrators - Mutable map of orchestrator entries keyed by importer ID
 * @param importerId - Unique importer ID
 */
export async function stopAndDisposeOrchestrator(
  orchestrators: Map<string, OrchestratorEntry>,
  importerId: string,
): Promise<void> {
  const existing = orchestrators.get(importerId);
  if (!existing) {
    return;
  }
  try {
    if (existing.orchestrator.isRunning()) {
      await existing.orchestrator.stop();
    }
  } finally {
    try {
      await existing.orchestrator.dispose();
    } finally {
      // Ensure stale orchestrator entries are always removed.
      orchestrators.delete(importerId);
    }
  }
}

/**
 * Start an orchestrator, rolling back (stop + dispose) if start throws.
 *
 * Ensures no dangling running orchestrator is left behind when start fails.
 * Re-throws the original start error after cleanup.
 * @param orchestrator - Orchestrator instance to start
 * @param importerId - Importer ID used only in the warning log on cleanup failure
 */
export async function startOrchestratorOrCleanup(
  orchestrator: LogImportOrchestrator,
  importerId: string,
): Promise<void> {
  try {
    await orchestrator.start();
  } catch (error) {
    try {
      try {
        if (orchestrator.isRunning()) {
          await orchestrator.stop();
        }
      } finally {
        await orchestrator.dispose();
      }
    } catch (cleanupError) {
      console.warn(
        `[LogImportRegistry] Failed to clean up orchestrator after start failure for '${importerId}'.`,
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      );
    }
    throw error;
  }
}
