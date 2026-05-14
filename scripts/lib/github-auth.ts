import { execSync } from 'node:child_process';

/**
 * Resolves a GitHub auth token from environment variables or the `gh` CLI.
 *
 * Checks `GH_TOKEN` and `GITHUB_TOKEN` first, then falls back to `gh auth token`.
 * @param env - Environment object to read from (defaults to `process.env`).
 * @returns Auth token string.
 */
export function resolveGithubToken(env: NodeJS.ProcessEnv = process.env): string {
  const envToken = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (envToken) return envToken;
  try {
    return execSync('gh auth token', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('No GitHub token found. Set GH_TOKEN / GITHUB_TOKEN or run `gh auth login`.');
  }
}
