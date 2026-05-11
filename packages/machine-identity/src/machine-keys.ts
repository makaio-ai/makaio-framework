import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getNativeHardwareMachineId, normalizeMachineId } from './native-id.js';

const MACHINE_KEY_LOCK_FILE = '.machine-keys.lock';
const MACHINE_KEY_LOCK_RETRY_MS = 50;
const MACHINE_KEY_LOCK_TIMEOUT_MS = 5000;
const machineIdentityLoads = new Map<string, Promise<PersistedMachineIdentity>>();

interface MachineKeyPaths {
  dir: string;
  ecdhPrivPath: string;
  ecdhPubPath: string;
  signingPrivPath: string;
  signingPubPath: string;
  idPath: string;
}

interface MachineKeyLock {
  file: fs.FileHandle;
  path: string;
}

/**
 * Persisted machine identity with ECDH and ECDSA keypairs.
 * Loaded from or written to `~/.makaio/keys/` on Node.js.
 * Used for E2E encryption and device pairing.
 */
export interface PersistedMachineIdentity {
  /**
   * Stable machine identifier used for key cache validation.
   *
   * Prefers a hardware-derived identifier from OS-native facilities, but may
   * fall back to the cached `machine.id` value when native lookup is unavailable.
   */
  machineId: string;
  /** ECDH keypair for key agreement */
  ecdhKeyPair: CryptoKeyPair;
  /** ECDSA keypair for signing */
  signingKeyPair: CryptoKeyPair;
  /** ECDH public key as base64url */
  publicKey: string;
  /** ECDSA signing public key as base64url */
  signingPublicKey: string;
}

/**
 * Status of machine key files.
 * - 'complete': All required key files exist
 * - 'partial': Some but not all key files exist
 * - 'missing': No key files exist
 */
export type MachineKeyStatus = 'complete' | 'partial' | 'missing';

/**
 * Result of machine key validation.
 */
export interface MachineKeyValidation {
  /** Overall status of machine keys */
  status: MachineKeyStatus;
  /** Files that exist */
  existing: string[];
  /** Files that are missing */
  missing: string[];
}

/**
 * Reads cached machine identifier from disk.
 * @param idPath - Path to `machine.id`
 * @returns Cached machine identifier, or undefined when missing
 */
async function readCachedMachineId(idPath: string): Promise<string | undefined> {
  try {
    const value = normalizeMachineId(await fs.readFile(idPath, 'utf-8'));
    if (!value) {
      console.warn(`[machine-keys] Ignoring malformed cached machine.id at ${idPath}.`);
    }
    return value;
  } catch (error) {
    const reason = error as NodeJS.ErrnoException;
    if (reason.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Resolves the effective machine ID, treating the persisted cache as the
 * stable source of truth after first boot.
 * @param cachedId - Cached machine identifier from disk
 * @returns Effective machine identifier
 */
async function resolveEffectiveMachineId(cachedId: string | undefined): Promise<string> {
  // Once persisted, `machine.id` must stay stable for pairing and E2E identity.
  // Native machine IDs are only used to seed first boot when no cache exists yet.
  if (cachedId !== undefined) {
    return cachedId;
  }

  const nativeId = getNativeHardwareMachineId();
  if (nativeId) {
    return nativeId;
  }

  console.warn('[machine-keys] Falling back to generated machine ID; OS-native machine ID was unavailable.');
  return globalThis.crypto.randomUUID();
}

/**
 * Best-effort permission hardening for sensitive key files.
 * @param filePath - File path to chmod
 * @param mode - Desired POSIX mode
 */
async function enforceFileMode(filePath: string, mode: number): Promise<void> {
  try {
    await fs.chmod(filePath, mode);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (process.platform === 'win32' || errno.code === 'ENOSYS' || errno.code === 'EINVAL') {
      return;
    }
    throw error;
  }
}

/**
 * Resolve the canonical file paths that make up a machine identity on disk.
 * @param keysDir - Directory that holds the machine key files.
 * @returns Resolved key directory and file paths.
 */
function getMachineKeyPaths(keysDir: string): MachineKeyPaths {
  const dir = keysDir;
  return {
    dir,
    ecdhPrivPath: path.join(dir, 'machine.key'),
    ecdhPubPath: path.join(dir, 'machine.pub'),
    signingPrivPath: path.join(dir, 'machine-signing.key'),
    signingPubPath: path.join(dir, 'machine-signing.pub'),
    idPath: path.join(dir, 'machine.id'),
  };
}

/**
 * Sleep for a short interval while waiting for the machine-key lock.
 * @param ms - Delay in milliseconds.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the cross-process machine-key lock for a directory.
 * @param dir - Machine-key directory to lock.
 * @returns Exclusive lock handle and lockfile path.
 */
async function acquireMachineKeyLock(dir: string): Promise<MachineKeyLock> {
  const lockPath = path.join(dir, MACHINE_KEY_LOCK_FILE);
  const deadline = Date.now() + MACHINE_KEY_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      return {
        file: await fs.open(lockPath, 'wx', 0o600),
        path: lockPath,
      };
    } catch (error) {
      const reason = error as NodeJS.ErrnoException;
      if (reason.code !== 'EEXIST') {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`[machine-keys] Timed out waiting for initialization lock in ${dir}`, { cause: error });
      }
      await sleep(MACHINE_KEY_LOCK_RETRY_MS);
    }
  }
}

