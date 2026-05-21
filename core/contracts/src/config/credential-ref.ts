import { z } from 'zod';

/**
 * Credential reference resolved at runtime by the active credential provider.
 *
 * Supported formats:
 * - `keychain:<service>:<account>` - OS-backed secure store
 * - `env:<VAR_NAME>` - Environment variable
 * - `file:<path>` - File path
 * - `stored:providerConfig:<configId>:<key>` - ConfigId-keyed credential store
 *   (resolved via `CredentialSubjects.get({ configId })`)
 * - `account-manager:["<clientId>","<accountId>"]` - Account-manager managed
 *   account (JSON tuple payload keeps both IDs opaque and delimiter-safe).
 *   Used by the UI to bind a provider config to a specific account-manager
 *   account.
 */
const ENV_REF_PREFIX = 'env:';
const FILE_REF_PREFIX = 'file:';
const KEYCHAIN_REF_PREFIX = 'keychain:';
const STORED_REF_PREFIX = 'stored:providerConfig:';
const ACCOUNT_MANAGER_REF_PREFIX = 'account-manager:';

/**
 * Parse a stored provider-config credential ref without branding the input.
 * @param ref - Raw credential ref string
 * @returns Parsed stored-ref parts, or `null` when the value is not a valid stored ref
 */
function parseStoredCredentialRefParts(ref: string): { configId: string; key: string } | null {
  if (!ref.startsWith(STORED_REF_PREFIX)) {
    return null;
  }

  const tail = ref.slice(STORED_REF_PREFIX.length);
  const colonIndex = tail.lastIndexOf(':');
  if (colonIndex === -1) {
    return null;
  }

  const configId = tail.slice(0, colonIndex);
  const key = tail.slice(colonIndex + 1);
  if (!configId || !key || key.includes(':')) {
    return null;
  }

  return { configId, key };
}

/**
 * Validate refs whose tail is `left:right`, where the right side may contain colons.
 * @param ref - Raw credential ref string
 * @param prefix - Prefix to validate against
 * @returns `true` when the ref has a non-empty value on both sides of the first separator
 */
function isDelimitedCredentialRef(ref: string, prefix: string): boolean {
  if (!ref.startsWith(prefix)) {
    return false;
  }

  const tail = ref.slice(prefix.length);
  const separatorIndex = tail.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex >= tail.length - 1) {
    return false;
  }

  return true;
}

/**
 * Parse an account-manager credential ref without branding the input.
 * @param ref - Raw credential ref string
 * @returns Parsed tuple parts, or `null` when the value is not a valid account-manager ref
 */
function parseAccountManagerCredentialRefParts(ref: string): { clientId: string; accountId: string } | null {
  if (!ref.startsWith(ACCOUNT_MANAGER_REF_PREFIX)) {
    return null;
  }

  try {
    const tuple = JSON.parse(ref.slice(ACCOUNT_MANAGER_REF_PREFIX.length)) as unknown;
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 2 ||
      typeof tuple[0] !== 'string' ||
      typeof tuple[1] !== 'string' ||
      tuple[0].length === 0 ||
      tuple[1].length === 0
    ) {
      return null;
    }
    return { clientId: tuple[0], accountId: tuple[1] };
  } catch {
    return null;
  }
}

/**
 * Check whether a string matches one of the supported credential-ref formats.
 * @param ref - Raw credential ref string
 * @returns `true` when the value is a supported credential ref
 */
function isCredentialRefString(ref: string): boolean {
  if (parseStoredCredentialRefParts(ref)) {
    return true;
  }

  if (ref.startsWith(ENV_REF_PREFIX)) {
    const variableName = ref.slice(ENV_REF_PREFIX.length);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName);
  }

  if (ref.startsWith(FILE_REF_PREFIX)) {
    return ref.length > FILE_REF_PREFIX.length;
  }

  if (isDelimitedCredentialRef(ref, KEYCHAIN_REF_PREFIX)) {
    return true;
  }

  if (parseAccountManagerCredentialRefParts(ref)) {
    return true;
  }

  return false;
}

