---
title: "git"
editUrl: false
prev: false
next: false
---

# `git`

| Field | Value |
|-------|-------|
| Prefix | `git` |
| Namespace constant | `GitNamespace` |
| Subjects constant | `GitSubjects` |
| Kind | bus |
| Schema record | `GitSchemas` |
| Tier | framework |
| Package | `@makaio/services-core` |
| Defined in | [`services/core/src/git/namespace.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/git/namespace.ts) |

## Subjects

| Key | Wire | Type | Schema |
|-----|------|------|--------|
| `addRepo` | [`git.addRepo`](#git.addRepo) | rpc | — |
| `checkout` | [`git.checkout`](#git.checkout) | event | [`event.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/git/schemas/event.ts) |
| `checkoutRef` | [`git.checkoutRef`](#git.checkoutRef) | rpc | — |
| `commit` | [`git.commit`](#git.commit) | event | [`event.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/git/schemas/event.ts) |
| `createBranch` | [`git.createBranch`](#git.createBranch) | rpc | — |
| `createCommit` | [`git.createCommit`](#git.createCommit) | rpc | — |
| `createWorktree` | [`git.createWorktree`](#git.createWorktree) | rpc | — |
| `deleteBranch` | [`git.deleteBranch`](#git.deleteBranch) | rpc | — |
| `discardChanges` | [`git.discardChanges`](#git.discardChanges) | rpc | — |
| `fetch` | [`git.fetch`](#git.fetch) | rpc | — |
| `fingerprint` | [`git.fingerprint`](#git.fingerprint) | rpc | — |
| `getBlame` | [`git.getBlame`](#git.getBlame) | rpc | — |
| `getBlobHashAtCommit` | [`git.getBlobHashAtCommit`](#git.getBlobHashAtCommit) | rpc | — |
| `getBranch` | [`git.getBranch`](#git.getBranch) | rpc | — |
| `getBranchCommits` | [`git.getBranchCommits`](#git.getBranchCommits) | rpc | — |
| `getCommit` | [`git.getCommit`](#git.getCommit) | rpc | — |
| `getCommitDetails` | [`git.getCommitDetails`](#git.getCommitDetails) | rpc | — |
| `getDefaultBranch` | [`git.getDefaultBranch`](#git.getDefaultBranch) | rpc | — |
| `getDiff` | [`git.getDiff`](#git.getDiff) | rpc | — |
| `getFileAtCommit` | [`git.getFileAtCommit`](#git.getFileAtCommit) | rpc | — |
| `getFileAtRevision` | [`git.getFileAtRevision`](#git.getFileAtRevision) | rpc | — |
| `getLog` | [`git.getLog`](#git.getLog) | rpc | — |
| `getRemotes` | [`git.getRemotes`](#git.getRemotes) | rpc | — |
| `getRepoRoot` | [`git.getRepoRoot`](#git.getRepoRoot) | rpc | — |
| `getStatus` | [`git.getStatus`](#git.getStatus) | rpc | — |
| `getWorkingTreeDetails` | [`git.getWorkingTreeDetails`](#git.getWorkingTreeDetails) | rpc | — |
| `getWorktrees` | [`git.getWorktrees`](#git.getWorktrees) | rpc | — |
| `initRepo` | [`git.initRepo`](#git.initRepo) | rpc | — |
| `localBranchExists` | [`git.localBranchExists`](#git.localBranchExists) | rpc | — |
| `merge` | [`git.merge`](#git.merge) | event | [`event.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/git/schemas/event.ts) |
| `mergeAbort` | [`git.mergeAbort`](#git.mergeAbort) | rpc | — |
| `mergeBranch` | [`git.mergeBranch`](#git.mergeBranch) | rpc | — |
| `pull` | [`git.pull`](#git.pull) | rpc | — |
| `push` | [`git.push`](#git.push) | rpc | — |
| `rebase` | [`git.rebase`](#git.rebase) | event | [`event.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/git/schemas/event.ts) |
| `rebaseOnto` | [`git.rebaseOnto`](#git.rebaseOnto) | rpc | — |
| `removeRepo` | [`git.removeRepo`](#git.removeRepo) | rpc | — |
| `removeWorktree` | [`git.removeWorktree`](#git.removeWorktree) | rpc | — |
| `renameBranch` | [`git.renameBranch`](#git.renameBranch) | rpc | — |
| `stage` | [`git.stage`](#git.stage) | rpc | — |
| `staging` | [`git.staging`](#git.staging) | event | [`event.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/git/schemas/event.ts) |
| `stash` | [`git.stash`](#git.stash) | rpc | — |
| `switchWorktree` | [`git.switchWorktree`](#git.switchWorktree) | rpc | — |
| `unstage` | [`git.unstage`](#git.unstage) | rpc | — |
| `worktree` | [`git.worktree`](#git.worktree) | event | [`event.ts`](https://github.com/makaio-ai/makaio-framework/blob/develop/services/core/src/git/schemas/event.ts) |

## Subject Details

### <a id="git.addRepo"></a>`git.addRepo` (rpc)

Add a repo to watch

Subject: `git.addRepo`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.checkout"></a>`git.checkout` (event)

Checkout event - branch switch detected

Subject: `git.checkout`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `currentBranch` | `string` | yes |
| `previousBranch` | `string \| undefined` | no |
| `repoPath` | `string` | yes |
| `timestamp` | `string` | yes |
| `worktree` | `string \| undefined` | no |

### <a id="git.checkoutRef"></a>`git.checkoutRef` (rpc)

Checkout a branch, tag, or commit

Subject: `git.checkoutRef`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `createBranch` | `boolean \| undefined` | no |
| `ref` | `string` | yes |
| `repoPath` | `string \| undefined` | no |
| `startPoint` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `ref` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.commit"></a>`git.commit` (event)

Commit event - new commit detected

Subject: `git.commit`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `author` | `string` | yes |
| `branch` | `string` | yes |
| `email` | `string` | yes |
| `hash` | `string` | yes |
| `message` | `string` | yes |
| `repoPath` | `string` | yes |
| `timestamp` | `string` | yes |
| `worktree` | `string \| undefined` | no |

### <a id="git.createBranch"></a>`git.createBranch` (rpc)

Create a new branch

Subject: `git.createBranch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `checkout` | `boolean \| undefined` | no |
| `name` | `string` | yes |
| `repoPath` | `string \| undefined` | no |
| `startPoint` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `name` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.createCommit"></a>`git.createCommit` (rpc)

Create a commit from currently staged changes

Subject: `git.createCommit`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `allowEmpty` | `boolean \| undefined` | no |
| `amend` | `boolean \| undefined` | no |
| `message` | `string` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `branch` | `string \| undefined` | no |
| `error` | `string \| undefined` | no |
| `hash` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.createWorktree"></a>`git.createWorktree` (rpc)

Create a new worktree

Subject: `git.createWorktree`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `baseBranch` | `string \| undefined` | no |
| `branch` | `string` | yes |
| `createBranch` | `boolean \| undefined` | no |
| `path` | `string` | yes |
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `branch` | `string` | yes |
| `error` | `string \| undefined` | no |
| `path` | `string` | yes |
| `success` | `boolean` | yes |

### <a id="git.deleteBranch"></a>`git.deleteBranch` (rpc)

Delete a branch

Subject: `git.deleteBranch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `force` | `boolean \| undefined` | no |
| `name` | `string` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.discardChanges"></a>`git.discardChanges` (rpc)

Discard working tree changes for specific files

Subject: `git.discardChanges`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `paths` | `string[]` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.fetch"></a>`git.fetch` (rpc)

Fetch refs from a remote

Subject: `git.fetch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `prune` | `boolean \| undefined` | no |
| `remote` | `string \| undefined` | no |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.fingerprint"></a>`git.fingerprint` (rpc)

Compute content-aware fingerprint of repository state

Subject: `git.fingerprint`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `exclude` | `string[]` | yes |
| `include` | `string[]` | yes |
| `repoPath` | `string` | yes |
| `worktree` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `changedPaths` | `string[]` | yes |
| `commitSha` | `string` | yes |
| `hash` | `string` | yes |
| `timestamp` | `string` | yes |

### <a id="git.getBlame"></a>`git.getBlame` (rpc)

Get blame annotations for a file

Subject: `git.getBlame`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `path` | `string` | yes |
| `ref` | `string \| undefined` | no |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `content` | `string` | yes |
| `lines` | `{ startLine: number; endLine: number; shortHash: string; hash: string; author: string; date: string; message: string; }[]` | yes |

### <a id="git.getBlobHashAtCommit"></a>`git.getBlobHashAtCommit` (rpc)

Get the git blob hash for a file at a specific commit (null if not present)

Subject: `git.getBlobHashAtCommit`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `commitHash` | `string` | yes |
| `filePath` | `string` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `blobHash` | `string \| null` | yes |

### <a id="git.getBranch"></a>`git.getBranch` (rpc)

Get current branch info

Subject: `git.getBranch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `current` | `string` | yes |
| `isDetached` | `boolean` | yes |

### <a id="git.getBranchCommits"></a>`git.getBranchCommits` (rpc)

Get all commit hashes reachable from a branch

Subject: `git.getBranchCommits`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `branchName` | `string` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `commitHashes` | `string[]` | yes |

### <a id="git.getCommit"></a>`git.getCommit` (rpc)

Get commit info for a ref

Subject: `git.getCommit`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `ref` | `string \| undefined` | no |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `author` | `string` | yes |
| `date` | `string` | yes |
| `email` | `string` | yes |
| `hash` | `string` | yes |
| `message` | `string` | yes |

### <a id="git.getCommitDetails"></a>`git.getCommitDetails` (rpc)

Get commit changes (files and stats)

Subject: `git.getCommitDetails`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `hash` | `string` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `files` | `{ path: string; status: string; additions: number; deletions: number; oldPath?: string \| undefined; }[]` | yes |
| `stats` | `{ totalAdditions: number; totalDeletions: number; changedFiles: number; }` | yes |

### <a id="git.getDefaultBranch"></a>`git.getDefaultBranch` (rpc)

Get repository default branch

Subject: `git.getDefaultBranch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `branch` | `string` | yes |

### <a id="git.getDiff"></a>`git.getDiff` (rpc)

Get unified diff for the working tree

Subject: `git.getDiff`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `paths` | `string[] \| undefined` | no |
| `ref` | `string \| undefined` | no |
| `repoPath` | `string \| undefined` | no |
| `staged` | `boolean \| undefined` | no |
| `unified` | `number \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `diff` | `string` | yes |

### <a id="git.getFileAtCommit"></a>`git.getFileAtCommit` (rpc)

Get file content at a specific commit (returns null content if file not present at commit)

Subject: `git.getFileAtCommit`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `commitHash` | `string` | yes |
| `filePath` | `string` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `content` | `string \| null` | yes |
| `isBinary` | `boolean` | yes |

### <a id="git.getFileAtRevision"></a>`git.getFileAtRevision` (rpc)

Get file content at a specific revision

Subject: `git.getFileAtRevision`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `path` | `string` | yes |
| `ref` | `string` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `content` | `string` | yes |
| `isBinary` | `boolean` | yes |

### <a id="git.getLog"></a>`git.getLog` (rpc)

Get commit history with optional filters

Subject: `git.getLog`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `filters` | `{ branches?: string[] \| undefined; branchMode?: "all" \| "specific" \| undefined; baseBranch?: string \| undefined; paths?: string[] \| undefined; author?: string \| undefined; since?: string \| undefined; until?: string \| undefined; searchQuery?: string \| undefined; selectedWorktree?: string \| undefined; } \| undefined` | no |
| `limit` | `number \| undefined` | no |
| `ref` | `string \| undefined` | no |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `commits` | `{ hash: string; shortHash: string; message: string; author: string; email: string; date: string; parents: string[]; }[]` | yes |
| `refs` | `{ branches: Record<string, string>; remoteBranches: Record<string, string>; tags: Record<string, string>; HEAD: string; }` | yes |
| `truncated` | `boolean` | yes |

### <a id="git.getRemotes"></a>`git.getRemotes` (rpc)

List configured remotes

Subject: `git.getRemotes`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `remotes` | `{ name: string; fetchUrl: string; pushUrl: string; }[]` | yes |

### <a id="git.getRepoRoot"></a>`git.getRepoRoot` (rpc)

Get repository root directory from any path within the repo

Subject: `git.getRepoRoot`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `path` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `root` | `string \| null` | yes |

### <a id="git.getStatus"></a>`git.getStatus` (rpc)

Get working directory status

Subject: `git.getStatus`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `conflicted` | `string[]` | yes |
| `modified` | `string[]` | yes |
| `staged` | `string[]` | yes |
| `untracked` | `string[]` | yes |

### <a id="git.getWorkingTreeDetails"></a>`git.getWorkingTreeDetails` (rpc)

Get working tree changes (files and stats)

Subject: `git.getWorkingTreeDetails`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `conflicted` | `{ path: string; additions: number; deletions: number; oldPath?: string \| undefined; }[]` | yes |
| `staged` | `{ path: string; additions: number; deletions: number; oldPath?: string \| undefined; }[]` | yes |
| `stats` | `{ totalAdditions: number; totalDeletions: number; changedFiles: number; }` | yes |
| `unstaged` | `{ path: string; additions: number; deletions: number; oldPath?: string \| undefined; }[]` | yes |
| `untracked` | `{ path: string; additions: number; deletions: number; oldPath?: string \| undefined; }[]` | yes |

### <a id="git.getWorktrees"></a>`git.getWorktrees` (rpc)

List git worktrees

Subject: `git.getWorktrees`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `worktrees` | `{ path: string; branch: string; commit: string; isMain: boolean; }[]` | yes |

### <a id="git.initRepo"></a>`git.initRepo` (rpc)

Initialize a new git repository

Subject: `git.initRepo`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `defaultBranch` | `string \| undefined` | no |
| `path` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `defaultBranch` | `string` | yes |
| `path` | `string` | yes |
| `success` | `boolean` | yes |

### <a id="git.localBranchExists"></a>`git.localBranchExists` (rpc)

Check whether a local branch ref exists (host-owned only)

Subject: `git.localBranchExists`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `name` | `string` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `exists` | `boolean` | yes |

### <a id="git.merge"></a>`git.merge` (event)

Merge event - merge operation detected

Subject: `git.merge`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `mergeCommit` | `string` | yes |
| `repoPath` | `string` | yes |
| `sourceBranch` | `string` | yes |
| `targetBranch` | `string` | yes |
| `timestamp` | `string` | yes |
| `worktree` | `string \| undefined` | no |

### <a id="git.mergeAbort"></a>`git.mergeAbort` (rpc)

Abort an in-progress merge

Subject: `git.mergeAbort`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.mergeBranch"></a>`git.mergeBranch` (rpc)

Merge a branch into the current branch

Subject: `git.mergeBranch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `abortOnConflict` | `boolean \| undefined` | no |
| `approach` | `"squash" \| "merge" \| "fast-forward-only" \| undefined` | no |
| `message` | `string \| undefined` | no |
| `repoPath` | `string \| undefined` | no |
| `source` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `conflicts` | `string[] \| undefined` | no |
| `error` | `string \| undefined` | no |
| `fastForward` | `boolean \| undefined` | no |
| `hash` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.pull"></a>`git.pull` (rpc)

Pull changes from a remote

Subject: `git.pull`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `branch` | `string \| undefined` | no |
| `rebase` | `boolean \| undefined` | no |
| `remote` | `string \| undefined` | no |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `conflicts` | `string[] \| undefined` | no |
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.push"></a>`git.push` (rpc)

Push commits to a remote

Subject: `git.push`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `branch` | `string \| undefined` | no |
| `force` | `boolean \| undefined` | no |
| `remote` | `string \| undefined` | no |
| `repoPath` | `string \| undefined` | no |
| `setUpstream` | `boolean \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `branch` | `string \| undefined` | no |
| `error` | `string \| undefined` | no |
| `remote` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.rebase"></a>`git.rebase` (event)

Rebase event - rebase operation detected

Subject: `git.rebase`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `branch` | `string` | yes |
| `onto` | `string` | yes |
| `repoPath` | `string` | yes |
| `status` | `"completed" \| "started" \| "aborted"` | yes |
| `timestamp` | `string` | yes |
| `worktree` | `string \| undefined` | no |

### <a id="git.rebaseOnto"></a>`git.rebaseOnto` (rpc)

Rebase current branch onto a target

Subject: `git.rebaseOnto`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `abort` | `boolean \| undefined` | no |
| `continueRebase` | `boolean \| undefined` | no |
| `onto` | `string` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `conflicts` | `string[] \| undefined` | no |
| `error` | `string \| undefined` | no |
| `hash` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.removeRepo"></a>`git.removeRepo` (rpc)

Remove a repo from watching

Subject: `git.removeRepo`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `success` | `boolean` | yes |

### <a id="git.removeWorktree"></a>`git.removeWorktree` (rpc)

Remove a worktree

Subject: `git.removeWorktree`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `deleteBranch` | `boolean \| undefined` | no |
| `force` | `boolean \| undefined` | no |
| `path` | `string` | yes |
| `repoPath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.renameBranch"></a>`git.renameBranch` (rpc)

Rename a branch

Subject: `git.renameBranch`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `newName` | `string` | yes |
| `oldName` | `string` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.stage"></a>`git.stage` (rpc)

Stage files for commit

Subject: `git.stage`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `paths` | `string[]` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.staging"></a>`git.staging` (event)

Staging event - files staged for commit

Subject: `git.staging`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string` | yes |
| `staged` | `string[]` | yes |
| `timestamp` | `string` | yes |
| `worktree` | `string \| undefined` | no |

### <a id="git.stash"></a>`git.stash` (rpc)

Stash operations (push, pop, apply, drop, list)

Subject: `git.stash`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `includeUntracked` | `boolean \| undefined` | no |
| `index` | `number \| undefined` | no |
| `message` | `string \| undefined` | no |
| `operation` | `"apply" \| "pop" \| "push" \| "list" \| "drop"` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `entries` | `{ index: number; message: string; branch: string; date: string; }[] \| undefined` | no |
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.switchWorktree"></a>`git.switchWorktree` (rpc)

Switch to a different worktree

Subject: `git.switchWorktree`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `repoPath` | `string \| undefined` | no |
| `worktreePath` | `string` | yes |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.unstage"></a>`git.unstage` (rpc)

Unstage files (remove from staging area)

Subject: `git.unstage`
Type: Request (RPC)

**Request:**

| Field | Type | Required |
|-------|------|----------|
| `paths` | `string[]` | yes |
| `repoPath` | `string \| undefined` | no |

**Response:**

| Field | Type | Required |
|-------|------|----------|
| `error` | `string \| undefined` | no |
| `success` | `boolean` | yes |

### <a id="git.worktree"></a>`git.worktree` (event)

Worktree event - worktree added or removed

Subject: `git.worktree`
Type: Event

| Field | Type | Required |
|-------|------|----------|
| `branch` | `string` | yes |
| `event` | `"added" \| "removed"` | yes |
| `name` | `string` | yes |
| `path` | `string` | yes |
| `repoPath` | `string` | yes |
| `timestamp` | `string` | yes |

---

*Auto-generated by `yarn docs:bus`. Do not edit manually.*
