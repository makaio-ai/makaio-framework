/**
 * Record describing a registered workflow trigger type.
 * Produced by serializing plugin-contributed Zod schemas to JSON Schema.
 */
import type { JsonValue } from '../shared/json-value.js';

export interface WorkflowTriggerTypeRecord {
  /** Globally unique trigger type string. */
  type: string;
  /** Display name for the editor palette. */
  displayName: string;
  /** Lucide icon name. */
  icon: string;
  /** Palette group label (e.g., 'GitHub', 'Core'). */
  category: string;
  /** Human-readable description. */
  description?: string;
  /** JSON Schema derived from configSchema. */
  configJsonSchema: Record<string, JsonValue>;
  /** JSON Schema derived from outputSchema. */
  outputJsonSchema: Record<string, JsonValue>;
  /** 'builtin' or plugin name. */
  source: string;
}

/**
 * Registry for workflow trigger types.
 * Aggregates built-in and plugin-contributed trigger types.
 * Consumed by the editor palette and expression autocomplete.
 */
export interface IWorkflowTriggerTypeRegistry {
  /**
   * Register a trigger type.
   * @param record - Trigger type record to register
   * @returns Cleanup function to unregister
   */
  register(record: WorkflowTriggerTypeRecord): () => void;

  /**
   * Get all registered trigger types.
   * @returns Array of all registered trigger type records
   */
  getAll(): WorkflowTriggerTypeRecord[];

  /**
   * Get a trigger type by its type string.
   * @param type - The trigger type string to look up
   * @returns The trigger type record if found, undefined otherwise
   */
  get(type: string): WorkflowTriggerTypeRecord | undefined;

  /**
   * Subscribe to registry changes.
   * @param listener - Callback invoked on any registration/unregistration
   * @returns Cleanup function to unsubscribe
   */
  subscribe(listener: () => void): () => void;
}
