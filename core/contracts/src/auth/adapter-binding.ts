import { z } from 'zod';
import { AuthEnvironmentVariableNameSchema, AuthFieldIdSchema } from './definitions.js';
import { AuthMethodRefSchema, type AuthMethodRef } from './selection.js';

/** JSON-safe literal supported by connector auth delivery constants. */
export const AdapterAuthConstantSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

/**
 * Return whether a record contains at least one own entry.
 * @param value - Record whose own entries are inspected.
 * @returns True when the record contains at least one entry.
 */
function hasEntries(value: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(value).length > 0;
}

const DeliveryFieldNameSchema = z.string().trim().min(1);

const ProcessEnvironmentFieldsSchema = z
  .record(AuthFieldIdSchema, AuthEnvironmentVariableNameSchema)
  .refine(hasEntries, { message: 'Process-environment delivery fields must not be empty.' });

const ConnectorFieldsSchema = z
  .record(AuthFieldIdSchema, DeliveryFieldNameSchema)
  .refine(hasEntries, { message: 'Connector delivery fields must not be empty.' });

/** Map resolved credential fields into a spawned process environment. */
export const ProcessEnvAdapterAuthDeliverySchema = z
  .object({
    kind: z.literal('process-env'),
    fields: ProcessEnvironmentFieldsSchema,
  })
  .strict();

/** Map resolved fields and JSON constants into an adapter-owned operation. */
export const ConnectorAdapterAuthDeliverySchema = z
  .object({
    kind: z.literal('connector'),
    target: z.string().trim().min(1),
    fields: ConnectorFieldsSchema,
    constants: z.record(DeliveryFieldNameSchema, AdapterAuthConstantSchema).optional(),
  })
  .strict();

/** Delegate authentication materialization to a native client. */
export const NativeClientAdapterAuthDeliverySchema = z
  .object({
    kind: z.literal('native-client'),
    clientId: z.string().trim().min(1),
  })
  .strict();

/** Declare that the selected path performs no authentication delivery. */
export const NoAdapterAuthDeliverySchema = z.object({ kind: z.literal('none') }).strict();

/** One runtime-only adapter delivery strategy for a selected auth method. */
export const AdapterAuthDeliverySchema = z.discriminatedUnion('kind', [
  ProcessEnvAdapterAuthDeliverySchema,
  ConnectorAdapterAuthDeliverySchema,
  NativeClientAdapterAuthDeliverySchema,
  NoAdapterAuthDeliverySchema,
]);

const AdapterAuthDeliveriesSchema = z.tuple([AdapterAuthDeliverySchema]).rest(AdapterAuthDeliverySchema);

/** Runtime-only compatibility and delivery declaration for one auth method. */
export const AdapterAuthBindingSchema = z
  .object({
    method: AuthMethodRefSchema,
    deliveries: AdapterAuthDeliveriesSchema,
  })
  .strict()
  .superRefine((binding, ctx) => {
    if (binding.deliveries.some(({ kind }) => kind === 'none') && binding.deliveries.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A none delivery must be the only delivery in its binding.',
        path: ['deliveries'],
      });
    }

    for (const [index, delivery] of binding.deliveries.entries()) {
      if (delivery.kind !== 'native-client') {
        continue;
      }
      if (binding.method.owner !== 'client' || binding.method.clientId !== delivery.clientId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Native-client delivery must target the client that owns the bound auth method.',
          path: ['deliveries', index, 'clientId'],
        });
      }
    }
  });

/**
 * Build a stable equality key for a provider- or client-owned method ref.
 * @param method - Authentication method reference to identify.
 * @returns Owner-qualified method reference key.
 */
function methodRefKey(method: AuthMethodRef): string {
  return JSON.stringify(
    method.owner === 'provider'
      ? [method.owner, method.providerDefinitionId, method.methodId]
      : [method.owner, method.clientId, method.methodId],
  );
}

/** Complete runtime-only authentication metadata for one adapter/provider ref. */
export const AdapterProviderAuthSchema = z
  .object({
    bindings: z.array(AdapterAuthBindingSchema).min(1),
    scrubEnvVars: z.array(AuthEnvironmentVariableNameSchema),
  })
  .strict()
  .superRefine((auth, ctx) => {
    const seenMethodRefs = new Set<string>();
    for (const [index, binding] of auth.bindings.entries()) {
      const key = methodRefKey(binding.method);
      if (seenMethodRefs.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Adapter auth bindings must reference unique methods.',
          path: ['bindings', index, 'method'],
        });
      } else {
        seenMethodRefs.add(key);
      }
    }

    const seenScrubEnvVars = new Set<string>();
    for (const [index, variable] of auth.scrubEnvVars.entries()) {
      if (seenScrubEnvVars.has(variable)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate scrub environment variable "${variable}".`,
          path: ['scrubEnvVars', index],
        });
      } else {
        seenScrubEnvVars.add(variable);
      }
    }
  })
  .brand<'AdapterProviderAuth'>();

export type AdapterAuthConstant = z.infer<typeof AdapterAuthConstantSchema>;

/** Readonly declaration shape for process-environment auth delivery. */
export interface ProcessEnvAdapterAuthDelivery {
  readonly kind: 'process-env';
  readonly fields: Readonly<Record<string, string>>;
}

/** Readonly declaration shape for connector auth delivery. */
export interface ConnectorAdapterAuthDelivery {
  readonly kind: 'connector';
  readonly target: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly constants?: Readonly<Record<string, AdapterAuthConstant>>;
}

/** Readonly declaration shape for native-client auth delivery. */
export interface NativeClientAdapterAuthDelivery {
  readonly kind: 'native-client';
  readonly clientId: string;
}

/** Readonly declaration shape for an explicit no-delivery binding. */
export interface NoAdapterAuthDelivery {
  readonly kind: 'none';
}

export type AdapterAuthDelivery =
  | ProcessEnvAdapterAuthDelivery
  | ConnectorAdapterAuthDelivery
  | NativeClientAdapterAuthDelivery
  | NoAdapterAuthDelivery;

/** Readonly runtime declaration for one method binding. */
export interface AdapterAuthBinding {
  readonly method: AuthMethodRef;
  readonly deliveries: readonly [AdapterAuthDelivery, ...AdapterAuthDelivery[]];
}

/** Unvalidated readonly declaration accepted by {@link defineAdapterProviderAuth}. */
export interface AdapterProviderAuthInput {
  readonly bindings: readonly AdapterAuthBinding[];
  readonly scrubEnvVars: readonly string[];
}

/** Validated runtime declaration attached to an adapter/provider ref. */
export type AdapterProviderAuth = z.infer<typeof AdapterProviderAuthSchema>;

/**
 * Validate and clone one runtime-only adapter/provider auth declaration.
 *
 * Adapter definitions call this at declaration time so invalid target names,
 * duplicate bindings, and inconsistent native-client ownership fail before
 * the adapter enters the runtime registry.
 * @param auth - Authentication declaration to validate.
 * @returns Parsed authentication declaration.
 */
export function defineAdapterProviderAuth(auth: AdapterProviderAuthInput): AdapterProviderAuth {
  return AdapterProviderAuthSchema.parse(auth);
}
