import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Relative path used by the bundled Node bridge backend at runtime. */
export const nodePtyBridgeRelativePath = 'bridge/pty-bridge.cjs';

/**
 * Copy the CommonJS Node PTY bridge beside the bundled runtime output.
 *
 * The bridge is launched as a separate Node process and therefore cannot be
 * inlined into the runtime bundle. The bundled backend resolves it relative
 * to its own file in `dist/`.
 * @param bridgeSource - Absolute source bridge file.
 * @param distDir - Absolute runtime distribution directory.
 */
export function copyNodePtyBridgeAsset(bridgeSource: string, distDir: string): void {
  const destination = join(distDir, nodePtyBridgeRelativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(bridgeSource, destination);
}
