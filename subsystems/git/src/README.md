# @makaio/framework/git

Unified git service providing bus-backed git queries plus `.git` change monitoring layered on the runtime file-watcher service.

## Quick Index

- `src/git-service.ts` – main service class (`GitService`) combining queries and watching.
- `src/git-watcher.ts` – internal watcher component for `.git` directory changes.
- `src/queries/` – query implementations (getBranch, getStatus, etc.).
- `src/index.ts` – public exports.

## Key Contracts

```ts
// src/schemas.ts
export const BaseRequestSchema = z.object({
  repoPath: z.string().optional(), // defaults to cwd
});

export const GitBranchResponseSchema = z.object({
  current: z.string(),
  isDetached: z.boolean(),
});

export const GitStatusResponseSchema = z.object({
  staged: z.array(z.string()),
  modified: z.array(z.string()),
  untracked: z.array(z.string()),
  conflicted: z.array(z.string()),
});

// core/contracts/src/git/namespace.ts
export const GitSubjects = GitNamespace.subjects;
// git.getBranch, git.getCommit, git.getStatus, git.getWorktrees, git.getRemotes, git.getDefaultBranch, git.createWorktree, git.removeWorktree

// Declaration merge for cross-package access
declare module '@makaio/bus-core' {
  interface BusSubjectsNamespace {
    git: typeof GitSubjects;
  }
}
```

## Usage Workflow

1. **Initialize the service**
   ```ts
   import { MakaioBus } from '@makaio/framework/bus';
   import { GitService } from '@makaio/framework/git';

   const gitService = new GitService(MakaioBus);
   await gitService.init();
   ```
   - Registers request handlers on the `git` namespace.
   - Safe to call multiple times (no-op if already initialized).

2. **Make requests via bus**
   ```ts
   import { MakaioBus } from '@makaio/framework/bus';
   import { GitSubjects } from '@makaio/framework/contracts';

   // Get current branch
   const branch = await MakaioBus.request(GitSubjects.getBranch, {});
   console.log(`On branch: ${branch.current}`);

   // Get commit info for specific ref
   const commit = await MakaioBus.request(GitSubjects.getCommit, { ref: 'HEAD~1' });
   console.log(`Previous commit: ${commit.hash} - ${commit.message}`);

   // Get working directory status
   const status = await MakaioBus.request(GitSubjects.getStatus, {});
   console.log(`Staged: ${status.staged.length}, Modified: ${status.modified.length}`);

   // Query a different repository
   const remoteBranch = await MakaioBus.request(GitSubjects.getBranch, {
     repoPath: '/path/to/other/repo',
   });
   ```

3. **Cleanup**
   ```ts
   await gitService.destroy();
   ```

## Query Subjects (Request/Response)

| Subject | Request | Response | Description |
|---------|---------|----------|-------------|
| `git.getBranch` | `{ repoPath? }` | `{ current, isDetached }` | Current branch info |
| `git.getCommit` | `{ repoPath?, ref? }` | `{ hash, message, author, email, date }` | Commit details |
| `git.getStatus` | `{ repoPath? }` | `{ staged, modified, untracked, conflicted }` | Working directory status |
| `git.getLog` | `{ repoPath?, maxCount?, ref?, path? }` | `{ commits: GitLogCommit[] }` | Commit history for graph view |
| `git.getFileAtRevision` | `{ repoPath?, ref, path }` | `{ content }` | File content at specific revision |
| `git.getWorktrees` | `{ repoPath? }` | `{ worktrees: [{ path, branch, commit, isMain }] }` | List worktrees |
| `git.getRemotes` | `{ repoPath? }` | `{ remotes: [{ name, fetchUrl, pushUrl }] }` | List remotes |
| `git.getDefaultBranch` | `{ repoPath? }` | `{ branch }` | Repository default branch |
| `git.createWorktree` | `{ repoPath, path, branch, baseBranch?, createBranch? }` | `{ success, path, branch, error? }` | Create new worktree |
| `git.removeWorktree` | `{ repoPath, path, force?, deleteBranch? }` | `{ success, error? }` | Remove worktree |

All queries accept optional `repoPath` (defaults to `process.cwd()`).

## Control Subjects (Multi-Repo Management)

