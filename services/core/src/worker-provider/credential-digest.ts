import { createHash, timingSafeEqual } from 'node:crypto';

const bootstrapPurpose = 'worker-bootstrap-v1';
const runtimePurpose = 'worker-runtime-v1';
const emptyDigest = Buffer.alloc(32);
const digestEncoding = /^(worker-bootstrap-v1|worker-runtime-v1):([a-f0-9]{64})$/;

type CredentialPurpose = typeof bootstrapPurpose | typeof runtimePurpose;

/** A purpose-tagged SHA-256 digest of a high-entropy worker credential. */
export type WorkerCredentialDigest = `${CredentialPurpose}:${string}`;

/**
 * Domain-separate the credential before hashing and tag the stored digest.
 * @param purpose - Versioned credential purpose.
 * @param value - High-entropy credential.
 * @returns Canonical digest for the owner row.
 */
function digest(purpose: CredentialPurpose, value: string): WorkerCredentialDigest {
  const hash = createHash('sha256').update(purpose).update('\0').update(value).digest('hex');
  return `${purpose}:${hash}`;
}

/**
 * Compute the digest the issuer must persist when booking a new run.
 * @param token - High-entropy bootstrap token, kept in volatile storage only.
 * @returns The purpose-tagged bootstrap digest.
 */
export function digestWorkerBootstrapToken(token: string): WorkerCredentialDigest {
  return digest(bootstrapPurpose, token);
}

/**
 * Compute the digest for authentication by the redeemed run identity.
 * @param secret - High-entropy runtime secret, kept in the runtime's memory.
 * @returns The purpose-tagged runtime digest.
 */
export function digestWorkerRuntimeSecret(secret: string): WorkerCredentialDigest {
  return digest(runtimePurpose, secret);
}

/**
 * Compare fixed-width digests, including a dummy comparison for absent or malformed rows.
 * @param stored - Credential digest loaded from the owner row.
 * @param presented - Canonical digest computed from the presentation.
 * @returns Whether both the purpose and the digest match.
 */
export function matchesWorkerCredential(stored: string | undefined, presented: WorkerCredentialDigest): boolean {
  const [, purpose, hex] = digestEncoding.exec(stored ?? '') ?? [];
  const separator = presented.indexOf(':');
  const equal = timingSafeEqual(
    hex === undefined ? emptyDigest : Buffer.from(hex, 'hex'),
    Buffer.from(presented.slice(separator + 1), 'hex'),
  );
  return equal && purpose === presented.slice(0, separator);
}
