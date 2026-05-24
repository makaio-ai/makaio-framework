import { describe, expect, it } from 'vitest';
import { createInboundHookReceivedSubject } from '@makaio/inbound-hooks';
import { GitHookNamespace } from '@makaio/contracts';
import gitHooksPackage from '../index.js';

describe('git-hooks extension package', () => {
  it('registers git hook namespaces and CLI contribution', () => {
    expect(gitHooksPackage.name).toBe('git-hooks');
    expect(gitHooksPackage.cli?.name).toBe('git-hooks');
    expect(gitHooksPackage.namespaces).toContain(GitHookNamespace);
    expect(gitHooksPackage.namespaces?.some((namespace) => namespace.name === 'hook:git')).toBe(true);
    expect(createInboundHookReceivedSubject('git').$meta.namespace).toBe('hook:git');
  });
});
