import { visit } from 'unist-util-visit';
import type { Root, Link } from 'mdast';

const RELATIVE_MD_RE = /^\.{1,2}\//;

/**
 * Remark plugin that strips `.md` / `.mdx` extensions from relative links.
 *
 * Markdown files in `framework/docs/` use `.md` hrefs so links work on GitHub.
 * Starlight routes don't include the extension, so this plugin rewrites them
 * at build time. Absolute URLs, anchors, and non-relative paths are untouched.
 *
 * `./bus/index.md#namespaces` → `./bus/#namespaces`
 * `../transport.md` → `../transport`
 * @returns Transformer that strips Markdown extensions from relative links.
 */
export function remarkStripMdLinks(): (tree: Root) => void {
  return (tree: Root) => {
    visit(tree, 'link', (node: Link) => {
      if (!RELATIVE_MD_RE.test(node.url)) return;

      const [pathname, fragment] = node.url.split('#', 2);
      const stripped = pathname.replace(/\/(index)\.(mdx?|md)$/u, '/').replace(/\.(mdx?|md)$/u, '');

      node.url = fragment !== undefined ? `${stripped}#${fragment}` : stripped;
    });
  };
}
