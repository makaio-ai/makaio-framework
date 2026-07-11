import {
  AuthCredentialRefSchema,
  ProviderConfigAuthSchema,
  type AuthMethodRef,
  type ClientAuthMethodRef,
  type NativeAccountSelection,
  type ProviderConfigAuth,
} from '@makaio/contracts/auth';
import { buildStoredCredentialRef } from '@makaio/contracts/config';
import type { CompatibleAuthOption } from '@makaio/services-core/adapter-subsystem';

/** One explicit credential field sourced from encrypted product storage. */
export interface StoredAuthFieldDraft {
  readonly source: 'stored';
  readonly value: string;
}

/** One explicit credential field sourced from a declared environment variable. */
export interface EnvironmentAuthFieldDraft {
  readonly source: 'environment';
  readonly variable: string;
}

/** UI selection for one explicit authentication field. */
export type AuthFieldDraft = StoredAuthFieldDraft | EnvironmentAuthFieldDraft;

/** UI authentication selection before plaintext fields are persisted. */
export type ProviderConfigAuthDraft =
  | {
      readonly mode: 'explicit';
      readonly method: AuthMethodRef;
      readonly fields: Readonly<Record<string, AuthFieldDraft>>;
    }
  | {
      readonly mode: 'inferred';
      readonly method: ClientAuthMethodRef;
      readonly account?: NativeAccountSelection;
    }
  | {
      readonly mode: 'none';
      readonly method: AuthMethodRef;
    };

/** Normalized refs-only auth plus plaintext values that still need storage. */
export interface CompiledProviderConfigAuthDraft {
  /** Canonical refs-only selection persisted in the provider config. */
  readonly auth: ProviderConfigAuth;
  /** Plaintext values destined for the encrypted credential service. */
  readonly storedCredentials: Readonly<Record<string, string>>;
}

/**
 * Create editable field drafts for one compatible authentication option.
 * @param option - Exact adapter-compatible method selected by the UI.
 * @returns Stored-source drafts for every explicit field, or an empty map for non-explicit methods.
 */
export function createInitialAuthFieldDrafts(option: CompatibleAuthOption): Record<string, AuthFieldDraft> {
  return option.mode === 'explicit'
    ? Object.fromEntries(option.fields.map(({ id }) => [id, { source: 'stored' as const, value: '' }]))
    : {};
}

/**
 * Build one strict provider-config auth draft from an adapter-compatible option.
 *
 * This is the shared form boundary for onboarding and settings. It preserves
 * optional omissions, rejects undeclared field/source selections, and keeps
 * inferred account selection separate from explicit credential fields.
 * @param option - Exact adapter-compatible method selected by the UI.
 * @param fieldDrafts - Current explicit field-source/value drafts.
 * @param account - Optional native account selected for an inferred method.
 * @returns Complete mode-specific provider-config auth draft.
 */
export function buildProviderConfigAuthDraft(
  option: CompatibleAuthOption,
  fieldDrafts: Readonly<Record<string, AuthFieldDraft>> = {},
  account?: NativeAccountSelection,
): ProviderConfigAuthDraft {
  if (option.mode === 'explicit') {
    if (account) {
      throw new Error('Explicit authentication cannot select a native account.');
    }

    const definitionsById = new Map(option.fields.map((field) => [field.id, field]));
    const unexpectedFieldId = Object.keys(fieldDrafts).find((fieldId) => !definitionsById.has(fieldId));
    if (unexpectedFieldId) {
      throw new Error(
        `Authentication field "${unexpectedFieldId}" is not declared by method "${option.method.methodId}".`,
      );
    }

    const fields: Record<string, AuthFieldDraft> = {};
    for (const definition of option.fields) {
      const draft = fieldDrafts[definition.id];
      if (!draft || (draft.source === 'stored' && draft.value.length === 0)) {
        if (definition.required) {
          throw new Error(`Complete the required field: ${definition.label}.`);
        }
        continue;
      }

      if (draft.source === 'environment') {
        const declaredSource = definition.sourceHints.some(
          (hint) => hint.kind === 'environment' && hint.variable === draft.variable,
        );
        if (!declaredSource) {
          throw new Error(
            `Environment source "${draft.variable}" is not declared for authentication field "${definition.id}".`,
          );
        }
      }
      fields[definition.id] = draft;
    }

    return { mode: option.mode, method: { ...option.method }, fields };
  }

  if (Object.keys(fieldDrafts).length > 0) {
    throw new Error(`${option.mode} authentication cannot contain credential fields.`);
  }
  if (option.mode === 'inferred') {
    return {
      mode: option.mode,
      method: { ...option.method },
      ...(account ? { account: { ...account } } : {}),
    };
  }
  if (account) {
    throw new Error('No-auth authentication cannot select a native account.');
  }
  return { mode: option.mode, method: { ...option.method } };
}

/**
 * Build a collision-free owner-qualified key for UI method controls.
 * @param method - Normalized provider- or client-owned auth method.
 * @returns Stable key suitable for form control values.
 */
export function authMethodRefKey(method: AuthMethodRef): string {
  return method.owner === 'provider'
    ? `provider:${method.providerDefinitionId}:${method.methodId}`
    : `client:${method.clientId}:${method.methodId}`;
}

/**
 * Compile one UI auth draft into the canonical refs-only selection.
 *
 * Stored refs are deterministic from the final provider-config ID, allowing a
 * disabled reservation to contain its final auth snapshot before plaintext is
 * written. Environment-only, inferred, and no-auth drafts do not need an ID.
 * @param draft - Complete UI authentication selection.
 * @param providerConfigId - Final canonical ID when any field uses stored plaintext.
 * @returns Canonical auth plus the plaintext subset that still needs storage.
 */
export function compileProviderConfigAuthDraft(
  draft: ProviderConfigAuthDraft,
  providerConfigId?: string,
): CompiledProviderConfigAuthDraft {
  if (draft.mode !== 'explicit') {
    return {
      auth: ProviderConfigAuthSchema.parse(
        draft.mode === 'inferred'
          ? {
              mode: draft.mode,
              method: { ...draft.method },
              ...(draft.account ? { account: { ...draft.account } } : {}),
            }
          : { mode: draft.mode, method: { ...draft.method } },
      ),
      storedCredentials: {},
    };
  }

  const credentialRefs: Record<string, string> = {};
  const storedCredentials: Record<string, string> = {};
  for (const [fieldId, field] of Object.entries(draft.fields)) {
    if (field.source === 'environment') {
      credentialRefs[fieldId] = AuthCredentialRefSchema.parse(`env:${field.variable}`);
      continue;
    }

    if (!providerConfigId) {
      throw new Error('Stored authentication fields require the final provider-config ID.');
    }
    if (field.value.length === 0) {
      throw new Error(`Stored authentication field "${fieldId}" cannot be empty.`);
    }
    credentialRefs[fieldId] = buildStoredCredentialRef(providerConfigId, fieldId);
    storedCredentials[fieldId] = field.value;
  }

  return {
    auth: ProviderConfigAuthSchema.parse({
      mode: draft.mode,
      method: { ...draft.method },
      credentialRefs,
    }),
    storedCredentials,
  };
}

/**
 * Return whether an auth draft contains at least one stored plaintext field.
 * @param draft - UI authentication selection to inspect.
 * @returns Whether the host-owned encrypted storage bridge is required.
 */
export function authDraftRequiresStorage(draft: ProviderConfigAuthDraft): boolean {
  return draft.mode === 'explicit' && Object.values(draft.fields).some(({ source }) => source === 'stored');
}
