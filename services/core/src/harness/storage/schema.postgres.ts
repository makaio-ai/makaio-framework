/**
 * Postgres twin schema for the harness definitions table.
 *
 * Congruent twin of `schema.ts` — identical SQL names, column types mapped to
 * Postgres equivalents via the shared column bundles. Row types are exclusively
 * owned by the canonical `schema.ts`; this file exports table objects only.
 */
import { pgTable, text } from 'drizzle-orm/pg-core';
import { epochMs, bool, jsonCol } from '@makaio/storage-drizzle/columns/postgres';
import type { ApprovalPolicy } from '@makaio/contracts';

/** Postgres twin of the `harness_definitions` table. */
export const harnessDefinitions = pgTable('harness_definitions', {
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
  /** Environment variable overrides injected into the execution environment. */
  env: jsonCol<Record<string, string>>('env'),
  /** Maps credential field names to environment variable names. */
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
