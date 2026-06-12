import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { epochMs, bool, jsonCol } from '@makaio/storage-drizzle/columns/sqlite';
import type { ApprovalPolicy } from '@makaio/contracts';

// Invariant: at least one of adapter_name or client_id must be set.
// Enforced at the application layer by HarnessDefinitionSchema.refine()
// in contracts/src/harness/schemas.ts.
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
   * Stored as a JSON map of string → string.
   */
  env: jsonCol<Record<string, string>>('env'),
  /** Maps credential field names to environment variable names for
   *  credential resolution at execution time. Values are env var names
   *  (e.g., 'ANTHROPIC_API_KEY'), not the secrets themselves. Actual
   *  secret storage is handled by the platform's CredentialService. */
  credentials: jsonCol<Record<string, string>>('credentials'),
  /** Working directory override for process-based adapters. */
  cwd: text('cwd'),
  approvalPolicy: text('approval_policy').notNull().default('always-ask'),
  nativeToolsEnabled: jsonCol<string[]>('native_tools_enabled').notNull(),
  nativeToolsDisabled: jsonCol<string[]>('native_tools_disabled').notNull(),
  registryToolsEnabled: jsonCol<string[]>('registry_tools_enabled').notNull(),
  registryToolsDisabled: jsonCol<string[]>('registry_tools_disabled').notNull(),
  skillsEnabled: jsonCol<string[]>('skills_enabled'),
  skillsDisabled: jsonCol<string[]>('skills_disabled'),
  /** Maps adapter-native tool names to their canonical capability strings. */
  toolCapabilityMap: jsonCol<Record<string, readonly string[]>>('tool_capability_map'),
  /** Per-capability approval policy overrides (JSON map: capability → policy). */
  capabilityOverrides: jsonCol<Record<string, ApprovalPolicy>>('capability_overrides'),
  /** Per-tool approval policy overrides (JSON map: tool name → policy). */
  toolApprovalOverrides: jsonCol<Record<string, ApprovalPolicy>>('tool_approval_overrides'),
  isDefault: bool('is_default').notNull().default(false),
  enabled: bool('enabled').notNull().default(true),
  createdAt: epochMs('created_at').notNull(),
  updatedAt: epochMs('updated_at').notNull(),
});

export type InsertHarnessDefinition = typeof harnessDefinitions.$inferInsert;
export type SelectHarnessDefinition = typeof harnessDefinitions.$inferSelect;
