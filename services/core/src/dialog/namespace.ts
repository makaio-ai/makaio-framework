/**
 * Dialog bus namespace definition.
 *
 * Import via `@makaio/services-core/dialog/namespace` at your application
 * composition root and register the namespace explicitly.
 * @packageDocumentation
 */
import { createBusNamespace } from '@makaio/core';
import { DialogSchemas } from './schemas.js';

/**
 * Dialog namespace definition.
 *
 * Provides type-safe subjects for UI dialog operations (confirmation and
 * text-input prompts). The UI handler must keep each request open until
 * the user responds; set bus timeouts accordingly.
 */
export const DialogNamespace = createBusNamespace('dialog', DialogSchemas);

/**
 * Typed subjects for dialog operations.
 *
 * Subjects available:
 * - `DialogSubjects.confirm` — Request user confirmation (RPC)
 * - `DialogSubjects.prompt` — Request text input (RPC)
 */
export const DialogSubjects = DialogNamespace.subjects;
