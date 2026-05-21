/// <reference types="astro/client" />

declare module '@astrojs/sitemap' {
  import type { AstroIntegration } from 'astro';

  export interface SitemapOptions {
    filter?: (page: string) => boolean;
  }

  export default function sitemap(options?: SitemapOptions): AstroIntegration;
}
