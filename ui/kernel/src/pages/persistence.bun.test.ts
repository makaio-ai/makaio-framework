import { describe, expect, it } from 'bun:test';
import { buildPageLayoutKey } from './persistence.js';

describe('page layout persistence', () => {
  it('uses the scope-only key when contextId is absent', () => {
    expect(buildPageLayoutKey('home', { scope: 'global' })).toBe('page-layout:home:global');
    expect(buildPageLayoutKey('home', { scope: 'global', contextId: null })).toBe('page-layout:home:global');
  });

  it('uses a scoped context key when contextId is present', () => {
    expect(buildPageLayoutKey('home', { scope: 'global', contextId: 'project-1' })).toBe(
      'page-layout:home:global:project-1',
    );
    expect(buildPageLayoutKey('home', { scope: 'global', contextId: '' })).toBe('page-layout:home:global:');
  });
});
