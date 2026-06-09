---
title: "packages"
editUrl: false
prev: false
next: false
---

# `packages`

| Field | Value |
|-------|-------|
| Prefix | `packages` |
| Namespace constant | `PackageManagementNamespace` |
| Subjects constant | `PackageSubjects` |
| Kind | bus |
| Schema record | `PackageManagementSchemas` |
| Tier | framework |
| Package | `@makaio/services-package-manager` |
| Defined in | [`services/package-manager/src/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/package-manager/src/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `checkUpdates` | [`packages.checkUpdates`](#packages.checkUpdates) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/package-manager/src/schemas.ts) |
| `getLatestVersion` | [`packages.getLatestVersion`](#packages.getLatestVersion) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/package-manager/src/schemas.ts) |
| `getRegistry` | [`packages.getRegistry`](#packages.getRegistry) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/package-manager/src/schemas.ts) |
| `install` | [`packages.install`](#packages.install) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/package-manager/src/schemas.ts) |
| `installed` | [`packages.installed`](#packages.installed) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/package-manager/src/schemas.ts) |
| `list` | [`packages.list`](#packages.list) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/package-manager/src/schemas.ts) |
| `uninstall` | [`packages.uninstall`](#packages.uninstall) | rpc | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/package-manager/src/schemas.ts) |
| `uninstalled` | [`packages.uninstalled`](#packages.uninstalled) | event | [`schemas.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/package-manager/src/schemas.ts) |

## Subject Details

### <a id="packages.checkUpdates"></a>`packages.checkUpdates` (rpc)

Check for package updates.

Compares installed packages against npm registry to find available updates.

Subject: `packages.checkUpdates`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `updates` | `{ name: string; currentVersion: string; latestVersion: string; description?: string \| undefined; }[]` | yes |

### <a id="packages.getLatestVersion"></a>`packages.getLatestVersion` (rpc)

Get latest version from registry.

Checks npm registry for the latest available version.

Subject: `packages.getLatestVersion`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `packageName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `latestVersion` | `string` | yes |
| `packageName` | `string` | yes |
| `success` | `boolean` | yes |

### <a id="packages.getRegistry"></a>`packages.getRegistry` (rpc)

Get package registry.

Fetches the GitHub-hosted packages.json registry.

Subject: `packages.getRegistry`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `$schema` | `string` | yes |
| `adapters` | `{ name: string; displayName: string; description: string; icon?: string \| undefined; tags?: string[] \| undefined; descriptorName?: string \| undefined; }[]` | yes |
| `extensions` | `{ name: string; displayName: string; description: string; icon?: string \| undefined; tags?: string[] \| undefined; descriptorName?: string \| undefined; }[]` | yes |
| `updatedAt` | `string` | yes |

### <a id="packages.install"></a>`packages.install` (rpc)

Install one or more packages.

Local installs must use a single entry in `packageNames`.
The optional `force` flag bypasses inverse-dependency version checks
when going through the dependency resolver.

Subject: `packages.install`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `force` | `boolean \| undefined` | no |
| `packageName` | `string \| undefined` | no |
| `packageNames` | `string[] \| undefined` | no |
| `source` | `"local" \| "npm" \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `installed` | `{ npmName: string; version: string; source: "new" \| "upgraded" \| "already-present"; }[] \| undefined` | no |
| `packageName` | `string` | yes |
| `restartRequired` | `boolean` | yes |
| `skipped` | `{ npmName: string; reason: string; }[] \| undefined` | no |
| `success` | `boolean` | yes |
| `version` | `string \| undefined` | no |
| `warnings` | `string[] \| undefined` | no |

### <a id="packages.installed"></a>`packages.installed` (event)

Emitted after a package is successfully installed.

Fire-and-forget event — no response expected. Subscribers can use this
for UI refresh, hot-reload triggers, or logging.

Subject: `packages.installed`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `packageName` | `string` | yes |
| `version` | `string` | yes |

### <a id="packages.list"></a>`packages.list` (rpc)

List installed packages.

Returns all installed extension packages.

Subject: `packages.list`
Type: Request (RPC)

**Request:**

_Empty object._

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `packages` | `{ name: string; version: string; hasDescriptor: boolean; description?: string \| undefined; serverImportPath?: string \| undefined; }[]` | yes |

### <a id="packages.uninstall"></a>`packages.uninstall` (rpc)

Uninstall a package.

Removes a package from ~/.makaio/.

Subject: `packages.uninstall`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `packageName` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `packageName` | `string` | yes |
| `restartRequired` | `boolean` | yes |
| `success` | `boolean` | yes |

### <a id="packages.uninstalled"></a>`packages.uninstalled` (event)

Emitted after a package is successfully uninstalled.

Fire-and-forget event — no response expected.

Subject: `packages.uninstalled`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `packageName` | `string` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
