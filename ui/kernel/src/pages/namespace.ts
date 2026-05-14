/**
 * Page bus namespace definition.
 *
 * Declares the `pages` namespace subjects and schemas. Registration happens
 * explicitly at composition roots via `bus.registerNamespace(PageNamespace)`.
 * @packageDocumentation
 */
import { createBusNamespace } from '@makaio/core';
import { PageSchemas } from './schemas.js';

/**
 * Page namespace registration.
 *
 * Provides type-safe subjects for querying page metadata over the bus.
 * Used by slash commands, navigation, and surface-aware page filtering.
 */
export const PageNamespace = createBusNamespace('pages', PageSchemas);

/**
 * Page bus subjects for querying page metadata.
 *
 * Subjects available:
 * - `PageSubjects.list` — Query available pages with optional surface filter (RPC)
 */
export const PageSubjects = PageNamespace.subjects;
