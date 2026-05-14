import { createBusNamespace } from '@makaio/core';
import { UiSchemas } from './ui-schemas.js';

/**
 * Bus namespace definition for UI surface lifecycle events.
 *
 * This is the canonical public namespace definition for the `ui.*`
 * contract and should be imported by all producers/consumers.
 * @example
 * ```typescript
 * // Emit the ready event after the React tree mounts
 * bus.emit(UiSubjects.ready, { surface: 'electron', timestamp: Date.now() });
 *
 * // Request navigation
 * await bus.request(UiSubjects.navigate, { url: '/project/abc-123' });
 * ```
 */
export const UiNamespace = createBusNamespace('ui', UiSchemas);

/**
 * Typed subject tree for the UI namespace.
 *
 * Use this for all emit/on calls instead of raw string subjects.
 */
export const UiSubjects = UiNamespace.subjects;
