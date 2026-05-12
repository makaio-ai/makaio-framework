# @makaio/services-package-manager

Bus-connected service for installing, uninstalling, and querying extension
packages in the Makaio framework. Uses Yarn Plug'n'Play under the hood and
supports installing from npm or from a local filesystem path.

## Usage

### Register the extension package

```typescript
import { createPackageManagerPackage } from '@makaio/services-package-manager/package';

coordinator.load([
  createPackageManagerPackage({
    bus,
    makaioHome: path.join(os.homedir(), '.makaio'),
  }),
]);
```

### Call package management RPCs over the bus

```typescript
import { PackageSubjects } from '@makaio/services-package-manager';
import { MakaioBus } from '@makaio/bus-core';

// Install from npm
const result = await MakaioBus.request(PackageSubjects.install, {
  packageName: '@acme/weather-tools',
  source: 'npm',
});

// Install from local path
await MakaioBus.request(PackageSubjects.install, {
  packageName: '/path/to/my-extension',
  source: 'local',
});

// List installed packages
const { packages } = await MakaioBus.request(PackageSubjects.list, {});

// Check for updates
const { updates } = await MakaioBus.request(PackageSubjects.checkUpdates, {});

// Subscribe to lifecycle events
MakaioBus.on(PackageSubjects.installed, ({ payload }) => {
  console.log(`Installed ${payload.packageName}@${payload.version}`);
});
```

## API Overview

| Export | Description |
|--------|-------------|
| `PackageManagerService` | Service class — registers bus handlers and delegates to `YarnPackageManager` / `LocalPathInstaller` |
| `createPackageManagerPackage()` | Factory for the `MakaioExtension` manifest |
| `PackageManagementNamespace` / `PackageSubjects` | Bus namespace and typed subjects |
| `YarnPackageManager` | Yarn PnP integration — install, uninstall, list, version check |
| `LocalPathInstaller` | Install extensions from a local directory path |
| `parseInstallSource()` | Parse a raw string into an `InstallSource` discriminated union |
| `PackageInstallResultSchema` / `PackageUninstallResultSchema` | Zod schemas for operation results |
| `PackageInfoSchema` | Installed package info (name, version, description, hasDescriptor) |
| `RegistryPackageSchema` / `PackageRegistrySchema` | GitHub-hosted registry format |
| `PackageUpdateInfoSchema` / `PackageVersionInfoSchema` | Update check schemas |
| `type PackageManagerClient` | Seam for the underlying package manager implementation |
| `type PackageRegistryClient` | Seam for fetching the remote package registry |
| `type LocalInstallClient` | Seam for local-path installation |
| `type InstallSource` | `'npm' \| 'local'` discriminated union |
| `type LocalExtensionEntry` | Local extension path descriptor |

## Bus Subjects

| Subject | Type | Description |
|---------|------|-------------|
| `packages.list` | RPC | List all installed packages |
| `packages.install` | RPC | Install a package by name or local path |
| `packages.uninstall` | RPC | Remove an installed package |
| `packages.getLatestVersion` | RPC | Fetch latest npm version for a package |
| `packages.getRegistry` | RPC | Fetch the GitHub-hosted package registry |
| `packages.checkUpdates` | RPC | Compare installed versions against npm |
| `packages.installed` | Event | Fired after successful installation |
| `packages.uninstalled` | Event | Fired after successful uninstallation |

## Installation

`@makaio/services-package-manager` is a private workspace package:

```json
{ "@makaio/services-package-manager": "workspace:*" }
```
