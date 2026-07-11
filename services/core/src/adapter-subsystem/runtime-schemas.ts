import { z } from 'zod';
import { ResolvedProviderContextSchema } from '@makaio/contracts/adapter';
import {
  AdapterProviderAuthSchema,
  AuthCredentialFieldDefinitionSchema,
  AuthMethodRefSchema,
  ClientAuthMethodRefSchema,
  ExplicitAuthMethodDefinitionSchema,
  NativeAccountSelectionSchema,
  ProviderConfigManagerSchema,
} from '@makaio/contracts/auth';
import { AdapterFileSchema, StoredProtocolEndpointsSchema } from '@makaio/contracts/config';
import { ModelFilterModeSchema, ModelVisibilitySchema, ProtocolIdSchema } from '@makaio/contracts/provider';
import { ProviderRecordSchema } from '../settings/storage/providers-namespace.js';

const CompatibleAdapterNamesSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .refine((names) => new Set(names).size === names.length, {
    message: 'Compatible adapter names must be unique.',
  });

/** Credential-free summary of one persisted provider-config auth selection. */
export const ProviderConfigAuthSummarySchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('explicit'),
      method: AuthMethodRefSchema,
      hasCredentials: z.literal(true),
    })
    .strict(),
  z
    .object({
      mode: z.literal('inferred'),
      method: ClientAuthMethodRefSchema,
      account: NativeAccountSelectionSchema.optional(),
      hasCredentials: z.literal(false),
    })
    .strict(),
  z
    .object({
      mode: z.literal('none'),
      method: AuthMethodRefSchema,
      hasCredentials: z.literal(false),
    })
    .strict(),
]);

/** Authentication method that at least one loaded adapter can deliver. */
export const CompatibleAuthOptionSchema = z
  .discriminatedUnion('mode', [
    z
      .object({
        definitionId: z.string().trim().min(1),
        method: AuthMethodRefSchema,
        mode: z.literal('explicit'),
        label: z.string().trim().min(1),
        description: z.string().trim().min(1).optional(),
        fields: ExplicitAuthMethodDefinitionSchema.shape.fields,
        compatibleAdapterNames: CompatibleAdapterNamesSchema,
        portability: z.literal('portable'),
      })
      .strict(),
    z
      .object({
        definitionId: z.string().trim().min(1),
        method: ClientAuthMethodRefSchema,
        mode: z.literal('inferred'),
        label: z.string().trim().min(1),
        description: z.string().trim().min(1).optional(),
        fields: z.array(AuthCredentialFieldDefinitionSchema).length(0),
        compatibleAdapterNames: CompatibleAdapterNamesSchema,
        portability: z.literal('local-only'),
      })
      .strict(),
    z
      .object({
        definitionId: z.string().trim().min(1),
        method: AuthMethodRefSchema,
        mode: z.literal('none'),
        label: z.string().trim().min(1),
        description: z.string().trim().min(1).optional(),
        fields: z.array(AuthCredentialFieldDefinitionSchema).length(0),
        compatibleAdapterNames: CompatibleAdapterNamesSchema,
        portability: z.literal('portable'),
      })
      .strict(),
  ])
  .superRefine((option, ctx) => {
    if (option.method.owner === 'provider' && option.method.providerDefinitionId !== option.definitionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provider-owned auth options must belong to the selected provider definition.',
        path: ['method', 'providerDefinitionId'],
      });
    }
  });

/** Bus-safe provider config read model that excludes credential references. */
export const ProviderConfigFileRecordSchema = z
  .object({
    id: z.string(),
    definitionId: z.string(),
    name: z.string(),
    endpointOverrides: StoredProtocolEndpointsSchema.optional(),
    modelVisibility: z.record(z.string(), ModelVisibilitySchema).optional(),
    modelFilterMode: ModelFilterModeSchema,
    isDefault: z.boolean(),
    enabled: z.boolean(),
    auth: ProviderConfigAuthSummarySchema,
    managedBy: ProviderConfigManagerSchema.optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.auth.method.owner === 'provider' && record.auth.method.providerDefinitionId !== record.definitionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provider-owned auth summaries must belong to the record provider definition.',
        path: ['auth', 'method', 'providerDefinitionId'],
      });
    }
  });

