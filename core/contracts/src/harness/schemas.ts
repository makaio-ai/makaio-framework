import { z } from 'zod';
import { ToolCapabilitySchema } from '../tool-capability/index.js';

/** Approval policy used when a tool invocation requires authorization. */
export const ApprovalPolicySchema = z.enum(['reject', 'always-ask', 'full-access']);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

/** Per-tool approval policy overrides keyed by tool name. */
export const ToolApprovalOverridesSchema = z.record(z.string(), ApprovalPolicySchema);
export type ToolApprovalOverrides = z.infer<typeof ToolApprovalOverridesSchema>;

const HarnessToolSelectionSchema = z.object({
  /** Tool names explicitly enabled by the harness. */
  enabled: z.array(z.string()),
  /** Tool names explicitly disabled by the harness. */
  disabled: z.array(z.string()),
});

// Invariant: at least one of clientId or adapterName must be set.
// Zod does not allow .omit() on a refined schema, so this predicate is applied
// independently to HarnessDefinitionSchema and HarnessDefinitionCreateSchema.
const requiresAdapterOrClient = (data: {
  clientId?: string | null | undefined;
  adapterName?: string | null | undefined;
}): boolean => !!data.clientId || !!data.adapterName;

const ADAPTER_OR_CLIENT_MESSAGE = 'At least one of clientId or adapterName must be set';

/**
 * Base object shape shared between stored and create schemas.
 * Exported for consumers that need to call `.omit()` — refined schemas
 * (`ZodEffects`) do not support `.omit()` in Zod v4.
 */
export const HarnessDefinitionBaseSchema = z.object({
  /** Unique identifier. */
  id: z.string(),
  /** Unique harness name for adapter-scoped lookup. */
  name: z.string(),
  /** Human-readable description. */
  description: z.string().optional(),
  /**
   * Adapter driver name (e.g. openai-node, gemini-sdk).
   * Optional when `clientId` is set; required for API-only adapters.
   */
  adapterName: z.string().min(1).optional(),
  /**
   * Client package identifier (e.g. claude-code, codex).
   * Set for harnesses scoped to a specific client application.
   */
  clientId: z.string().min(1).optional(),
  /** Default approval policy. */
  approvalPolicy: ApprovalPolicySchema.default('always-ask'),
  /** Native adapter tool allow/deny settings. */
  nativeTools: HarnessToolSelectionSchema,
  /** Registry tool allow/deny settings. */
  registryTools: HarnessToolSelectionSchema,
  /** Optional skills allow/deny settings. */
  skills: HarnessToolSelectionSchema.optional(),
  /**
   * Maps adapter-native tool names to their canonical capabilities.
   * Used by resolution paths to expand capability-based filters into concrete tool names.
   */
  toolCapabilityMap: z.record(z.string(), z.array(ToolCapabilitySchema).readonly()).optional(),
  /** Per-capability approval policy overrides. Most-restrictive wins when combined with the base policy. */
  capabilityOverrides: z.record(z.string(), ApprovalPolicySchema).optional(),
  /**
   * Per-tool approval policy overrides keyed by tool name.
   * Takes precedence over the harness-level `approvalPolicy` for the named tool.
   * Persona and profile policies still override these harness-level tool overrides.
   * Capability overrides are applied on top using most-restrictive-wins semantics.
   */
  toolApprovalOverrides: ToolApprovalOverridesSchema.optional(),
  /**
   * Environment variables injected into the execution environment for this harness.
   * Merged with (and overriding) the platform baseline environment.
   */
  env: z.record(z.string(), z.string()).optional(),
  /** Maps credential field names to environment variable names.
   *  Values are env var names, not secrets — actual credential storage
   *  is handled by the platform's CredentialService. */
  credentials: z.record(z.string(), z.string()).optional(),
  /**
   * Working directory override for process-based adapters.
   * When absent, the adapter's default working directory is used.
   */
  cwd: z.string().optional(),
  /** Whether this is a shipped default harness. */
  isDefault: z.boolean().default(false),
  /** Enabled state for selection/resolution. */
  enabled: z.boolean().default(true),
  /** Created timestamp (ms). */
  createdAt: z.number(),
  /** Updated timestamp (ms). */
  updatedAt: z.number(),
});

/**
 * Stored harness definition.
 *
 * A harness selects tool availability and execution policies for one adapter.
 * Either `adapterName` (for API-only adapters) or `clientId` (for client-scoped
 * harnesses) must be set; both may be present.
 */
export const HarnessDefinitionSchema = HarnessDefinitionBaseSchema.refine(requiresAdapterOrClient, {
  message: ADAPTER_OR_CLIENT_MESSAGE,
});

export type HarnessDefinition = z.infer<typeof HarnessDefinitionSchema>;

/** Input payload for create/update operations. */
export const HarnessDefinitionCreateSchema = HarnessDefinitionBaseSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
  .extend({
    // Keep these optional for update flows so omitted fields don't silently reset existing values.
    approvalPolicy: ApprovalPolicySchema.optional(),
    isDefault: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine(requiresAdapterOrClient, { message: ADAPTER_OR_CLIENT_MESSAGE });

export type HarnessDefinitionCreate = z.infer<typeof HarnessDefinitionCreateSchema>;

/** Shipped default harness shape (timestamps are generated at seed time). */
export type DefaultHarnessDefinition = Omit<HarnessDefinition, 'createdAt' | 'updatedAt'>;
