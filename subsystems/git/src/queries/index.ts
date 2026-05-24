/**
 * Git query functions.
 *
 * Pure functions for git operations using simple-git.
 * @packageDocumentation
 */

// Basic queries
export { getGit, getRepoRoot, getBranch, getCommit } from './basic.js';

// Commit details
export { getCommitDetails } from './commit-details.js';

// Working tree
export { getWorkingTreeDetails, getStatus } from './working-tree.js';

// Worktree management
export { getWorktrees, initRepo, createWorktree, removeWorktree } from './worktree.js';

// Remotes and default branch
export { getRemotes, getDefaultBranch } from './remotes.js';

// Refs
export { getRefs, getBranchCommits } from './refs.js';

// Log queries
export { getLog } from './log.js';

// File operations
export {
  getFileAtRevision,
  getFileAtCommit,
  getBlobHashAtCommit,
  getDiff,
  stageFiles,
  unstageFiles,
} from './file-ops.js';
