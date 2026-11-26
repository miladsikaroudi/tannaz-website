// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://www.bytannaz.com',
  // The old site had the same project grid at /work and on the home page.
  redirects: { '/work': '/' },
  // Pictures in the Markdown pages get several sizes, so phones download small ones.
  image: { layout: 'constrained' },
  devToolbar: { enabled: false },
});
