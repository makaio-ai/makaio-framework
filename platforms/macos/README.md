# @makaio/platform-macos

macOS-specific OS capability package for the Makaio AI Framework. Provides
Login Item management (auto-launch at user login) via AppleScript and integrates
with the framework's capability bus so any host can query and control the
capability through standard bus subjects.

The package is gated to `darwin` via its `requires: ['darwin']` extension
declaration — on non-macOS hosts it is a no-op even if loaded.

## Capabilities

| Capability | ID | Description |
|------------|----|-------------|
| Auto-launch | `autoLaunch` | Register or remove the app as a macOS Login Item using `System Events` AppleScript |

## Quick Start

The package is included automatically by `bootMakaioRuntime` (from
`@makaio/runtime-node`) when `process.platform === 'darwin'`. For custom
composition roots, load it as an extension package:

```typescript
import { createPlatformMacOSPackage } from '@makaio/platform-macos';
import { ExtensionCoordinator } from '@makaio/kernel';

// Use defaults: auto-launch target resolved from MAKAIO_APP or process.execPath
const macOSPackage = createPlatformMacOSPackage();

// Or supply an explicit app bundle:
const macOSPackage = createPlatformMacOSPackage({
  autoLaunch: {
    appName: 'Makaio',
    appPath: '/Applications/Makaio.app',
  },
});

// Or disable auto-launch registration entirely:
const macOSPackage = createPlatformMacOSPackage({ autoLaunch: false });

coordinator.load([macOSPackage]);
```

The pre-built `platformMacOSPackage` export is equivalent to
`createPlatformMacOSPackage()` with default target resolution.

## Bus Subjects

Auto-launch is controlled via `PlatformSubjects.autoLaunch.*` from
`@makaio/contracts`. Request any of these through the bus:

| Subject | Payload | Response | Description |
|---------|---------|----------|-------------|
| `platform.autoLaunch.enable` | `{ hidden?: boolean }` | `{ enabled: boolean, error?: string }` | Add the app as a Login Item |
| `platform.autoLaunch.disable` | `{}` | `{ disabled: boolean, error?: string }` | Remove the Login Item |
| `platform.autoLaunch.getStatus` | `{}` | `{ enabled: boolean, supported: boolean, error?: string }` | Query current Login Item status |

The `hidden` flag on `enable` controls whether the app starts hidden (tray
only). Defaults to `true`.

## Target Resolution

`resolveMacOSAutoLaunchTarget` resolves the app bundle in this order:

1. `MAKAIO_APP` environment variable — explicit override path
2. `process.execPath` — extracts the containing `.app` bundle from the
   running executable path (e.g. `.../Makaio.app/Contents/MacOS/makaio`)
3. `undefined` — headless `makaio serve` processes do not run from an app
   bundle and therefore do not register the capability

## Exports

| Export | Description |
|--------|-------------|
| `platformMacOSPackage` | Pre-built extension package with default target resolution |
| `createPlatformMacOSPackage` | Factory for a customised platform package |

## Types

| Type | Description |
|------|-------------|
| `PlatformMacOSPackageOptions` | `{ autoLaunch?: { appName, appPath } \| false }` |
