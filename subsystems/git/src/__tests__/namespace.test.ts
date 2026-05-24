import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { GitSubjects } from '../namespace.js';

describe('Git Namespace', () => {
  beforeEach(() => {
    MakaioBus.getContext().namespaceRegistry.__resetNamespaces?.();
  });

  describe('Query subjects', () => {
    it('should export git.getBranch request subject', () => {
      expect(GitSubjects.getBranch).toBeDefined();
      expect(GitSubjects.getBranch).toMatchObject({
        subject: 'getBranch',
        $meta: { namespace: 'git', isRequest: true },
      });
    });

    it('should export git.getCommit request subject', () => {
      expect(GitSubjects.getCommit).toBeDefined();
      expect(GitSubjects.getCommit).toMatchObject({
        subject: 'getCommit',
        $meta: { namespace: 'git', isRequest: true },
      });
    });

    it('should export git.getStatus request subject', () => {
      expect(GitSubjects.getStatus).toBeDefined();
      expect(GitSubjects.getStatus).toMatchObject({
        subject: 'getStatus',
        $meta: { namespace: 'git', isRequest: true },
      });
    });

    it('should export git.getWorktrees request subject', () => {
      expect(GitSubjects.getWorktrees).toBeDefined();
      expect(GitSubjects.getWorktrees).toMatchObject({
        subject: 'getWorktrees',
        $meta: { namespace: 'git', isRequest: true },
      });
    });

    it('should export git.getRemotes request subject', () => {
      expect(GitSubjects.getRemotes).toBeDefined();
      expect(GitSubjects.getRemotes).toMatchObject({
        subject: 'getRemotes',
        $meta: { namespace: 'git', isRequest: true },
      });
    });

    it('should export git.getDefaultBranch request subject', () => {
      expect(GitSubjects.getDefaultBranch).toBeDefined();
      expect(GitSubjects.getDefaultBranch).toMatchObject({
        subject: 'getDefaultBranch',
        $meta: { namespace: 'git', isRequest: true },
      });
    });

    it('should export git.getLog request subject', () => {
      expect(GitSubjects.getLog).toBeDefined();
      expect(GitSubjects.getLog).toMatchObject({
        subject: 'getLog',
        $meta: { namespace: 'git', isRequest: true },
      });
    });

    it('should export git.getFileAtRevision request subject', () => {
      expect(GitSubjects.getFileAtRevision).toBeDefined();
      expect(GitSubjects.getFileAtRevision).toMatchObject({
        subject: 'getFileAtRevision',
        $meta: { namespace: 'git', isRequest: true },
      });
    });

    it('should export git.getFileAtCommit request subject', () => {
      expect(GitSubjects.getFileAtCommit).toBeDefined();
      expect(GitSubjects.getFileAtCommit).toMatchObject({
        subject: 'getFileAtCommit',
        $meta: { namespace: 'git', isRequest: true },
      });
    });

    it('should export git.getBlobHashAtCommit request subject', () => {
      expect(GitSubjects.getBlobHashAtCommit).toBeDefined();
      expect(GitSubjects.getBlobHashAtCommit).toMatchObject({
        subject: 'getBlobHashAtCommit',
        $meta: { namespace: 'git', isRequest: true },
      });
    });
  });

  describe('Event subjects', () => {
    it('should export git.commit event subject', () => {
      expect(GitSubjects.commit).toBeDefined();
      expect(GitSubjects.commit).toMatchObject({
        subject: 'commit',
        $meta: { namespace: 'git' },
      });
    });

    it('should export git.checkout event subject', () => {
      expect(GitSubjects.checkout).toBeDefined();
      expect(GitSubjects.checkout).toMatchObject({
        subject: 'checkout',
        $meta: { namespace: 'git' },
      });
    });

    it('should export git.worktree event subject', () => {
      expect(GitSubjects.worktree).toBeDefined();
      expect(GitSubjects.worktree).toMatchObject({
        subject: 'worktree',
        $meta: { namespace: 'git' },
      });
    });
  });

  describe('Control subjects', () => {
    it('should export git.addRepo request subject', () => {
      expect(GitSubjects.addRepo).toBeDefined();
      expect(GitSubjects.addRepo).toMatchObject({
        subject: 'addRepo',
        $meta: { namespace: 'git', isRequest: true },
      });
    });

    it('should export git.removeRepo request subject', () => {
      expect(GitSubjects.removeRepo).toBeDefined();
      expect(GitSubjects.removeRepo).toMatchObject({
        subject: 'removeRepo',
        $meta: { namespace: 'git', isRequest: true },
      });
    });
  });

  it('should export $all wildcard subject', () => {
    expect(GitSubjects.$all).toBeDefined();
    expect(GitSubjects.$all).toMatchObject({
      subject: '*',
      $meta: { namespace: 'git' },
    });
  });
});
