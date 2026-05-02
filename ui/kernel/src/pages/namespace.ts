/**
 * Page bus namespace registration.
 *
 * Importing this module registers the `pages` namespace on the bus as a
 * side effect. Import via `@makaio/ui-kernel/pages/namespace` at your
 * application composition root.
 * @packageDocumentation
 */
import { MakaioBus } from '@makaio/bus-core';
import { PageSchemas } from './schemas.js';

/**
 * Page namespace registration.
 *
 * Provides type-safe subjects for querying page metadata over the bus.
 * Used by slash commands, navigation, and surface-aware page filtering.
 */
export const PageNamespace = MakaioBus.registerNamespace('pages', PageSchemas);

/**
 * Page bus subjects for querying page metadata.
 *
 * Subjects available:
 * - `PageSubjects.list` — Query available pages with optional surface filter (RPC)
 */
export const PageSubjects = PageNamespace.subjects;