| Subject | Request | Response | Description |
|---------|---------|----------|-------------|
| `git.addRepo` | `{ repoPath }` | `{ success, error? }` | Add repo to the internal git metadata watcher |
| `git.removeRepo` | `{ repoPath }` | `{ success }` | Remove repo from the internal git metadata watcher |
| `git.initRepo` | `{ path, defaultBranch? }` | `{ success, path, defaultBranch }` | Initialize new git repo |

## Event Subjects (Fire-and-Forget)

The internal `GitWatcher` subscribes to runtime `fs.changed` events for watched `.git` metadata directories and emits git events when changes are detected:

| Subject | Payload | Description |
|---------|---------|-------------|
| `git.commit` | `{ hash, message, author, email, branch, timestamp, worktree? }` | New commit detected |
| `git.checkout` | `{ previousBranch?, currentBranch, timestamp, worktree? }` | Branch switch detected |
| `git.staging` | `{ staged: string[], timestamp, worktree? }` | Files staged for commit |
| `git.merge` | `{ sourceBranch, targetBranch, mergeCommit, timestamp, worktree? }` | Merge operation detected |
| `git.rebase` | `{ branch, onto, status, timestamp, worktree? }` | Rebase started/completed/aborted |
| `git.worktree` | `{ name, path, branch, event: 'added'|'removed', timestamp }` | Worktree added or removed |

All event payloads include `worktree?: string` — undefined means main repo, otherwise the worktree name.

## Architectural Responsibilities

- **Bus integration** – registers request handlers via `MakaioBus.on()` with `ctx.setResult()` for responses. Handlers follow the standard middleware pattern.
- **Git abstraction** – uses `simple-git` library for all git operations. Each request creates a fresh `SimpleGit` instance scoped to the requested `repoPath`.
- **Worktree parsing** – `getWorktrees` parses porcelain output from `git worktree list` since simple-git lacks native worktree support.
- **Default branch detection** – `getDefaultBranch` checks `refs/remotes/origin/HEAD`, then falls back to checking for `main`/`master` branches, then current branch.

## Architecture

GitService consolidates both query operations and event watching:
- **Queries** – request/response subjects (`git.getBranch`, `git.getStatus`, etc.)
- **Events** – reactive subjects for state changes (`git.commit`, `git.checkout`, etc.)
- **Control** – multi-repo management (`git.addRepo`, `git.removeRepo`)

### GitWatcher (Internal Component)

`GitWatcher` does not own low-level filesystem watching. It registers/unregisters `.git` metadata paths through `FsSubjects.watch` / `FsSubjects.unwatch`, which are implemented by the runtime-owned file-watcher service:

```
┌─────────────────────────────────────────────────────────────┐
│ GitWatcher                                                  │
├─────────────────────────────────────────────────────────────┤
│  repos: Map<repoPath, RepoWatcher>                          │
│    ├── /path/to/repo-a → { gitDir, watchId }               │
│    └── /path/to/repo-b → { gitDir, watchId }               │
├─────────────────────────────────────────────────────────────┤
│  Runtime FileWatcherService (via FsSubjects.watch/unwatch)  │
│    └── watches resolved git metadata dirs with              │
│        excludeFromDefaults for `.git`                       │
├─────────────────────────────────────────────────────────────┤
│  File change → interpretChangeForRepo() → emit git.* event  │
└─────────────────────────────────────────────────────────────┘
```

**Key behaviors:**
- Watches `.git/HEAD`, `.git/index`, `.git/MERGE_HEAD`, `.git/refs/`, etc.
- Supports worktrees via `.git/worktrees/<name>/` subdirectories
- Uses `excludeFromDefaults: ['**/.git/**']` to opt out of the default `.git` ignore
- Idempotent: calling `addRepo` twice for the same path is a no-op
- `await gitService.destroy()` waits for repo unwatch requests to complete before teardown returns

## Seams & Extension Points

- **Additional queries** – add new request handlers following the existing pattern: define schemas in `schemas.ts`, register subjects in `@makaio/contracts`, implement handlers in `git-service.ts`.
- **Custom git implementation** – replace `simple-git` with isomorphic-git or libgit2 bindings by modifying `getGit()` and the private methods.
- **Multi-repo management** – all requests accept `repoPath`, enabling queries across multiple repositories from a single service instance.
- **Caching layer** – wrap handlers to cache expensive operations (e.g., remote branch listings) with TTL-based invalidation.