/**
 * Release the machine-key lock and remove its lockfile.
 * @param lock - Lock handle to release.
 */
async function releaseMachineKeyLock(lock: MachineKeyLock): Promise<void> {
  await lock.file.close();
  await fs.unlink(lock.path).catch(() => undefined);
}

/**
 * Atomically replace a file by writing a temp file in the same directory and renaming it.
 * @param filePath - Final destination path.
 * @param content - File contents to write.
 * @param mode - POSIX mode for the temporary file.
 */
async function writeAtomic(filePath: string, content: string, mode: number): Promise<void> {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.writeFile(tmpPath, content, { mode });
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Load an existing machine identity from disk.
 * @param paths - Resolved machine key file paths.
 * @param machineId - Effective machine identifier for the cached identity.
 * @returns Imported machine identity.
 */
async function loadExistingMachineIdentity(
  paths: MachineKeyPaths,
  machineId: string,
): Promise<PersistedMachineIdentity> {
  const ecdhPrivPem = await fs.readFile(paths.ecdhPrivPath, 'utf-8');
  const ecdhPubPem = await fs.readFile(paths.ecdhPubPath, 'utf-8');
  const signingPrivPem = await fs.readFile(paths.signingPrivPath, 'utf-8');
  const signingPubPem = await fs.readFile(paths.signingPubPath, 'utf-8');

  await checkPermissions(paths.ecdhPrivPath);
  await checkPermissions(paths.signingPrivPath);

  const ecdhKeyPair = {
    privateKey: await importPrivateKey(ecdhPrivPem, 'ECDH'),
    publicKey: await importPublicKey(ecdhPubPem, 'ECDH'),
  };
  const signingKeyPair = {
    privateKey: await importPrivateKey(signingPrivPem, 'ECDSA'),
    publicKey: await importPublicKey(signingPubPem, 'ECDSA'),
  };

  return {
    machineId,
    ecdhKeyPair,
    signingKeyPair,
    publicKey: await exportPublicKeyBase64(ecdhKeyPair.publicKey),
    signingPublicKey: await exportPublicKeyBase64(signingKeyPair.publicKey),
  };
}

/**
 * Generate a new machine identity and persist it to disk.
 * @param paths - Resolved machine key file paths.
 * @param machineId - Effective machine identifier to persist.
 * @param cachedId - Previously cached machine identifier, if any.
 * @returns Generated machine identity.
 */
async function generateMachineIdentity(
  paths: MachineKeyPaths,
  machineId: string,
  cachedId: string | undefined,
): Promise<PersistedMachineIdentity> {
  if (cachedId !== undefined && cachedId !== machineId) {
    console.warn('[machine-keys] Hardware ID changed. Regenerating keypairs.');
  }

  let ecdhKeyPair = await globalThis.crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true,
    ['deriveKey', 'deriveBits'],
  );
  let signingKeyPair = await globalThis.crypto.subtle.generateKey(
    {
      name: 'ECDSA',
      namedCurve: 'P-256',
    },
    true,
    ['sign', 'verify'],
  );

  const ecdhPrivPem = await exportPrivateKey(ecdhKeyPair.privateKey);
  const ecdhPubPem = await exportPublicKey(ecdhKeyPair.publicKey);
  const signingPrivPem = await exportPrivateKey(signingKeyPair.privateKey);
  const signingPubPem = await exportPublicKey(signingKeyPair.publicKey);

  await writeAtomic(paths.ecdhPrivPath, ecdhPrivPem, 0o600);
  await writeAtomic(paths.ecdhPubPath, ecdhPubPem, 0o644);
  await writeAtomic(paths.signingPrivPath, signingPrivPem, 0o600);
  await writeAtomic(paths.signingPubPath, signingPubPem, 0o644);
  await writeAtomic(paths.idPath, machineId, 0o644);
  await enforceFileMode(paths.ecdhPrivPath, 0o600);
  await enforceFileMode(paths.signingPrivPath, 0o600);

  // Persisted private keys only need to be extractable long enough to be
  // written once. Re-importing them hardens the in-memory identity against
  // accidental re-export while keeping the same on-disk key material.
  ecdhKeyPair = { privateKey: await importPrivateKey(ecdhPrivPem, 'ECDH'), publicKey: ecdhKeyPair.publicKey };
  signingKeyPair = {
    privateKey: await importPrivateKey(signingPrivPem, 'ECDSA'),
    publicKey: signingKeyPair.publicKey,
  };

  return {
    machineId,
    ecdhKeyPair,
    signingKeyPair,
    publicKey: await exportPublicKeyBase64(ecdhKeyPair.publicKey),
    signingPublicKey: await exportPublicKeyBase64(signingKeyPair.publicKey),
  };
}

