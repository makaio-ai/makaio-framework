import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARED_RENDERER_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * Absolute filesystem root for the shared renderer assets.
 */
export const sharedRendererRoot = SHARED_RENDERER_ROOT;

/**
 * Resolve a shared renderer asset path owned by host-shared.
 * @param relativePath - File path relative to the shared renderer directory.
 * @returns Absolute filesystem path for Vite aliases and tests.
 */
export function resolveSharedRendererAssetPath(relativePath: string): string {
  return path.resolve(SHARED_RENDERER_ROOT, relativePath);
}

/**
 * Shared renderer alias targets consumed by host Vite configs.
 */
export const sharedRendererAliases = {
  './main.scss': resolveSharedRendererAssetPath('main.scss'),
  'drizzle-orm/libsql': resolveSharedRendererAssetPath('server-stub.ts'),
  '@libsql/client': resolveSharedRendererAssetPath('server-stub.ts'),
  libsql: resolveSharedRendererAssetPath('server-stub.ts'),
  'cpu-features': resolveSharedRendererAssetPath('cpu-features-stub.ts'),
  ssh2: resolveSharedRendererAssetPath('ssh2-stub.ts'),
  os: resolveSharedRendererAssetPath('os-stub.ts'),
  'node:os': resolveSharedRendererAssetPath('os-stub.ts'),
} as const;

/**
 * Browser renderer packages that must be resolved as singletons by host Vite configs.
 */
export const sharedRendererDedupe = ['react', 'react-dom'] as const;
