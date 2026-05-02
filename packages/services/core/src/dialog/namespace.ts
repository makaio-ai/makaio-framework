/**
 * Dialog bus namespace registration.
 *
 * Importing this module registers the `dialog` namespace on the bus as a
 * side effect. Import via `@makaio/services-core/dialog/namespace` at your
 * application composition root.
 * @packageDocumentation
 */
import { MakaioBus } from '@makaio/bus-core';
import { DialogSchemas } from './schemas.js';

/**
 * Dialog namespace registration.
 *
 * Provides type-safe subjects for UI dialog operations (confirmation and
 * text-input prompts). The UI handler must keep each request open until
 * the user responds; set bus timeouts accordingly.
 */
export const DialogNamespace = MakaioBus.registerNamespace('dialog', DialogSchemas);

/**
 * Typed subjects for dialog operations.
 *
 * Subjects available:
 * - `DialogSubjects.confirm` — Request user confirmation (RPC)
 * - `DialogSubjects.prompt` — Request text input (RPC)
 */
export const DialogSubjects = DialogNamespace.subjects;
