# @makaio/machine-identity

Provides a stable, cryptographically-grounded machine identity for Node.js
hosts. On first boot it reads a hardware machine ID from OS-native facilities,
generates two P-256 keypairs (ECDH for key agreement, ECDSA for signing), and
persists everything to `~/.makaio/keys/`. On subsequent boots it loads the
existing keys; the persisted `machine.id` becomes the stable source of truth so
pairing and E2E identities do not rotate even if the underlying hardware ID
later changes.

## Usage

```typescript
import { loadOrCreateMachineIdentity } from '@makaio/machine-identity';
import * as path from 'node:path';

const keysDir = path.join(process.env['HOME'] ?? '', '.makaio', 'keys');
const identity = await loadOrCreateMachineIdentity(keysDir);

console.log(identity.machineId);        // e.g. '3f4a9e1b...' (32-char hex)
console.log(identity.publicKey);        // base64url ECDH public key
console.log(identity.signingPublicKey); // base64url ECDSA public key
// identity.ecdhKeyPair and identity.signingKeyPair are WebCrypto CryptoKeyPair
```

### Validate key files without loading them

```typescript
import { validateMachineKeys, machineKeysExist } from '@makaio/machine-identity';

const validation = await validateMachineKeys(keysDir);
// { status: 'complete' | 'partial' | 'missing', existing: string[], missing: string[] }

const ok = await machineKeysExist(keysDir);
```

## Files written to disk

| File | Mode | Contents |
|------|------|---------|
| `machine.id` | `0o644` | Normalized lowercase hardware/UUID identifier |
| `machine.key` | `0o600` | ECDH P-256 private key (PKCS8 PEM) |
| `machine.pub` | `0o644` | ECDH P-256 public key (SPKI PEM) |
| `machine-signing.key` | `0o600` | ECDSA P-256 private key (PKCS8 PEM) |
| `machine-signing.pub` | `0o644` | ECDSA P-256 public key (SPKI PEM) |

## Hardware ID sources

| Platform | Source |
|----------|--------|
| macOS | `ioreg -rd1 -c IOPlatformExpertDevice` → `IOPlatformUUID` |
| Linux | `/etc/machine-id` or `/var/lib/dbus/machine-id` |
| Windows | `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` |
| Other / failure | Falls back to `crypto.randomUUID()` on first boot |

## API Overview

| Export | Description |
|--------|-------------|
| `loadOrCreateMachineIdentity(keysDir)` | Load existing keys or generate new ones; single-flight per directory |
| `validateMachineKeys(keysDir)` | Return `MachineKeyValidation` without loading keys |
| `machineKeysExist(keysDir)` | `true` only when all five files are present |
| `type PersistedMachineIdentity` | `machineId`, `ecdhKeyPair`, `signingKeyPair`, `publicKey`, `signingPublicKey` |
| `type MachineKeyStatus` | `'complete'` \| `'partial'` \| `'missing'` |
| `type MachineKeyValidation` | `status`, `existing`, `missing` |

## Installation

`@makaio/machine-identity` is a private workspace package:

```json
{ "@makaio/machine-identity": "workspace:*" }
```
