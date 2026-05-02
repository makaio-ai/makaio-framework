import { visit } from 'unist-util-visit';
import type { Root, Html } from 'mdast';

const OPEN_RE = /^\s*<!--\s*web:hide\s*-->\s*$/;
const CLOSE_RE = /^\s*<!--\s*\/web:hide\s*-->\s*$/;

/**
 * Remark plugin that removes content between `<!-- web:hide -->` and
 * `<!-- /web:hide -->` markers.
 *
 * HTML comments are invisible on GitHub, so the full content renders there.
 * On the Starlight website, everything between the markers (inclusive) is
 * stripped from the AST before rendering.
 * @returns Transformer that removes web-hidden Markdown ranges.
 */
export function remarkWebHide(): (tree: Root) => void {
  return (tree: Root) => {
    visit(tree, 'html', (node: Html, index, parent) => {
      if (index === undefined || !parent || !OPEN_RE.test(node.value)) return;

      let closeIndex = -1;
      for (let i = index + 1; i < parent.children.length; i++) {
        const sibling = parent.children[i];
        if (sibling.type === 'html' && CLOSE_RE.test((sibling as Html).value)) {
          closeIndex = i;
          break;
        }
      }

      if (closeIndex === -1) return;

      parent.children.splice(index, closeIndex - index + 1);
      return index;
    });
  };
}
