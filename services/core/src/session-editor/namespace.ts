import { createBusNamespace } from '@makaio/core';
import { SessionEditorSchemas } from './schemas.js';

/**
 * Session editor namespace for bus communication.
 *
 * Provides subjects for session editor actions and pipeline operations.
 */
export const SessionEditorNamespace = createBusNamespace('session-editor', SessionEditorSchemas);

/**
 * Session editor subject definitions.
 *
 * Use these subjects to interact with session editor services via the bus.
 * @example
 * ```typescript
 * // List available actions
 * const { actions } = await bus.request(SessionEditorSubjects.listActions, {});
 * ```
 */
export const SessionEditorSubjects = SessionEditorNamespace.subjects;