/** Inferred bus-safe provider config read model. */
export type ProviderConfigFileRecord = z.infer<typeof ProviderConfigFileRecordSchema>;
/** Inferred credential-free provider-config auth summary. */
export type ProviderConfigAuthSummary = z.infer<typeof ProviderConfigAuthSummarySchema>;
/** Inferred adapter-compatible authentication choice. */
export type CompatibleAuthOption = z.infer<typeof CompatibleAuthOptionSchema>;

/** Atomic, refs-only provider config, context, and definition snapshot. */
export const ProviderRuntimeSnapshotSchema = z
  .object({
    config: ProviderConfigFileRecordSchema,
    context: ResolvedProviderContextSchema,
    definition: ProviderRecordSchema,
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (
      snapshot.config.id !== snapshot.context.providerConfigId ||
      snapshot.config.definitionId !== snapshot.context.definitionId ||
      snapshot.definition.id !== snapshot.context.definitionId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provider runtime snapshot identities must describe the same config and definition.',
      });
    }

    const summary = snapshot.config.auth;
    const runtimeAuth = snapshot.context.auth;
    const methodsMatch =
      summary.method.owner === runtimeAuth.method.owner &&
      summary.method.methodId === runtimeAuth.method.methodId &&
      (summary.method.owner === 'provider'
        ? runtimeAuth.method.owner === 'provider' &&
          summary.method.providerDefinitionId === runtimeAuth.method.providerDefinitionId
        : runtimeAuth.method.owner === 'client' && summary.method.clientId === runtimeAuth.method.clientId);
    const accountsMatch =
      summary.mode !== 'inferred' ||
      runtimeAuth.mode !== 'inferred' ||
      summary.account === runtimeAuth.account ||
      (summary.account?.managerId === runtimeAuth.account?.managerId &&
        summary.account?.accountId === runtimeAuth.account?.accountId);
    if (summary.mode !== runtimeAuth.mode || !methodsMatch || !accountsMatch) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provider runtime snapshot auth summary must match its refs-only runtime auth selection.',
        path: ['config', 'auth'],
      });
    }
  });

/** Atomic provider runtime snapshot inferred from the bus-safe schema. */
export type ProviderRuntimeSnapshot = z.infer<typeof ProviderRuntimeSnapshotSchema>;

/** Stable failure reasons for atomic adapter runtime resolution. */
export const AdapterRuntimeSnapshotErrorCodeSchema = z.enum([
  'provider-config-not-found',
  'provider-config-disabled',
  'adapter-not-loaded',
  'adapter-not-bound',
  'provider-incompatible',
  'auth-binding-missing',
  'client-incompatible',
  'runtime-package-metadata-missing',
  'snapshot-identity-mismatch',
]);

