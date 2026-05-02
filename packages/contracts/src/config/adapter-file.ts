import { z } from 'zod';
import { JsonObjectContractSchema } from '../shared/index.js';

/**
 * Canonical schema version string for adapter config files.
 */
export const ADAPTER_FILE_SCHEMA_VERSION = 'makaio/adapter-config/v1' as const;

const HelpLinkSchema = z
  .object({
    label: z.string().min(1),
    url: z.string().url(),
  })
  .strict();

const AdapterBindingSchema = z
  .object({
    providerConfigId: z.string().trim().min(1),
    isDefault: z.boolean().optional(),
  })
  .strict();

const AdapterBindingsSchema = z.array(AdapterBindingSchema).superRefine((bindings, ctx) => {
  const seenProviderConfigIds = new Set<string>();
  let defaultBindingIndex: number | null = null;

  for (const [index, binding] of bindings.entries()) {
    if (seenProviderConfigIds.has(binding.providerConfigId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate adapter binding for providerConfigId "${binding.providerConfigId}".`,
        path: [index, 'providerConfigId'],
      });
    } else {
      seenProviderConfigIds.add(binding.providerConfigId);
    }

    if (!binding.isDefault) {
      continue;
    }

    if (defaultBindingIndex !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Adapter config files may declare at most one default binding.',
        path: [index, 'isDefault'],
      });
      continue;
    }

    defaultBindingIndex = index;
  }
});

/**
 * Schema for `.makaio/adapters/<adapterName>.json`.
 *
 * The file stem is the canonical `adapterName`; the payload stores only the
 * adapter's own settings and bindings.
 *
 * Metadata such as `description`, `helpLinks`, `instructions`, `clientId`,
 * `protocol`, and `providerDefinitionIds` intentionally remain here because
 * the plan freezes them into the public `EffectiveAdapter` view. Keeping them
 * on the canonical adapter file lets framework-only and host consumers read
 * the same adapter catalog without a second boot-owned projection layer.
 */
export const AdapterFileSchema = z
  .object({
    $schema: z.literal(ADAPTER_FILE_SCHEMA_VERSION),
    enabled: z.boolean().optional(),
    displayName: z.string().optional(),
    description: z.string().optional(),
    helpLinks: z.array(HelpLinkSchema).optional(),
    instructions: z.string().optional(),
    clientId: z.string().optional(),
    protocol: z.string().optional(),
    providerDefinitionIds: z.array(z.string()).optional(),
    settings: JsonObjectContractSchema.optional(),
    bindings: AdapterBindingsSchema.optional(),
  })
  .strict();

/**
 * Inferred type for a file-canonical adapter record.
 */
export type AdapterFile = z.infer<typeof AdapterFileSchema>;
