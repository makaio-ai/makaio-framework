import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { ApprovalPolicy } from '@makaio/contracts';

// Invariant: at least one of adapter_name or client_id must be set.
// Enforced at the application layer by HarnessDefinitionSchema.refine()
// in contracts/src/harness/schemas.ts. Drizzle does not support
// declarative CHECK constraints; the test DDL in __tests__/shared.ts
// includes an explicit CHECK for defense-in-depth.
//
// Uniqueness: (name, scope) pairs are unique by construction — the harness
// service generates IDs via sha256((clientId ?? adapterName) + '\0' + name),
// so identical scope+name always produces the same primary key. No separate
// unique index is needed; scope immutability is enforced in resolveHarnessId.
export const harnessDefinitions = sqliteTable('harness_definitions', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  /**
   * Adapter driver name (e.g. openai-node, gemini-sdk).
   * Optional when `clientId` is set; required for API-only adapters.
   */
  adapterName: text('adapter_name'),
  /**
   * Client package identifier (e.g. claude-code, codex).
   * Set for harnesses scoped to a specific client application.
   */
  clientId: text('client_id'),
  /**
   * Environment variable overrides injected into the execution environment.
   * Stored as JSON map of string → string.
   */
  env: text('env', { mode: 'json' }).$type<Record<string, string>>(),
  /** Maps credential field names to environment variable names for
   *  credential resolution at execution time. Values are env var names
   *  (e.g., 'ANTHROPIC_API_KEY'), not the secrets themselves. Actual
   *  secret storage is handled by the platform's CredentialService. */
  credentials: text('credentials', { mode: 'json' }).$type<Record<string, string>>(),
  /** Working directory override for process-based adapters. */
  cwd: text('cwd'),
  approvalPolicy: text('approval_policy').notNull().default('always-ask'),
  nativeToolsEnabled: text('native_tools_enabled', { mode: 'json' }).$type<string[]>().notNull(),
  nativeToolsDisabled: text('native_tools_disabled', { mode: 'json' }).$type<string[]>().notNull(),
  registryToolsEnabled: text('registry_tools_enabled', { mode: 'json' }).$type<string[]>().notNull(),
  registryToolsDisabled: text('registry_tools_disabled', { mode: 'json' }).$type<string[]>().notNull(),
  skillsEnabled: text('skills_enabled', { mode: 'json' }).$type<string[]>(),
  skillsDisabled: text('skills_disabled', { mode: 'json' }).$type<string[]>(),
  /** Maps adapter-native tool names to their canonical capability strings. */
  toolCapabilityMap: text('tool_capability_map', { mode: 'json' }).$type<Record<string, readonly string[]>>(),
  /** Per-capability approval policy overrides (JSON map: capability → policy). */
  capabilityOverrides: text('capability_overrides', { mode: 'json' }).$type<Record<string, ApprovalPolicy>>(),
  /** Per-tool approval policy overrides (JSON map: tool name → policy). */
  toolApprovalOverrides: text('tool_approval_overrides', { mode: 'json' }).$type<Record<string, ApprovalPolicy>>(),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type InsertHarnessDefinition = typeof harnessDefinitions.$inferInsert;
export type SelectHarnessDefinition = typeof harnessDefinitions.$inferSelect;
