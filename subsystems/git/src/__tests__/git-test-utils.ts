/**
 * Shared test utilities for git-service tests.
 *
 * Provides helpers to create temporary git repositories with consistent
 * configuration, including disabling commit signing to ensure tests work
 * in any environment (CI, local, signing-enforced hosts).
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';

/**
 * A temporary git repository created for testing.
 * @remarks
 * The repo is configured with a test user and commit signing disabled.
 * Call {@link cleanup} when done to remove the temp directory.
 */
export interface TestRepo {
  /** Absolute, resolved path to the repo root */
  repoPath: string;
  /** Pre-configured simple-git instance */
  git: SimpleGit;
  /** Remove the temp directory */
  cleanup: () => Promise<void>;
}

/**
 * A test repository with two commits and captured commit hashes.
 */
export interface TestRepoWithTwoCommits extends TestRepo {
  /** Hash for the initial commit. */
  firstCommitHash: string;
  /** Hash for the second commit. */
  secondCommitHash: string;
}

/**
 * Configure a git repository for testing.
 *
 * Writes user identity and disables commit signing directly to the repo's
 * `.git/config` file, avoiding subprocess calls to `git config`.
 * @param repoPath - Absolute path to the repository root
 * @param name - Author name (default: 'Test User')
 * @param email - Author email (default: 'test\@test.local')
 */
export async function configureTestGit(repoPath: string, name = 'Test User', email = 'test@test.local'): Promise<void> {
  const configPath = path.join(repoPath, '.git', 'config');
  await fs.appendFile(configPath, `[user]\n\tname = ${name}\n\temail = ${email}\n[commit]\n\tgpgsign = false\n`);
}

/**
 * Create a temporary git repository.
 *
 * The repo is initialized and configured but has no commits.
 * @param prefix - Temp directory prefix (default: 'git-test-')
 * @returns A {@link TestRepo} with an empty, initialized repository
 */
export async function createTestRepo(prefix = 'git-test-'): Promise<TestRepo> {
  const repoPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const git = simpleGit(repoPath);
  await git.init(['--initial-branch=main']);
  await configureTestGit(repoPath);

  return {
    repoPath,
    git,
    cleanup: () => fs.rm(repoPath, { recursive: true, force: true }),
  };
}

/**
 * Create a temporary git repository with an initial commit.
 *
 * Creates a repo with a single `base.txt` file committed as "initial".
 * @param prefix - Temp directory prefix (default: 'git-test-')
 * @returns A {@link TestRepo} with one commit
 */
export async function createTestRepoWithCommit(prefix = 'git-test-'): Promise<TestRepo> {
  const repo = await createTestRepo(prefix);
  await fs.writeFile(path.join(repo.repoPath, 'base.txt'), 'base\n');
  await repo.git.add('base.txt');
  await repo.git.commit('initial');
  return repo;
}

/**
 * Create a temporary git repository with two commits and return both hashes.
 *
 * First commit writes `base.txt`. Second commit writes/updates `secondFilePath`.
 * @param secondFilePath - File path changed in the second commit
 * @param secondFileContent - Content written in the second commit
 * @param secondCommitMessage - Commit message for the second commit
 * @param prefix - Temp directory prefix
 * @returns Repository fixture with first/second commit hashes
 */
export async function createRepoWithTwoCommits(
  secondFilePath = 'second.txt',
  secondFileContent = 'second\n',
  secondCommitMessage = 'second',
  prefix = 'git-test-',
): Promise<TestRepoWithTwoCommits> {
  const repo = await createTestRepoWithCommit(prefix);
  const firstCommitHash = (await repo.git.log({ maxCount: 1 })).latest!.hash;

  await fs.writeFile(path.join(repo.repoPath, secondFilePath), secondFileContent);
  await repo.git.add(secondFilePath);
  await repo.git.commit(secondCommitMessage);
  const secondCommitHash = (await repo.git.log({ maxCount: 1 })).latest!.hash;

  return {
    ...repo,
    firstCommitHash,
    secondCommitHash,
  };
}
