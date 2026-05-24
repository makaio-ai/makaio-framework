/**
 * Integration tests for native Git hook wrapper behavior.
 *
 * These tests install real wrappers into a temporary git repository and
 * exercise actual wrapper scripts to verify:
 *   1. The original hook's exit code is preserved by the wrapper (fail-open
 *      for the receiver does not suppress the original hook's failure).
 *   2. Stdin (e.g. the post-rewrite rewrite map) is forwarded to the receiver.
 *
 * A lightweight shell script stands in for the Makaio receiver binary so that
 * tests remain self-contained and do not require a live bus connection.
 *
 * Note on post-commit semantics: git itself ignores post-commit exit codes
 * (the hook is informational). Exit-code preservation is therefore verified by
 * invoking the installed wrapper script directly rather than through
 * `git commit`, which accurately reflects the wrapper contract: it always
 * propagates the original hook's code to its caller.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installGitHooks } from '../install/install.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * Create a temporary git repository with a configured identity.
 *
 * Uses `fs.realpath` to resolve macOS `/var/folders` → `/private/var/folders`
 * so that paths embedded in wrapper scripts match the directory used at
 * runtime.
 * @param prefix - Prefix for the temporary directory name.
 * @returns Absolute path to the repository root (real path).
 */
async function makeRepo(prefix: string): Promise<string> {
  const { execa } = await import('execa');
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(repo);
  const realRepo = await fs.realpath(repo);
  await execa('git', ['init'], { cwd: realRepo });
  await execa('git', ['config', 'user.email', 'test@example.com'], {
    cwd: realRepo,
  });
  await execa('git', ['config', 'user.name', 'Test User'], { cwd: realRepo });
  return realRepo;
}

describe('git-hooks integration', { timeout: 60_000 }, () => {
  it('preserves original hook exit code and still invokes receiver fail-open', async () => {
    const { execa } = await import('execa');
    const repo = await makeRepo('makaio-git-hooks-integration-');

    // Receiver script: logs its argv to a file so we can verify it was called.
    // Writing to a file (not stdout) is unaffected by the wrapper's >/dev/null
    // redirect on the receiver invocation.
    const receiverLog = path.join(repo, 'receiver.log');
    const receiver = path.join(repo, 'receiver.sh');
    await fs.writeFile(receiver, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${receiverLog}\nexit 0\n`, { mode: 0o755 });

    // Pre-existing post-commit hook that exits non-zero.
    await fs.writeFile(path.join(repo, '.git', 'hooks', 'post-commit'), '#!/bin/sh\nexit 7\n', { mode: 0o755 });

    await installGitHooks({ repoPath: repo, receiverCommand: [receiver] });

    // Run the installed wrapper directly. Git itself ignores post-commit exit
    // codes (the hook is informational), so we must invoke the wrapper as a
    // plain script to observe the preserved exit code.
    //
    // Provide an empty stdin so the wrapper's `cat > "$TMP_STDIN"` step
    // receives EOF immediately and does not block.
    const wrapperPath = path.join(repo, '.git', 'hooks', 'post-commit');
    const result = await execa(wrapperPath, [], {
      cwd: repo,
      reject: false,
      input: '',
    });

    // The wrapper must exit with the original hook's exit code.
    expect(result.exitCode).toBe(7);

    // The receiver must have been invoked and logged the --event flag.
    expect(await fs.readFile(receiverLog, 'utf8')).toContain('--event');
  });

  it('replays post-rewrite stdin to the receiver', async () => {
    const { execa } = await import('execa');
    const repo = await makeRepo('makaio-git-hooks-rewrite-');

    // Receiver script: captures stdin (the rewrite map) to a file.
    const receiverLog = path.join(repo, 'receiver-stdin.log');
    const receiver = path.join(repo, 'receiver.sh');
    await fs.writeFile(receiver, `#!/bin/sh\ncat >> ${receiverLog}\nexit 0\n`, { mode: 0o755 });

    await installGitHooks({ repoPath: repo, receiverCommand: [receiver] });

    // Create a commit then amend it; git fires post-rewrite with a rewrite
    // map on stdin: "<old-sha> <new-sha>".
    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
    await execa('git', ['add', 'a.txt'], { cwd: repo });
    await execa('git', ['commit', '-m', 'first'], { cwd: repo });

    await fs.writeFile(path.join(repo, 'a.txt'), 'b\n');
    await execa('git', ['add', 'a.txt'], { cwd: repo });
    await execa('git', ['commit', '--amend', '-m', 'first amended'], {
      cwd: repo,
    });

    // The receiver log should contain the single "<old-sha> <new-sha>" line
    // that git wrote on post-rewrite stdin.
    expect((await fs.readFile(receiverLog, 'utf8')).trim()).toMatch(/^[0-9a-f]+ [0-9a-f]+$/);
  });
});
