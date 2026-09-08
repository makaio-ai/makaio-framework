import type { WorkspaceRequirement } from '@makaio/contracts';

/**
 * Select an immutable Git revision and consume it in the workspace setup recipe.
 * @param revision - Full commit object identifier selected by the execution owner.
 * @returns Workspace declaration for the admitted preparation path.
 */
export function gitWorkspaceRequirement(revision: string): WorkspaceRequirement {
  return {
    provisioning: 'create',
    custody: 'disposable',
    sourceRoots: [
      { id: 'primary', path: 'source', source: { kind: 'git', input: { repositoryId: 'project', revision } } },
    ],
    setup: [
      {
        command: process.execPath,
        args: [
          '-e',
          "const fs=require('fs');fs.writeFileSync('ready.txt',fs.readFileSync('source/content.txt','utf8')+' prepared')",
        ],
        env: {},
        timeoutMs: 5_000,
      },
    ],
  };
}
