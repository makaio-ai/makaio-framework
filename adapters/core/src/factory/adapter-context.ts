import type { IMakaioBus, ScopedBus } from '@makaio/bus-core';
import type { AIAdapterCapability } from '../types/capabilities.js';

/**
 * Context provided to adapter implementations.
 *
 * Contains shared infrastructure and configuration that all adapters need:
 * - Adapter name and capabilities from config
 * - Local event bus for emitting events
 */
export interface AIAdapterContext<Scope extends ScopedBus<string>> {
  /** Unique adapter instance identifier. */
  adapterId: string;

  /** Unique adapter name (kebab-case). */
  name: string;

  /** Adapter capabilities (unparsed). Use parseAIAdapterCapabilities() to parse. */
  capabilities: AIAdapterCapability[];

  /** Scoped bus for adapter-level events. */
  adapterBus: Scope;

  /** Global event bus. */
  globalBus: IMakaioBus;
}