/**
 * Load or generate machine identity.
 *
 * Seeds `machine.id` from OS-native facilities on first boot when available.
 * After that, the persisted `machine.id` becomes the stable source of truth so
 * pairing and E2E identities do not rotate if the native ID later changes or
 * becomes newly available.
 *
 * On first run:
 * - Creates the keys directory if it does not exist
 * - Generates ECDH P-256 keypair → machine.key (PKCS8 PEM) + machine.pub (SPKI PEM)
 * - Generates ECDSA P-256 keypair → machine-signing.key + machine-signing.pub
 * - Writes resolved machine ID → machine.id
 * - Sets file permissions to 0o600 (private key files)
 *
 * On subsequent runs:
 * - Loads existing keys from PEM files
 * - Warns if file permissions are too open
 * @param keysDir - Directory for machine keys (e.g. `~/.makaio/keys`)
 * @returns PersistedMachineIdentity with loaded/generated keys
 */
export async function loadOrCreateMachineIdentity(keysDir: string): Promise<PersistedMachineIdentity> {
  const paths = getMachineKeyPaths(keysDir);
  const { dir, idPath } = paths;
  const inFlight = machineIdentityLoads.get(dir);
  if (inFlight) {
    return inFlight;
  }

  // Node runtime owns machine-identity initialization inside one process. A
  // per-directory single-flight keeps key generation and file writes atomic at
  // that seam without introducing a broader cross-process locking subsystem.
  const loadPromise = (async (): Promise<PersistedMachineIdentity> => {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const lock = await acquireMachineKeyLock(dir);

    try {
      const cachedId = await readCachedMachineId(idPath);
      const validation = await validateMachineKeys(keysDir);
      if (validation.status === 'complete' && cachedId === undefined) {
        throw new Error(
          `[machine-keys] Missing or malformed machine.id in ${dir} with complete key material present. ` +
            'Refusing to regenerate keys automatically to avoid identity rotation.',
        );
      }
      const hardwareId = await resolveEffectiveMachineId(cachedId);

      if (validation.status === 'partial') {
        const missingFiles = validation.missing.map((file) => path.basename(file)).join(', ');
        // Partial key state is treated as a hard failure so we never rotate
        // machine identity over possibly recoverable key material.
        throw new Error(
          `[machine-keys] Incomplete machine key set in ${dir}. Missing files: ${missingFiles}. ` +
            'Refusing to regenerate keys automatically because that would replace existing machine identity.',
        );
      }

      const keysExist = validation.status === 'complete';
      const cacheValid = keysExist && cachedId === hardwareId;
      return cacheValid
        ? await loadExistingMachineIdentity(paths, hardwareId)
        : await generateMachineIdentity(paths, hardwareId, cachedId);
    } finally {
      await releaseMachineKeyLock(lock);
    }
  })();

  machineIdentityLoads.set(dir, loadPromise);
  try {
    return await loadPromise;
  } finally {
    if (machineIdentityLoads.get(dir) === loadPromise) {
      machineIdentityLoads.delete(dir);
    }
  }
}

/**
 * Validate machine key files and return detailed status.
 *
 * Checks existence of all required key files and categorizes the state:
 * - 'complete': All 5 files exist (safe to load)
 * - 'partial': Some files exist, some missing (inconsistent state)
 * - 'missing': No files exist (safe to generate new keys)
 * @param keysDir - Directory for machine keys (e.g. `~/.makaio/keys`)
 * @returns Validation result with status and file details
 */
export async function validateMachineKeys(keysDir: string): Promise<MachineKeyValidation> {
  const { idPath, ecdhPrivPath, ecdhPubPath, signingPrivPath, signingPubPath } = getMachineKeyPaths(keysDir);
  const requiredFiles = [idPath, ecdhPrivPath, ecdhPubPath, signingPrivPath, signingPubPath];

  const checks = await Promise.allSettled(requiredFiles.map((file) => fs.access(file).then(() => file)));

  const existing: string[] = [];
  const missing: string[] = [];

  for (const [index, result] of checks.entries()) {
    if (result.status === 'fulfilled') {
      existing.push(requiredFiles[index]);
    } else {
      const reason = result.reason as NodeJS.ErrnoException;
      if (reason?.code === 'ENOENT') {
        missing.push(requiredFiles[index]);
      } else {
        // Permission or IO errors should surface, not be treated as "missing"
        throw reason;
      }
    }
  }

  const status: MachineKeyStatus =
    existing.length === requiredFiles.length ? 'complete' : existing.length === 0 ? 'missing' : 'partial';

  return { status, existing, missing };
}

