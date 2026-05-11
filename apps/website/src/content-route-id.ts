interface GenerateWebsiteDocsIdOptions {
  /** Markdown entry path relative to the framework root loader base. */
  entry: string;
}

const FRAMEWORK_ARCHITECTURE_PREFIX = 'docs/architecture/';
const FRAMEWORK_DOCS_PREFIX = 'docs/';
const WEBSITE_DOCS_PREFIX = 'apps/website/src/content/docs/';

/**
 * Maps Markdown entries from the framework-root docs loader into Starlight routes.
 * @param options - Loader entry path relative to the framework root.
 * @returns Starlight content collection ID.
 */
export function generateWebsiteDocsId(options: GenerateWebsiteDocsIdOptions): string {
  const withoutExtension = options.entry.replace(/\.(md|mdx)$/u, '');

  if (withoutExtension.startsWith(FRAMEWORK_ARCHITECTURE_PREFIX)) {
    return `architecture/${slugPath(withoutExtension.slice(FRAMEWORK_ARCHITECTURE_PREFIX.length))}`;
  }

  if (withoutExtension.startsWith(FRAMEWORK_DOCS_PREFIX)) {
    return `guides/${slugPath(withoutExtension.slice(FRAMEWORK_DOCS_PREFIX.length))}`;
  }

  if (withoutExtension.startsWith(WEBSITE_DOCS_PREFIX)) {
    return slugPath(withoutExtension.slice(WEBSITE_DOCS_PREFIX.length));
  }

  throw new Error(`Unsupported docs entry path: ${options.entry}`);
}

/**
 * Applies Starlight-style route normalization to a content entry path.
 * @param routePath - Content collection ID before slug normalization.
 * @returns Lowercase route ID with unsupported filename punctuation removed.
 */
function slugPath(routePath: string): string {
  return routePath
    .split('/')
    .map((segment) => segment.toLowerCase().replace(/[^a-z0-9_-]/gu, ''))
    .join('/');
}
