import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';
import rehypeMermaid from 'rehype-mermaid';
import { generatePackagePages } from './integrations/generate-package-pages';
import { generateApiReference } from './integrations/generate-api-reference';
import { generateBusSubjects } from './integrations/generate-bus-subjects';
import { composeLlmsFullIntegration } from './integrations/compose-llms-full';
import { generateExtensionPages } from './integrations/generate-extension-pages';
import { generateCatalogPages } from './integrations/generate-catalog-pages';
import { generateMarkdownPages } from './integrations/generate-markdown-pages';
import { remarkResolveInternalLinks } from './remark/resolve-internal-links';
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
      [remarkResolveInternalLinks, { sourceUrlBase: SOURCE_URL_BASE }],
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
            'architecture/**',
            'clients/**',
            'adapters/**',
            'providers/**',
          ],
          promote: ['index', 'why', 'guides/getting-started', 'guides/connect', 'guides/configuration'],
          demote: ['packages/**', 'sdks/**', 'reference/subjects/**', 'reference/api/**'],
          rawContent: true,
          customSets: [
            {
              label: 'Guides',
              paths: ['guides/**'],
              description: 'workflow and how-to documentation set for using the framework',
            },
            {
              label: 'Architecture',
              paths: ['architecture/**'],
              description: 'conceptual architecture documentation: bus, extensions, adapters, transport',
            },
            {
              label: 'Clients',
              paths: ['clients/**'],
              description: 'catalog of supported AI coding clients with capabilities and integrations',
            },
            {
              label: 'Adapters',
              paths: ['adapters/**'],
              description: 'catalog of adapter implementations bridging clients to model providers',
            },
            {
              label: 'Providers',
              paths: ['providers/**'],
              description: 'catalog of model providers with protocol and client compatibility',
            },
            {
              label: 'Extensions',
              paths: ['extensions/**'],
              description: 'catalog of shipped extensions with features, CLI commands, and usage',
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
            { label: 'Connect Your Tools', link: '/guides/connect/' },
            { label: 'Creating Extensions', link: '/guides/creating-extensions/' },
            { label: 'Creating Adapters', link: '/guides/creating-adapters/' },
            { label: 'CLI', link: '/guides/cli/' },
            { label: 'Configuration', link: '/guides/configuration/' },
          ],
        },
        {
          label: 'Architecture',
          collapsed: true,
          items: [
            {
              label: 'Bus',
              items: [
                { label: 'Overview', link: '/architecture/bus/' },
                { label: 'Patterns', link: '/architecture/bus/patterns/' },
                { label: 'Storage', link: '/architecture/bus/storage/' },
                { label: 'Decoupling', link: '/architecture/bus/decoupling/' },
                { label: 'Testing', link: '/architecture/bus/testing/' },
              ],
            },
            {
              label: 'Extensions',
              items: [
                { label: 'Overview', link: '/architecture/extensions/' },
                { label: 'Discovery & Loading', link: '/architecture/extensions/discovery/' },
                { label: 'Browser & UI', link: '/architecture/extensions/browser/' },
                { label: 'Distribution', link: '/architecture/extensions/distribution/' },
              ],
            },
            {
              label: 'Adapters',
              items: [
                { label: 'Overview', link: '/architecture/adapters/' },
                { label: 'Discovery', link: '/architecture/adapters/discovery/' },
                { label: 'Models & Providers', link: '/architecture/adapters/models-and-providers/' },
                { label: 'Publishing', link: '/architecture/adapters/publishing/' },
              ],
            },
            { label: 'Transport', link: '/architecture/transport/' },
            { label: 'Desktop Apps', link: '/architecture/apps/' },
          ],
        },
        {
          label: 'Reference',
          collapsed: true,
          items: [
            {
              label: 'Bus Subjects',
              collapsed: true,
              items: [{ autogenerate: { directory: 'reference/subjects', collapsed: true } }],
            },
            {
              label: 'API',
              collapsed: true,
              items: [{ autogenerate: { directory: 'reference/api', collapsed: true } }],
            },
          ],
        },
        {
          label: 'Packages',
          collapsed: true,
          items: [{ autogenerate: { directory: 'packages', collapsed: true } }],
        },
        {
          label: 'Clients',
          collapsed: true,
          items: [{ autogenerate: { directory: 'clients', collapsed: true } }],
        },
        {
          label: 'Adapters',
          collapsed: true,
          items: [{ autogenerate: { directory: 'adapters', collapsed: true } }],
        },
        {
          label: 'Providers',
          collapsed: true,
          items: [{ autogenerate: { directory: 'providers', collapsed: true } }],
        },
        {
          label: 'Extensions',
          collapsed: true,
          items: [{ autogenerate: { directory: 'extensions', collapsed: true } }],
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
    generateExtensionPages(),
    generateCatalogPages(),
    composeLlmsFullIntegration(),
    generateMarkdownPages({
      packageSpecifierPattern: PACKAGE_SPECIFIER_PATTERN,
      sourceOnlyLinks: SOURCE_ONLY_PACKAGE_LINKS,
    }),
    sitemap({ filter: (page: string) => !page.includes('/reference/') }),
  ],
});
