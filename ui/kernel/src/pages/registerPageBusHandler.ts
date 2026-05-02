/**
 * Page bus handler - Bridges PageDefinitionRegistry to bus
 *
 * Registers a handler for PageSubjects.list that reads from the
 * PageDefinitionRegistry and returns PageMetadata to bus callers.
 * This enables server-side services (slash command) to query pages.
 * @packageDocumentation
 */
import type { IMakaioBus } from '@makaio/bus-core';
import { PageSubjects } from './namespace.js';
import { pageDefinitionRegistry } from './PageDefinitionRegistry.js';

/**
 * Register bus handler that serves page metadata from the registry.
 * @param bus - The MakaioBus instance to register on
 * @returns Cleanup function to unregister the handler
 * @example
 * ```typescript
 * import { registerPageBusHandler } from '@makaio/ui-kernel';
 * import { useBus } from '@makaio/ui-hooks';
 *
 * function App() {
 *   const bus = useBus();
 *
 *   useEffect(() => {
 *     const cleanup = registerPageBusHandler(bus);
 *     return cleanup;
 *   }, [bus]);
 * }
 * ```
 */
export function registerPageBusHandler(bus: IMakaioBus): () => void {
  return bus.on(PageSubjects.list, (ctx) => {
    const { surface } = ctx.payload;
    const pages = pageDefinitionRegistry.query(surface ? { surface } : {});
    ctx.setResult({
      pages: pages.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        mode: p.mode,
        level: p.level,
        // Only emit explicit surface IDs when they are declared.
        // Capability-only page visibility cannot be represented by the PageMetadata `surfaces` field.
        surfaces: p.surface === undefined ? 'all' : p.surface.surfaces ? [...p.surface.surfaces] : undefined,
      })),
    });
  });
}
