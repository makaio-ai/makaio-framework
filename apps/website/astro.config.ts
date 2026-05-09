import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import rehypeMermaid from 'rehype-mermaid';
import { generatePackagePages } from './integrations/generate-package-pages';
import { generateApiReference } from './integrations/generate-api-reference';
import { generateBusSubjects } from './integrations/generate-bus-subjects';
import { composeLlmsFullIntegration } from './integrations/compose-llms-full';
import { generateMarkdownPages } from './integrations/generate-markdown-pages';
import { remarkStripMdLinks } from './remark/strip-md-links';
import { remarkWebHide } from './remark/web-hide';
import { remarkAutoLinkApi } from './remark/auto-link-api';
import { remarkAutoLinkPackages } from './remark/auto-link-packages';

const GITHUB_REPO_URL = 'https://github.com/makaio-ai/makaio-framework';
const SOURCE_URL_BASE = `${GITHUB_REPO_URL}/blob/main`;
const PACKAGE_SPECIFIER_PATTERN = /^@makaio\/[a-z0-9][a-z0-9-]*(?:\/[A-Za-z0-9._/-]+)?$/u;
const SOURCE_ONLY_PACKAGE_LINKS: Record<string, string> = {
  '@makaio/build-tooling/browser-shared-externals': `${SOURCE_URL_BASE}/build-tooling/browser-shared-externals.ts`,
  '@makaio/build-tooling/tsdown-extension-preset': `${SOURCE_URL_BASE}/build-tooling/tsdown-extension-preset.ts`,
};

export default defineConfig({
  site: 'https://makaio.ai',
  markdown: {
    remarkPlugins: [
      remarkStripMdLinks,
      remarkWebHide,
      remarkAutoLinkApi,
      [
        remarkAutoLinkPackages,
        {
          packageSpecifierPattern: PACKAGE_SPECIFIER_PATTERN,
          sourceOnlyLinks: SOURCE_ONLY_PACKAGE_LINKS,
        },
      ],
    ],
    rehypePlugins: [[rehypeMermaid, { strategy: 'img-svg' }]],
  },
  integrations: [
    starlight({
      title: 'Makaio Framework',
      description: 'Typed, bus-centric framework for building and orchestrating AI agents',
      favicon: '/favicon.png',
      customCss: [
        '@fontsource/outfit/400.css',
        '@fontsource/outfit/500.css',
        '@fontsource/outfit/600.css',
        '@fontsource/outfit/700.css',
        '@fontsource-variable/jetbrains-mono/index.css',
        './src/styles/aura.css',
      ],
      components: {
        Head: './src/components/Head.astro',
        Header: './src/components/Header.astro',
        SiteTitle: './src/components/SiteTitle.astro',
        Hero: './src/components/Hero.astro',
        Sidebar: './src/components/Sidebar.astro',
        Footer: './src/components/Footer.astro',
      },
      social: [{ icon: 'github', label: 'GitHub', href: GITHUB_REPO_URL }],
      plugins: [
        starlightLlmsTxt({
          projectName: 'Makaio Framework',
          description:
            'Makaio Framework is a typed, bus-centric TypeScript framework for building and orchestrating AI agents, adapters, tools, storage, transports, and host shells.',
          details:
            'Use the abridged documentation for default agent context. The complete documentation is a curated large-context bundle of guides, package overviews, and SDK docs for review or large-context models. Fetch Bus Subjects when wiring runtime messages and API Reference only for exact TypeScript symbols.',
          exclude: [
            'legal/**',
            'reference/api/**',
            'reference/subjects/**',
            'packages/**',
            'sdks/**',
            'guides/apps',
            'guides/cli',
            'guides/creating-adapters',
            'guides/extensions/creating',
            'guides/extensions/index',
            'guides/extensions/discovery',
            'guides/extensions/browser',
            'guides/extensions/distribution',
            'guides/transport',
          ],
          promote: [
            'index',
            'why',
            'guides/getting-started',
            'guides/bus/index',
            'guides/bus/decoupling',
            'guides/bus/patterns',
            'guides/bus/storage',
            'guides/bus/testing',
            'guides/configuration',
          ],
          demote: ['packages/**', 'sdks/**', 'reference/subjects/**', 'reference/api/**'],
          rawContent: true,
          customSets: [
            {
              label: 'Guides',
              paths: ['guides/**'],
              description: 'large conceptual and workflow documentation set for using the framework',
            },
            {
              label: 'Packages',
              paths: ['packages/**'],
              description: 'large package-level overview set generated from framework package READMEs',
            },
            {
              label: 'SDKs',
              paths: ['sdks/**'],
              description: 'SDK overview pages for TypeScript, Python, and Rust',
            },
            {
              label: 'Bus Subjects',
              paths: ['reference/subjects/**'],
              description: 'large generated bus event and RPC subject contract reference',
            },
            {
              label: 'API Reference',
              paths: ['reference/api/**'],
              description: 'very large generated TypeScript API symbol reference',
            },
          ],
          optionalLinks: [
            {
              label: 'Source repository',
              url: GITHUB_REPO_URL,
              description: 'framework source code',
            },
          ],
        }),
      ],
      sidebar: [
        { label: 'Why Makaio', link: '/why/' },
        { label: 'Getting Started', link: '/guides/getting-started/' },
        {
          label: 'Guides',
          items: [
            {
              label: 'Bus',
              items: [
                { label: 'Overview', link: '/guides/bus/' },
                { label: 'Patterns', link: '/guides/bus/patterns/' },
                { label: 'Storage', link: '/guides/bus/storage/' },
                { label: 'Decoupling', link: '/guides/bus/decoupling/' },
                { label: 'Testing', link: '/guides/bus/testing/' },
              ],
            },
            {
              label: 'Extensions',
              items: [
                { label: 'Overview', link: '/guides/extensions/' },
                { label: 'Creating Extensions', link: '/guides/extensions/creating/' },
                { label: 'Discovery & Loading', link: '/guides/extensions/discovery/' },
                { label: 'Browser & UI', link: '/guides/extensions/browser/' },
                { label: 'Distribution', link: '/guides/extensions/distribution/' },
              ],
            },
            { label: 'Adapters', link: '/guides/creating-adapters/' },
            { label: 'CLI', link: '/guides/cli/' },
            { label: 'Transport', link: '/guides/transport/' },
            { label: 'Configuration', link: '/guides/configuration/' },
            { label: 'Desktop Apps', link: '/guides/apps/' },
          ],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: [
            {
              label: 'Bus Subjects',
              collapsed: true,
              autogenerate: { directory: 'reference/subjects', collapsed: true },
            },
            { label: 'API', collapsed: true, autogenerate: { directory: 'reference/api', collapsed: true } },
          ],
        },
        {
          label: 'Packages',
          collapsed: true,
          autogenerate: { directory: 'packages', collapsed: true },
        },
        {
          label: 'SDKs',
          collapsed: true,
          items: [
            { label: 'Overview', link: '/sdks/' },
            { label: 'Python', link: '/sdks/python/' },
            { label: 'Rust', link: '/sdks/rust/' },
            { label: 'TypeScript', link: '/sdks/typescript/' },
          ],
        },
      ],
    }),
    generateBusSubjects(),
    generateApiReference(),
    generatePackagePages(),
    composeLlmsFullIntegration(),
    generateMarkdownPages({
      packageSpecifierPattern: PACKAGE_SPECIFIER_PATTERN,
      sourceOnlyLinks: SOURCE_ONLY_PACKAGE_LINKS,
    }),
    sitemap({ filter: (page) => !page.includes('/reference/') }),
  ],
});
