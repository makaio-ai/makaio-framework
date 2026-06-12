import { defineDualTable } from '@makaio/storage-drizzle';
import type { ApprovalPolicy } from '@makaio/contracts';

// Invariant: at least one of adapter_name or client_id must be set.
// Enforced at the application layer by HarnessDefinitionSchema.refine()
// in contracts/src/harness/schemas.ts.
//
// Uniqueness: (name, scope) pairs are unique by construction — the harness
// service generates IDs via sha256((clientId ?? adapterName) + '\0' + name),
// so identical scope+name always produces the same primary key. No separate
// unique index is needed; scope immutability is enforced in resolveHarnessId.
export const harnessDefinitionsDual = defineDualTable('harness_definitions', (c) => ({
  id: c.text('id').primaryKey(),
  name: c.text('name').notNull(),
  description: c.text('description'),
  /**
   * Adapter driver name (e.g. openai-node, gemini-sdk).
   * Optional when `clientId` is set; required for API-only adapters.
   */
  adapterName: c.text('adapter_name'),
  /**
   * Client package identifier (e.g. claude-code, codex).
   * Set for harnesses scoped to a specific client application.
   */
  clientId: c.text('client_id'),
  /**
   * Environment variable overrides injected into the execution environment.
   * Stored as a JSON map of string → string.
   */
  env: c.jsonCol<Record<string, string>>('env'),
  /** Maps credential field names to environment variable names for
   *  credential resolution at execution time. Values are env var names
   *  (e.g., 'ANTHROPIC_API_KEY'), not the secrets themselves. Actual
   *  secret storage is handled by the platform's CredentialService. */
  credentials: c.jsonCol<Record<string, string>>('credentials'),
  /** Working directory override for process-based adapters. */
  cwd: c.text('cwd'),
  approvalPolicy: c.text('approval_policy').notNull().default('always-ask'),
  nativeToolsEnabled: c.jsonCol<string[]>('native_tools_enabled').notNull(),
  nativeToolsDisabled: c.jsonCol<string[]>('native_tools_disabled').notNull(),
  registryToolsEnabled: c.jsonCol<string[]>('registry_tools_enabled').notNull(),
  registryToolsDisabled: c.jsonCol<string[]>('registry_tools_disabled').notNull(),
  skillsEnabled: c.jsonCol<string[]>('skills_enabled'),
  skillsDisabled: c.jsonCol<string[]>('skills_disabled'),
  /** Maps adapter-native tool names to their canonical capability strings. */
  toolCapabilityMap: c.jsonCol<Record<string, readonly string[]>>('tool_capability_map'),
  /** Per-capability approval policy overrides (JSON map: capability → policy). */
  capabilityOverrides: c.jsonCol<Record<string, ApprovalPolicy>>('capability_overrides'),
  /** Per-tool approval policy overrides (JSON map: tool name → policy). */
  toolApprovalOverrides: c.jsonCol<Record<string, ApprovalPolicy>>('tool_approval_overrides'),
  isDefault: c.bool('is_default').notNull().default(false),
  enabled: c.bool('enabled').notNull().default(true),
  createdAt: c.epochMs('created_at').notNull(),
  updatedAt: c.epochMs('updated_at').notNull(),
}));

/** SQLite face of the `harness_definitions` table (canonical schema). */
export const harnessDefinitions = harnessDefinitionsDual.sqlite;

export type InsertHarnessDefinition = typeof harnessDefinitions.$inferInsert;
export type SelectHarnessDefinition = typeof harnessDefinitions.$inferSelect;
