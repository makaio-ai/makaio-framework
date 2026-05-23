import type { IWorkflowTriggerTypeRegistry, WorkflowTriggerTypeRecord } from '@makaio/contracts';

/**
 * In-memory registry for workflow trigger types.
 * Aggregates built-in and extension-contributed trigger types.
 * Consumed by the executor's listTriggerTypes handler and extension contribution registration.
 */
export class WorkflowTriggerTypeRegistry implements IWorkflowTriggerTypeRegistry {
  private readonly records = new Map<string, WorkflowTriggerTypeRecord>();
  private readonly listeners = new Set<() => void>();
  private cachedAll: WorkflowTriggerTypeRecord[] = [];

  /**
   * Register a trigger type.
   * @param record - Trigger type record to register
   * @returns Cleanup function to unregister
   */
  public register(record: WorkflowTriggerTypeRecord): () => void {
    this.records.set(record.type, record);
    this.notifyListeners();
    return () => {
      if (this.records.get(record.type) === record) {
        this.records.delete(record.type);
        this.notifyListeners();
      }
    };
  }

  /**
   * Get all registered trigger types.
   * Returns a stable reference that only changes when the registry is mutated.
   * @returns Array of all registered trigger type records
   */
  public getAll(): WorkflowTriggerTypeRecord[] {
    return this.cachedAll;
  }

  /**
   * Get a trigger type by its type string.
   * @param type - The trigger type string to look up
   * @returns The trigger type record if found, undefined otherwise
   */
  public get(type: string): WorkflowTriggerTypeRecord | undefined {
    return this.records.get(type);
  }

  /**
   * Subscribe to registry changes.
   * @param listener - Callback invoked on any registration/unregistration
   * @returns Cleanup function to unsubscribe
   */
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Refresh the cached array and notify all listeners.
   * The cache is updated before listeners are called so that any
   * {@link getAll} call inside a listener sees the new snapshot.
   */
  private notifyListeners(): void {
    this.cachedAll = [...this.records.values()];
    for (const listener of this.listeners) {
      listener();
    }
  }
}