/**
 * Check if machine keys exist.
 *
 * Returns true only if ALL required key files exist. If some files are missing,
 * returns false and logs a warning about partial state.
 * @param keysDir - Directory for machine keys (e.g. `~/.makaio/keys`)
 * @returns true if all required key files exist
 */
export async function machineKeysExist(keysDir: string): Promise<boolean> {
  const validation = await validateMachineKeys(keysDir);

  if (validation.status === 'partial') {
    console.warn(
      `Warning: Machine keys in partial state. Missing files:\n${validation.missing.map((f) => `  - ${path.basename(f)}`).join('\n')}`,
    );
  }

  return validation.status === 'complete';
}

/**
 * Check file permissions and warn if too open.
 * @param filePath - Path to file to check
 */
async function checkPermissions(filePath: string): Promise<void> {
  const stats = await fs.stat(filePath);
  const mode = stats.mode & 0o777;
  // Check group/other bits and owner-execute — numeric comparison fails
  // because e.g. 0o077 < 0o600 yet is more permissive than 0o600.
  const tooOpen = (mode & 0o077) !== 0 || (mode & 0o100) !== 0;
  if (tooOpen) {
    console.warn(`Warning: ${filePath} has permissive file mode ${mode.toString(8)}. Should be 0o600.`);
  }
}

/**
 * Wrap exported key bytes in PEM armour.
 * @param label - PEM block label to emit.
 * @param exported - Raw exported key bytes.
 * @returns PEM-encoded key string.
 */
function formatPem(label: 'PRIVATE KEY' | 'PUBLIC KEY', exported: ArrayBuffer): string {
  const base64 = Buffer.from(exported).toString('base64');
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * Parse PEM armour into raw key bytes.
 * @param pem - PEM-encoded key contents.
 * @param label - Expected PEM block label.
 * @returns Key bytes as a Uint8Array for WebCrypto import.
 */
function parsePem(pem: string, label: 'PRIVATE KEY' | 'PUBLIC KEY'): Uint8Array<ArrayBuffer> {
  const pemContents = pem
    .replace(`-----BEGIN ${label}-----`, '')
    .replace(`-----END ${label}-----`, '')
    .replace(/\s/g, '');
  const bytes = Buffer.from(pemContents, 'base64');
  return new Uint8Array(bytes);
}

/**
 * Export private key to PKCS8 PEM format.
 * @param key - CryptoKey to export
 * @returns PEM-encoded private key
 */
async function exportPrivateKey(key: CryptoKey): Promise<string> {
  const exported = await globalThis.crypto.subtle.exportKey('pkcs8', key);
  return formatPem('PRIVATE KEY', exported);
}

/**
 * Export public key to SPKI PEM format.
 * @param key - CryptoKey to export
 * @returns PEM-encoded public key
 */
async function exportPublicKey(key: CryptoKey): Promise<string> {
  const exported = await globalThis.crypto.subtle.exportKey('spki', key);
  return formatPem('PUBLIC KEY', exported);
}

/**
 * Export public key as base64url-encoded raw bytes.
 * @param key - CryptoKey to export
 * @returns Base64url-encoded public key
 */
async function exportPublicKeyBase64(key: CryptoKey): Promise<string> {
  const exported = await globalThis.crypto.subtle.exportKey('raw', key);
  return Buffer.from(exported).toString('base64url');
}

/**
 * Import private key from PKCS8 PEM format.
 * @param pem - PEM-encoded private key
 * @param algorithm - Key algorithm (ECDH or ECDSA)
 * @returns Imported CryptoKey
 */
async function importPrivateKey(pem: string, algorithm: 'ECDH' | 'ECDSA'): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'pkcs8',
    parsePem(pem, 'PRIVATE KEY'),
    {
      name: algorithm,
      namedCurve: 'P-256',
    },
    false,
    algorithm === 'ECDH' ? ['deriveKey', 'deriveBits'] : ['sign'],
  );
}

/**
 * Import public key from SPKI PEM format.
 * @param pem - PEM-encoded public key
 * @param algorithm - Key algorithm (ECDH or ECDSA)
 * @returns Imported CryptoKey
 */
async function importPublicKey(pem: string, algorithm: 'ECDH' | 'ECDSA'): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    'spki',
    parsePem(pem, 'PUBLIC KEY'),
    {
      name: algorithm,
      namedCurve: 'P-256',
    },
    true,
    algorithm === 'ECDH' ? [] : ['verify'],
  );
}
