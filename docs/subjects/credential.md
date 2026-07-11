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
| Defined in | [`core/contracts/src/credential/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/core/contracts/src/credential/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `activate` | [`credential.activate`](#credential.activate) | rpc | — |
| `activation.commit` | [`credential.activation.commit`](#credential.activation.commit) | rpc | — |
| `activation.prepare` | [`credential.activation.prepare`](#credential.activation.prepare) | rpc | — |
| `activation.rollback` | [`credential.activation.rollback`](#credential.activation.rollback) | rpc | — |
| `changed` | [`credential.changed`](#credential.changed) | rpc | — |
| `delete` | [`credential.delete`](#credential.delete) | rpc | — |
| `exists` | [`credential.exists`](#credential.exists) | rpc | — |
| `get` | [`credential.get`](#credential.get) | rpc | — |
| `getChannelToken` | [`credential.getChannelToken`](#credential.getChannelToken) | rpc | — |
| `resolve` | [`credential.resolve`](#credential.resolve) | rpc | — |
| `store` | [`credential.store`](#credential.store) | rpc | — |
| `storeGrant.create` | [`credential.storeGrant.create`](#credential.storeGrant.create) | rpc | — |

## Subject Details

### <a id="credential.activate"></a>`credential.activate` (rpc)

Pre-resolution activation hook for credential extensions.

Emitted before `resolveConnectorCredentials()` runs so extensions
(e.g., account-manager) can prepare native credential stores.
Awaited before credential resolution. A selected account is mandatory:
unavailable managers and failed activation block agent startup.

Subject: `credential.activate`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `providerContext` | `{ state: "resolved"; providerConfigId: string; definitionId: string; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; description?: string \| undefined; }; credentialRefs: Record<string, string>; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "inferred"; label: string; description?: string \| undefined; }; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "none"; label: string; description?: string \| undefined; }; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; capabilities?: Record<string, unknown> \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="credential.activation.commit"></a>`credential.activation.commit` (rpc)

Commit one prepared account activation exactly once.

Subject: `credential.activation.commit`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `transactionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="credential.activation.prepare"></a>`credential.activation.prepare` (rpc)

Prepare a reversible managed-account activation for an atomic connector swap.

Local-only because the opaque transaction is owned by the in-process
account manager and holds its per-client mutation lock until commit or
rollback consumes the identifier.

Subject: `credential.activation.prepare`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `providerContext` | `{ state: "resolved"; providerConfigId: string; definitionId: string; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; description?: string \| undefined; }; credentialRefs: Record<string, string>; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "inferred"; label: string; description?: string \| undefined; }; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "none"; label: string; description?: string \| undefined; }; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; capabilities?: Record<string, unknown> \| undefined; }` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="credential.activation.rollback"></a>`credential.activation.rollback` (rpc)

Roll back one prepared account activation exactly once.

Subject: `credential.activation.rollback`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `transactionId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

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
| `providerContext` | `{ state: "resolved"; providerConfigId: string; definitionId: string; auth: { mode: "explicit"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "explicit"; label: string; fields: { id: string; label: string; required: boolean; secret: boolean; sourceHints: { kind: "environment"; variable: string; }[]; description?: string \| undefined; }[]; description?: string \| undefined; }; credentialRefs: Record<string, string>; } \| { mode: "inferred"; method: { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "inferred"; label: string; description?: string \| undefined; }; account?: { managerId: string; accountId: string; } \| undefined; } \| { mode: "none"; method: { owner: "provider"; providerDefinitionId: string; methodId: string; } \| { owner: "client"; clientId: string; methodId: string; }; definition: { id: string; mode: "none"; label: string; description?: string \| undefined; }; }; endpointOverrides?: { anthropic?: string \| undefined; openai?: string \| undefined; } \| undefined; capabilities?: Record<string, unknown> \| undefined; }` | yes |
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
| `ref` | `string` | yes |

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

### <a id="credential.storeGrant.create"></a>`credential.storeGrant.create` (rpc)

Request a one-shot, config-bound channel that exposes only `store`.

This normal transported subject deliberately contains only a config ID and
capability metadata. Credential plaintext must be sent through the returned
DirectChannel. The host issues grants only for disabled reservations and
rechecks that state immediately before storage.

Subject: `credential.storeGrant.create`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `configId` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `endpoint` | `string` | yes |
| `token` | `string` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
