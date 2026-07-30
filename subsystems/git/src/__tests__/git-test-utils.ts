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
 * Lazily initialized template repositories, cloned per test via `fs.cp`.
 *
 * Test repositories are created hundreds of times per run; spawning
 * `git init` + configuration + commit subprocesses for each one dominates the
 * git lane's wall clock because process spawning serializes at the OS level.
 * Copying a fully prepared template costs no subprocess at all.
 */
const templatePromises = new Map<string, Promise<string>>();

/**
 * Build (once per process) a template repository for a given shape.
 * @param key - Cache key identifying the template shape.
 * @param build - Populates the template repository at the given path.
 * @returns Absolute path to the template repository.
 */
function getTemplateRepo(key: string, build: (repoPath: string) => Promise<void>): Promise<string> {
  let template = templatePromises.get(key);
  if (!template) {
    template = (async () => {
      const repoPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `git-test-template-${key}-`)));
      await build(repoPath);
      return repoPath;
    })();
    templatePromises.set(key, template);
  }
  return template;
}

/**
 * Materialize a fresh repository from a template.
 * @param key - Template cache key.
 * @param build - Template builder used on first materialization.
 * @param prefix - Temp directory prefix for the per-test copy.
 * @returns A {@link TestRepo} backed by a private copy of the template.
 */
async function cloneTemplateRepo(
  key: string,
  build: (repoPath: string) => Promise<void>,
  prefix: string,
): Promise<TestRepo> {
  const template = await getTemplateRepo(key, build);
  const repoPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  await fs.cp(template, repoPath, { recursive: true });
  return {
    repoPath,
    git: simpleGit(repoPath),
    cleanup: () => fs.rm(repoPath, { recursive: true, force: true }),
  };
}

/**
 * Create a temporary git repository.
 *
 * The repo is initialized and configured but has no commits.
 * @param prefix - Temp directory prefix (default: 'git-test-')
 * @returns A {@link TestRepo} with an empty, initialized repository
 */
export function createTestRepo(prefix = 'git-test-'): Promise<TestRepo> {
  return cloneTemplateRepo(
    'empty',
    async (repoPath) => {
      await simpleGit(repoPath).init(['--initial-branch=main']);
      await configureTestGit(repoPath);
    },
    prefix,
  );
}

/**
 * Create a temporary git repository with an initial commit.
 *
 * Creates a repo with a single `base.txt` file committed as "initial".
 * @param prefix - Temp directory prefix (default: 'git-test-')
 * @returns A {@link TestRepo} with one commit
 */
export function createTestRepoWithCommit(prefix = 'git-test-'): Promise<TestRepo> {
  return cloneTemplateRepo(
    'one-commit',
    async (repoPath) => {
      const git = simpleGit(repoPath);
      await git.init(['--initial-branch=main']);
      await configureTestGit(repoPath);
      await fs.writeFile(path.join(repoPath, 'base.txt'), 'base\n');
      await git.add('base.txt');
      await git.commit('initial');
    },
    prefix,
  );
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
