import type { Root, Html, Paragraph, List, ListItem, Link, Text } from 'mdast';

const IMPORT_RE = /^import\s+.+\s+from\s+['"].+['"];?\s*$/;
const JSX_TAG_RE = /^\s*<[A-Z]/;
const LINK_CARD_RE = /<LinkCard\s+(?=[^>]*\btitle=)[^>]*\/?\s*>/g;
const ATTR_RE = /(\w+)="([^"]*)"/g;

interface LinkCardAttrs {
  title: string;
  href: string;
  description?: string;
}

/**
 * Extracts `LinkCard` component instances from a JSX html node value.
 * @param html - Raw HTML string containing JSX elements.
 * @returns Parsed LinkCard attributes for each instance found.
 */
export function extractLinkCards(html: string): LinkCardAttrs[] {
  const cards: LinkCardAttrs[] = [];
  for (const match of html.matchAll(LINK_CARD_RE)) {
    const attrs: Record<string, string> = {};
    for (const attrMatch of match[0].matchAll(ATTR_RE)) {
      attrs[attrMatch[1]] = attrMatch[2];
    }
    if (attrs.title && attrs.href) {
      cards.push({ title: attrs.title, href: attrs.href, description: attrs.description });
    }
  }
  return cards;
}

/**
 * Builds a markdown list node from parsed LinkCard attributes.
 * @param cards - Parsed LinkCard attributes.
 * @returns Mdast list node with one item per card.
 */
function linkCardsToList(cards: LinkCardAttrs[]): List {
  const items: ListItem[] = cards.map((card) => {
    const link: Link = { type: 'link', url: card.href, children: [{ type: 'text', value: card.title } as Text] };
    const children: (Link | Text)[] = [link];
    if (card.description) {
      children.push({ type: 'text', value: ` — ${card.description}` } as Text);
    }
    return {
      type: 'listItem' as const,
      children: [{ type: 'paragraph' as const, children }],
    };
  });
  return { type: 'list', ordered: false, spread: false, children: items };
}

/**
 * Remark plugin that converts JSX artifacts from parsed `.mdx` content into
 * markdown equivalents.
 *
 * When remark-parse processes an MDX file, `import` statements become
 * paragraph nodes and JSX elements become `html` nodes. This plugin removes
 * imports and converts known components (`LinkCard`, `CardGrid`) to markdown.
 * Unknown JSX elements are removed.
 * @returns Transformer that resolves JSX nodes to markdown.
 */
export function remarkStripJsx(): (tree: Root) => void {
  return (tree: Root) => {
    const replaced: typeof tree.children = [];
    for (const node of tree.children) {
      if (node.type === 'paragraph') {
        const para = node as Paragraph;
        if (para.children.length === 1 && para.children[0].type === 'text' && IMPORT_RE.test(para.children[0].value)) {
          continue;
        }
      }

      if (node.type === 'html' && JSX_TAG_RE.test((node as Html).value)) {
        const cards = extractLinkCards((node as Html).value);
        if (cards.length > 0) {
          replaced.push(linkCardsToList(cards));
        }
        continue;
      }

      replaced.push(node);
    }
    tree.children = replaced;
  };
}
