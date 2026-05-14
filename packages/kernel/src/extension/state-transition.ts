import type { IMakaioBus } from '@makaio/bus-core';
import { ExtensionSubjects } from '../observability/extension-namespace.js';
import type { ComponentState } from '../observability/shared-schemas.js';
import type { KernelMakaioExtension } from './types.js';

interface TransitionEntry {
  readonly pkg: KernelMakaioExtension;
  state: ComponentState;
  readonly error?: string;
}

/**
 * Static boolean flags indicating which contribution surfaces an extension declares.
 *
 * Emitted with every `stateChanged` event so subsystems can filter the bus for
 * only the extension families they care about without inspecting the full manifest.
 */
export interface ContributionFlags {
  /** Whether the extension contributes at least one adapter. */
  adapters: boolean;
  /** Whether the extension contributes tools. */
  tools: boolean;
  /** Whether the extension contributes triggers. */
  triggers: boolean;
  /** Whether the extension contributes providers. */
  providers: boolean;
  /** Whether the extension contributes clients. */
  clients: boolean;
  /** Whether the extension contributes UI surfaces. */
  ui: boolean;
  /** Whether the extension contributes storage. */
  storage: boolean;
  /** Whether the extension contributes session event actions. */
  sessionEventActions: boolean;
}

/**
 * Derive static contribution-surface flags from an extension manifest.
 *
 * These flags are emitted with every `stateChanged` event so subsystems
 * (e.g. `AdapterSubsystemService`) can filter the bus for only the
 * extension families they care about without inspecting the full manifest.
 * @param pkg - Extension manifest to inspect.
 * @returns Object with one boolean flag per contribution surface.
 */
function deriveContributes(pkg: KernelMakaioExtension): ContributionFlags {
  return {
    adapters: !!pkg.adapters?.length,
    tools: !!pkg.tools,
    triggers: !!pkg.triggers,
    providers: !!pkg.providers?.length,
    clients: !!pkg.clients?.length,
    ui: !!pkg.ui,
    storage: !!pkg.storage,
    sessionEventActions: !!pkg.sessionEventActions,
  };
}

/**
 * Transition an extension entry and emit the observable state change.
 * @param bus - Bus that receives `kernel:extension.stateChanged`.
 * @param entry - Extension entry to transition.
 * @param to - Target lifecycle state.
 */
export function transitionPackageEntry(bus: IMakaioBus, entry: TransitionEntry, to: ComponentState): void {
  const from = entry.state;
  entry.state = to;

  void bus
    .emit(ExtensionSubjects.stateChanged, {
      name: entry.pkg.name,
      displayName: entry.pkg.displayName,
      from,
      to,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      contributes: deriveContributes(entry.pkg),
    })
    .catch((err: unknown) => {
      console.error(`[ExtensionCoordinator] stateChanged emit failed for "${entry.pkg.name}":`, err);
    });
}
