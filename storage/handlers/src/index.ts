/**
 * \@makaio/storage-handlers
 *
 * Storage handler factories for reducing boilerplate in storage implementations.
 *
 * ## Features
 * - **Core Utilities**: Helper functions for data transformation
 * - **Drizzle Factories**: Pre-built handlers for common CRUD operations
 * - **Type Safety**: Strong typing at call sites with runtime Zod validation
 * - **Scope Filtering**: Built-in project scope support
 *
 * ## Core Utilities
 *
 * - `nullToUndefined`: Convert null values to undefined
 * - `undefinedToNull`: Convert undefined values to null
 *
 * ## Drizzle Factories
 *
 * - `createDrizzleCrudHandlers`: Generate get, set, delete handlers
 * - `createDrizzleListHandler`: Generate list handler with scope filtering
 * - `buildScopePredicates`: Build scope-based where predicates
 *
 * Note: Factory implementations use minimal type assertions for Drizzle's dynamic
 * query builder and bus handler contexts. Type safety is enforced at call sites
 * through configuration type parameters.
 * @packageDocumentation
 */

// Core utilities
export { nullToUndefined, undefinedToNull } from './utils';

// Drizzle factories
export { createDrizzleCrudHandlers, createDrizzleListHandler, buildScopePredicates } from './drizzle';

export type { CrudLifecycleConfig, DrizzleCrudConfig, DrizzleListConfig } from './drizzle';
