import { describe, expect, it } from 'vitest';
import { computeMetaTags, ToolCapability } from '../capabilities.js';

describe('computeMetaTags', () => {
  it('returns read-only for pure read capabilities', () => {
    const result = computeMetaTags([ToolCapability.FILE_READ, ToolCapability.SEARCH_CONTENT]);
    expect(result).toEqual(['read-only']);
  });

  it('returns destructive when any destructive capability is present', () => {
    const result = computeMetaTags([ToolCapability.FILE_WRITE]);
    expect(result).toEqual(['destructive']);
  });

  it('returns only destructive for mixed read-only and destructive capabilities', () => {
    const result = computeMetaTags([ToolCapability.FILE_READ, ToolCapability.FILE_DELETE]);
    // Not all capabilities are read-only, so 'read-only' is omitted.
    expect(result).toEqual(['destructive']);
  });

  it('returns empty array for empty capabilities list', () => {
    const result = computeMetaTags([]);
    expect(result).toEqual([]);
  });

  it('returns destructive for a single destructive capability', () => {
    const result = computeMetaTags([ToolCapability.SHELL_EXECUTE]);
    expect(result).toEqual(['destructive']);
  });

  it('returns read-only for multiple read-only capabilities', () => {
    const result = computeMetaTags([
      ToolCapability.FILE_READ,
      ToolCapability.SEARCH_CONTENT,
      ToolCapability.SEARCH_FILES,
      ToolCapability.SEARCH_WEB,
    ]);
    expect(result).toEqual(['read-only']);
  });

  it('returns empty array for a neutral capability (network.request)', () => {
    const result = computeMetaTags([ToolCapability.NETWORK_REQUEST]);
    expect(result).toEqual([]);
  });

  it('returns destructive when all capabilities are present (bash-like tool)', () => {
    const all = Object.values(ToolCapability) as ToolCapability[];
    const result = computeMetaTags(all);
    // At least one destructive capability is present, and not all are read-only.
    expect(result).toEqual(['destructive']);
  });
});
