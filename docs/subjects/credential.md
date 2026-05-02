---
title: "credential"
editUrl: false
prev: false
next: false
---

# `credential`

| Field | Value |
|-------|-------|
| Prefix | `credential` |
| Namespace constant | `CredentialNamespace` |
| Subjects constant | `CredentialSubjects` |
| Kind | bus |
| Schema record | `CredentialSchemas` |
| Tier | framework |
| Package | `@makaio/contracts` |
| Defined in | [`packages/contracts/src/credential/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/packages/contracts/src/credential/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `activate` | [`credential.activate`](#credential.activate) | rpc | — |
| `changed` | [`credential.changed`](#credential.changed) | rpc | — |
| `delete` | [`credential.delete`](#credential.delete) | rpc | — |
| `exists` | [`credential.exists`](#credential.exists) | rpc | — |
| `get` | [`credential.get`](#credential.get) | rpc | — |
| `getChannelToken` | [`credential.getChannelToken`](#credential.getChannelToken) | rpc | — |
| `resolve` | [`credential.resolve`](#credential.resolve) | rpc | — |
| `store` | [`credential.store`](#credential.store) | rpc | — |

## Subject Details

### <a id="credential.activate"></a>`credential.activate` (rpc)

Pre-resolution activation hook for credential extensions.

Emitted before `resolveConnectorCredentials()` runs so extensions
(e.g., account-manager) can prepare native credential stores.
Awaited before credential resolution — handler failures are suppressed
(errors cannot block agent start), but completion is guaranteed before
`resolveConnectorCredentials()` runs.

Subject: `credential.activate`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `credentialRefs` | `Record<string, string & $brand<"CredentialRef">>` | yes |
| `definitionId` | `string` | yes |
| `providerConfigId` | `string` | yes |

**Response:**

_Empty object._

### <a id="credential.changed"></a>`credential.changed` (rpc)

Mid-session credential rotation signal.

Emitted when credential state changes during active sessions.
The orchestrator fans this out to affected agents.

Subject: `credential.changed`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `changeSequence` | `number` | yes |
| `credentialRefs` | `Record<string, string & $brand<"CredentialRef">>` | yes |
| `definitionId` | `string` | yes |
| `providerConfigId` | `string` | yes |
| `sessionId` | `string` | yes |

**Response:**

_Empty object._

### <a id="credential.delete"></a>`credential.delete` (rpc)

Delete stored credentials for a provider config.

Subject: `credential.delete`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `configId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `deleted` | `boolean` | yes |

### <a id="credential.exists"></a>`credential.exists` (rpc)

Check whether credentials exist for a provider config.

Subject: `credential.exists`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `configId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `exists` | `boolean` | yes |

### <a id="credential.get"></a>`credential.get` (rpc)

Retrieve stored credentials for a provider config.
Channel-only — carries sensitive credential data.

Subject: `credential.get`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `configId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `credentials` | `Record<string, string> \| null` | yes |

### <a id="credential.getChannelToken"></a>`credential.getChannelToken` (rpc)

Request the credential channel capability token (local-only).

The token grants access to encrypted credential operations. This subject
is local-only to prevent the token from leaking to remote transports.
The runtime distributes this token only to authorized services during
initialization.

Subject: `credential.getChannelToken`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `token` | `string` | yes |

### <a id="credential.resolve"></a>`credential.resolve` (rpc)

Resolve a credential reference to its plaintext value.
Channel-only — the resolved value is sensitive.

Subject: `credential.resolve`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `ref` | `string & $brand<"CredentialRef">` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `value` | `string \| null` | yes |

### <a id="credential.store"></a>`credential.store` (rpc)

Store credentials for a provider config.
Channel-only — carries sensitive credential data.

Subject: `credential.store`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `configId` | `string` | yes |
| `credentials` | `Record<string, string>` | yes |

**Response:**

_Empty object._

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
