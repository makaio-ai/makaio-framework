import { emit } from '../methods/emit.js';
import type { MakaioBusContext } from '../types/bus.js';
import type { SubjectDefinition } from '@makaio/core';

/** Minimal subjects shape accepted by {@link wireLifecycleEmitter}. */
export interface LifecycleSubjects {
  connected: SubjectDefinition;
  disconnected: SubjectDefinition;
}

/**
 * Wire lifecycle emission on a bus context's transport registry.
 *
 * Called once per bus instance after construction. Each transport's `onConnected`
 * and `onDisconnected` callbacks are set by the registry during `registerTransport`;
 * they delegate to this emitter so `BusLifecycle.connected` / `BusLifecycle.disconnected`
 * fire automatically for all registered transports without factory-level wiring.
 * @param context - Bus context whose transport registry receives the emitter.
 * @param subjects - Connected and disconnected subject definitions for emission.
 */
export function wireLifecycleEmitter(context: MakaioBusContext, subjects: LifecycleSubjects): void {
  context.transportRegistry.setLifecycleEmitter({
    // onConnected and onDisconnected are intentionally kept as two distinct callbacks
    // rather than a single callback with a state argument. Each event carries different
    // semantic payload (only the transport name here, but future payloads may diverge),
    // and subscribers should be able to react to one without being aware of the other.
    onConnected(name: string): void {
      emit(context, subjects.connected, { transport: name }).catch((error: unknown) => {
        console.error('[bus] lifecycle emit error on connected:', error);
      });
    },
    onDisconnected(name: string): void {
      emit(context, subjects.disconnected, { transport: name }).catch((error: unknown) => {
        console.error('[bus] lifecycle emit error on disconnected:', error);
      });
    },
  });
}
