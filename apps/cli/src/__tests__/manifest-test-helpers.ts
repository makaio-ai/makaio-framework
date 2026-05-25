import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Creates a temporary directory simulating a git repository root.
 *
 * The `.git` marker directory is created synchronously so the helper can be
 * used in both sync and async test setup contexts. `findProjectManifestPath`
 * stops its upward walk at a `.git` boundary, so every test repo needs one.
 * @param prefix - Prefix for the temporary directory name.
 * @returns Absolute path to the temp directory containing a `.git` marker.
 */
export async function makeTestRepo(prefix = 'makaio-test-'): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), prefix));
  await mkdir(path.join(repo, '.git'), { recursive: true });
  return repo;
}

/**
 * Writes a project manifest to `<repo>/.makaio/manifest.json`.
 *
 * The file is serialised as pretty-printed JSON with a trailing newline,
 * matching the format produced by `writeProjectManifest` in the utils package.
 * @param repo - Absolute path to the repo root.
 * @param manifest - Manifest content to serialise.
 * @returns Absolute path to the written manifest file.
 */
export async function writeTestManifest(repo: string, manifest: unknown): Promise<string> {
  const manifestPath = path.join(repo, '.makaio', 'manifest.json');
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
  return manifestPath;
}
