import type { SessionEditorAction, ActionCategory } from '../../session-editor/types.js';

/**
 * Registry for pipeline actions.
 * Actions are registered at startup and looked up during pipeline execution.
 */
class ActionRegistry {
  private actions = new Map<string, SessionEditorAction>();

  /**
   * Register a pipeline action.
   * @param action - Action definition
   */
  public register(action: SessionEditorAction): void {
    if (this.actions.has(action.id)) {
      throw new Error(`Action already registered: ${action.id}`);
    }
    this.actions.set(action.id, action);
  }

  /**
   * Get an action by ID.
   * @param id - Action identifier
   * @returns Action or undefined if not found
   */
  public get(id: string): SessionEditorAction | undefined {
    return this.actions.get(id);
  }

  /**
   * Get all registered actions.
   * @returns Array of all actions
   */
  public getAll(): SessionEditorAction[] {
    return Array.from(this.actions.values());
  }

  /**
   * Get actions by category.
   * @param category - Category to filter by
   * @returns Actions in that category
   */
  public getByCategory(category: ActionCategory): SessionEditorAction[] {
    return this.getAll().filter((a) => a.category === category);
  }

  /**
   * Clear all registered actions.
   * @internal For testing only - clears state between tests.
   */
  public reset(): void {
    this.actions.clear();
  }
}

/** Global action registry instance */
export const actionRegistry = new ActionRegistry();
