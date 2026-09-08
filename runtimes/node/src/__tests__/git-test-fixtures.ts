import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Create a local repository with selected and later content, independent of host commit defaults.
 * The caller owns the parent directory and its eventual cleanup.
 * @param parent - Fixture-owned temporary directory.
 * @param objectFormat - Git object format used by the fixture.
 * @returns Local repository locator and the earlier commit selected by source tests.
 */
export async function createGitFixture(
  parent: string,
  objectFormat: 'sha1' | 'sha256' = 'sha1',
): Promise<{ repository: string; revision: string }> {
  const repository = join(parent, 'repository');
  await mkdir(repository);
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'gc.auto=0',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: repository, encoding: 'utf8' },
    ).trim();
  git('init', '--quiet', `--object-format=${objectFormat}`);
  await writeFile(join(repository, 'content.txt'), 'selected revision');
  git('add', '.');
  git('commit', '--quiet', '-m', 'first');
  const revision = git('rev-parse', 'HEAD');
  await writeFile(join(repository, 'content.txt'), 'later revision');
  git('add', '.');
  git('commit', '--quiet', '-m', 'second');
  return { repository, revision };
}