/** Canonical package identities resolved locally by an isolated runtime. */
export const AdapterRuntimePackagesSchema = z
  .object({
    adapter: z.object({ packageName: z.string().trim().min(1) }).strict(),
    provider: z
      .object({
        packageName: z.string().trim().min(1),
        definitionId: z.string().trim().min(1),
      })
      .strict(),
    client: z
      .object({
        packageName: z.string().trim().min(1),
        clientId: z.string().trim().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

/** One atomic refs-only adapter/provider runtime snapshot. */
export const AdapterRuntimeSnapshotSchema = z
  .object({
    snapshot: ProviderRuntimeSnapshotSchema,
    adapterName: z.string().trim().min(1),
    adapterClientId: z.string().trim().min(1).optional(),
    providerProtocol: ProtocolIdSchema.optional(),
    adapterProviderAuth: AdapterProviderAuthSchema,
    compatibleProviderAuths: z.array(AdapterProviderAuthSchema),
    runtimePackages: AdapterRuntimePackagesSchema,
  })
  .strict()
  .superRefine((runtime, ctx) => {
    const selectedMethod = runtime.snapshot.context.auth.method;
    const selectedClientId = runtime.adapterClientId;
    const clientPackage = runtime.runtimePackages.client;
    const providerPackage = runtime.runtimePackages.provider;
    const providerDefinition = runtime.snapshot.definition;
    const selectedBindingExists = runtime.adapterProviderAuth.bindings.some((binding) => {
      if (binding.method.owner !== selectedMethod.owner || binding.method.methodId !== selectedMethod.methodId) {
        return false;
      }
      return binding.method.owner === 'provider'
        ? selectedMethod.owner === 'provider' &&
            binding.method.providerDefinitionId === selectedMethod.providerDefinitionId
        : selectedMethod.owner === 'client' && binding.method.clientId === selectedMethod.clientId;
    });
    const clientMetadataMatches =
      selectedClientId === undefined ? clientPackage === undefined : clientPackage?.clientId === selectedClientId;
    const methodClientMatches = selectedMethod.owner !== 'client' || selectedMethod.clientId === selectedClientId;
    const providerMetadataMatches =
      providerPackage.definitionId === runtime.snapshot.context.definitionId &&
      providerPackage.packageName === providerDefinition.packageName;

    if (!selectedBindingExists || !clientMetadataMatches || !methodClientMatches || !providerMetadataMatches) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Adapter runtime snapshot identities must be internally coherent.',
      });
    }
  });

/** Typed success/failure result for atomic runtime resolution. */
export const AdapterRuntimeSnapshotResolutionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('resolved'), runtime: AdapterRuntimeSnapshotSchema }).strict(),
  z
    .object({
      status: z.literal('error'),
      code: AdapterRuntimeSnapshotErrorCodeSchema,
    })
    .strict(),
]);

/** Stable atomic adapter runtime resolution failure code. */
export type AdapterRuntimeSnapshotErrorCode = z.infer<typeof AdapterRuntimeSnapshotErrorCodeSchema>;
/** Canonical package identities resolved by the isolated runtime. */
export type AdapterRuntimePackages = z.infer<typeof AdapterRuntimePackagesSchema>;
/** Successful refs-only atomic adapter runtime snapshot. */
export type AdapterRuntimeSnapshot = z.infer<typeof AdapterRuntimeSnapshotSchema>;
/** Typed atomic adapter runtime resolution result. */
export type AdapterRuntimeSnapshotResolution = z.infer<typeof AdapterRuntimeSnapshotResolutionSchema>;

/** Binding record as surfaced by the adapter subsystem. */
export const BindingRecordSchema = z
  .object({
    adapterName: z.string(),
    providerConfigId: z.string(),
    isDefault: z.boolean(),
  })
  .strict();

/** Inferred binding record. */
export type BindingRecord = z.infer<typeof BindingRecordSchema>;

/** Normalized adapter file-backed read model. */
export const AdapterFileConfigSchema = AdapterFileSchema.omit({
  $schema: true,
  bindings: true,
})
  .extend({
    name: z.string(),
    enabled: z.boolean(),
    bindings: z.array(BindingRecordSchema),
  })
  .strict();

/** Inferred adapter file-backed read model. */
export type AdapterFileConfig = z.infer<typeof AdapterFileConfigSchema>;

/** Readiness status for the effective adapter view. */
export const AdapterReadinessSchema = z.enum(['ready', 'needs-setup']);
/** Inferred readiness status for the effective adapter view. */
export type AdapterReadiness = z.infer<typeof AdapterReadinessSchema>;

/** Help link metadata surfaced in the effective adapter view. */
export const HelpLinkSchema = z
  .object({
    label: z.string(),
    url: z.string(),
  })
  .strict();

/** Host-extensible effective adapter view. */
export const EffectiveAdapterSchema = z
  .object({
    name: z.string(),
    displayName: z.string(),
    description: z.string().optional(),
    enabled: z.boolean(),
    configCount: z.number(),
    readiness: AdapterReadinessSchema,
    supportsLogImport: z.boolean(),
    helpLinks: z.array(HelpLinkSchema).optional(),
    instructions: z.string().optional(),
    clientId: z.string().optional(),
    protocol: z.string().optional(),
    providerDefinitionIds: z.array(z.string()).optional(),
  })
  .strict();

/** Inferred effective adapter view. */
export type EffectiveAdapter = z.infer<typeof EffectiveAdapterSchema>;
