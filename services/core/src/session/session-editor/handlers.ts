import type { IMakaioBus } from '@makaio/bus-core';
import { SessionEditorSubjects } from '../../session-editor/namespace.js';
import type { ActionSummary } from '../../session-editor/schemas.js';
import { actionRegistry } from './action-registry.js';

/**
 * Register handler for session-editor.listActions.
 *
 * Maps all registered actions to UI-safe summaries by stripping the execute
 * method and keeping only id, label, description, and category.
 * @param bus - Bus instance to register on
 * @returns Cleanup function to unsubscribe the handler
 */
export function registerListActionsHandler(bus: IMakaioBus): () => void {
  return bus.on(SessionEditorSubjects.listActions, (ctx) => {
    const allActions = actionRegistry.getAll();

    // Map to UI-safe summaries (strip execute method)
    const actions: ActionSummary[] = allActions.map((action) => ({
      id: action.id,
      label: action.label,
      description: action.description,
      category: action.category,
    }));

    ctx.setResult({ actions });
  });
}
