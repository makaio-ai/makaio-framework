import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeCodexNativeAuthSourceLock } from '@makaio/client-codex/runtime';
import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';
import { resolveMutableCredentialSourceDirectory } from './native-credential-mutation.js';

/**
 * Configure one Codex installation for file-backed native credentials.
 * @param codexHome - Lexical CODEX_HOME owned by the credential source.
 */
export async function configureCodexFileCredentialMode(codexHome: string): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  const canonicalHome = await resolveMutableCredentialSourceDirectory(codexHome);
  const configured = await executeCodexNativeAuthSourceLock(canonicalHome, async () => {
    const configPath = join(canonicalHome, 'config.toml');
    const backupPath = `${configPath}.bak`;
    let content = '';
    try {
      content = await readFile(configPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (content) await writeFile(backupPath, content, { mode: 0o600 });
    const config = content ? (parseTOML(content) as Record<string, unknown>) : {};
    config.cli_auth_credentials_store = 'file';
    await writeFile(configPath, stringifyTOML(config), { mode: 0o600 });
  });
  if (configured.coordination === 'uncertain') {
    console.warn('[AccountManager] Codex file-mode configuration committed; source lock is uncertain');
  }
}
