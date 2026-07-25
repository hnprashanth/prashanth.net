// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import { rehypeFigures } from './tools/rehype-figures.mjs';

export default defineConfig({
  site: 'https://prashanth.net',
  trailingSlash: 'never',
  build: { format: 'file' },

  // Belt-and-braces: prefetch injects a client script. We ship zero JS.
  prefetch: false,
  devToolbar: { enabled: false },

  integrations: [sitemap()],

  image: {
    // Both default to off in Astro 7; without them <Image> is not responsive.
    layout: 'constrained',
    responsiveStyles: true,
  },

  markdown: {
    // Astro 7 defaults to the Satteri processor, which has no rehype support.
    // Swap in the unified/remark pipeline so we can promote images to <figure>.
    processor: unified({
      rehypePlugins: [rehypeFigures],
    }),
    // No code blocks survive conversion (they existed only in skipped drafts),
    // so Shiki would only add unused CSS.
    syntaxHighlight: false,
  },
});