/**
 * Check whether a credential ref was issued by the account-manager.
 *
 * Account-manager refs bind a provider config to a specific managed account
 * and are not resolvable to a raw credential. Callers that need to derive a
 * source ref from the credential map should use this guard.
 * @param ref - Raw credential ref string
 * @returns `true` when the ref was issued by the account-manager
 */
export function isAccountManagerRef(ref: string): boolean {
  return parseAccountManagerCredentialRefParts(ref) !== null;
}

export const CredentialRefSchema = z
  .string()
  .refine(isCredentialRefString, { message: 'Invalid credential reference format.' })
  .brand<'CredentialRef'>();
export type CredentialRef = z.infer<typeof CredentialRefSchema>;

/**
 * Build a stored credential reference keyed by provider config ID.
 *
 * The format is `stored:providerConfig:<configId>:<key>`. The last colon in the
 * string acts as the configId/key separator, so `configId` may contain colons
 * (e.g. `github:oauth-default`) but `key` must be a colon-free identifier.
 * @param configId - Provider config ID; may contain colons (e.g. `github:oauth-default`)
 * @param key - Credential key — must not contain colons (e.g. `apiKey`, `pat`)
 * @returns Stored credential reference string
 */
export function buildStoredCredentialRef(configId: string, key: string): CredentialRef {
  if (key.includes(':')) {
    throw new Error(`Credential key must not contain colons: "${key}"`);
  }
  return CredentialRefSchema.parse(`${STORED_REF_PREFIX}${configId}:${key}`);
}

/**
 * Build an account-manager credential reference keyed by client/account IDs.
 *
 * The payload is a JSON tuple prefixed by `account-manager:` so both IDs stay
 * opaque and may contain delimiters.
 * @param clientId - Account-manager client identifier
 * @param accountId - Stable account identifier
 * @returns Account-manager credential reference string
 */
export function buildAccountManagerCredentialRef(clientId: string, accountId: string): CredentialRef {
  return CredentialRefSchema.parse(`${ACCOUNT_MANAGER_REF_PREFIX}${JSON.stringify([clientId, accountId])}`);
}

/**
 * Parse a stored credential reference into its parts.
 * @param ref - Credential reference string
 * @returns Parsed parts, or `null` when the ref is not a stored credential ref
 */
export function parseStoredCredentialRef(ref: CredentialRef): { configId: string; key: string } | null {
  return parseStoredCredentialRefParts(ref);
}

/**
 * Brand a plain string record as a credential-ref record.
 *
 * Used by storage handlers to convert persisted JSON values into the branded API type.
 * @param creds - Plain string record from storage
 * @returns Branded credential-ref record, or `undefined` when input is nullish
 */
export function brandCredentialRecord(
  creds: Record<string, string> | null | undefined,
): Record<string, CredentialRef> | undefined {
  if (!creds) {
    return undefined;
  }

  const result: Record<string, CredentialRef> = {};
  for (const [key, value] of Object.entries(creds)) {
    result[key] = CredentialRefSchema.parse(value);
  }

  return result;
}

/**
 * Strip the `CredentialRef` brand from a credential map for use in a
 * `ProviderConfigInput` upsert.
 *
 * `CredentialRef` is a type-level brand only — at runtime the values are
 * plain ref strings (e.g. `stored:providerConfig:xxx:apiKey`). The storage
 * tier stores and re-brands them on read; this helper makes the type system
 * aware of the cast without changing values.
 * @param credentials - Branded credential map from a storage record, or `undefined`.
 * @returns Plain string credential map, or `undefined` when absent.
 */
export function unbrandCredentials(
  credentials: Record<string, CredentialRef> | undefined,
): Record<string, string> | undefined {
  if (!credentials) return undefined;
  return Object.fromEntries(Object.entries(credentials).map(([key, ref]) => [key, ref as string]));
}
