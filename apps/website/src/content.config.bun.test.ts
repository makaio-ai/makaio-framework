import { describe, expect, it } from 'bun:test';
import { generateWebsiteDocsId } from './content-route-id';

describe('generateWebsiteDocsId', () => {
  it('throws for unsupported entry prefixes', () => {
    expect(() => generateWebsiteDocsId({ entry: 'random/path.md' })).toThrow(
      'Unsupported docs entry path: random/path.md',
    );
  });

  it('routes framework docs into the guides section', () => {
    expect(generateWebsiteDocsId({ entry: 'docs/getting-started.md' })).toBe('guides/getting-started');
    expect(generateWebsiteDocsId({ entry: 'docs/connect.md' })).toBe('guides/connect');
  });

  it('routes architecture docs into the architecture section', () => {
    expect(generateWebsiteDocsId({ entry: 'docs/architecture/bus/index.md' })).toBe('architecture/bus/index');
    expect(generateWebsiteDocsId({ entry: 'docs/architecture/transport.md' })).toBe('architecture/transport');
  });

  it('keeps website-local docs at their Starlight route', () => {
    expect(generateWebsiteDocsId({ entry: 'apps/website/src/content/docs/sdks/rust.md' })).toBe('sdks/rust');
    expect(generateWebsiteDocsId({ entry: 'apps/website/src/content/docs/reference/subjects/index.md' })).toBe(
      'reference/subjects/index',
    );
  });

  it('normalizes generated API entry IDs like Starlight docsLoader', () => {
    expect(
      generateWebsiteDocsId({
        entry: 'apps/website/src/content/docs/reference/api/tools-core/classes/MemoryStore.md',
      }),
    ).toBe('reference/api/tools-core/classes/memorystore');
    expect(
      generateWebsiteDocsId({
        entry: 'apps/website/src/content/docs/reference/api/utils/variables/DEFAULT_TIMEOUTS.md',
      }),
    ).toBe('reference/api/utils/variables/default_timeouts');
  });
});
