import { MakaioBus } from '@makaio/bus-core';
import { UiSchemas } from './ui-schemas.js';

/**
 * Registered MakaioBus namespace for UI surface lifecycle events.
 *
 * This is the canonical public namespace definition for the `ui.*`
 * contract and should be imported by all producers/consumers.
 *
 * Importing this module triggers namespace registration as a side effect.
 * @example
 * ```typescript
 * import '@makaio/ui-kernel/ui/register';
 *
 * // Emit the ready event after the React tree mounts
 * bus.emit(UiSubjects.ready, { surface: 'electron', timestamp: Date.now() });
 *
 * // Request navigation
 * await bus.request(UiSubjects.navigate, { url: '/project/abc-123' });
 * ```
 */
export const UiNamespace = MakaioBus.registerNamespace('ui', UiSchemas);

/**
 * Typed subject tree for the UI namespace.
 *
 * Use this for all emit/on calls instead of raw string subjects.
 */
export const UiSubjects = UiNamespace.subjects;
