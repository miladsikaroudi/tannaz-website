import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// One Markdown file per project in src/content/projects. The text is copied from the old site.
// `disciplines`, `client` and `coverAlt` are drafts written from that text, for Tannaz to confirm.
const projects = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/projects' }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      order: z.number().int(),
      summary: z.string(),
      disciplines: z.array(z.string()).min(1),
      client: z.string().optional(),
      collaborator: z.string().optional(),
      cover: image(),
      coverAlt: z.string().min(1),
    }),
});

export const collections = { projects };
