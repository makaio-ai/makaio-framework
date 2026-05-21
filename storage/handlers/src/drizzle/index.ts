/**
 * Drizzle-specific storage handler factories.
 *
 * ## Overview
 *
 * This module provides factory functions for creating Drizzle-based storage
 * handlers with minimal boilerplate. It builds on the core utilities to provide
 * ready-to-use handlers for common CRUD operations.
 *
 * ## Factories
 *
 * - `createDrizzleCrudHandlers`: Generate get, set, delete handlers
 * - `createDrizzleListHandler`: Generate list handler with scope filtering
 * - `buildScopePredicates`: Build scope-based where predicates
 * @packageDocumentation
 */

export { createDrizzleCrudHandlers } from './crud-handlers';
export { createDrizzleListHandler } from './list-handler';
export { buildScopePredicates } from './scope-predicates';
export type { CrudLifecycleConfig, DrizzleCrudConfig, DrizzleListConfig } from './types';
