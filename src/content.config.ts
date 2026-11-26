import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// One Markdown file per project in src/content/projects. The text is copied from the old site.
// `disciplines`, `client` and `coverAlt` are drafts written from that text, for Tannaz to confirm.
//
// The Markdown under the frontmatter is the intro at the top of the page. `sections` are the bands
// below it, in the same order and layout as on the old Squarespace page.
const projects = defineCollection({
  loader: glob({ pattern: '*.md', base: './src/content/projects' }),
  schema: ({ image }) => {
    // Grey or white background; white unless set.
    const band = z.enum(['grey', 'white']).default('white');
    const picture = z.object({ src: image(), alt: z.string().min(1), caption: z.string().optional() });
    // Each item in a `text` list is one paragraph.
    const paragraphs = z.array(z.string().min(1)).min(1);
    const section = z.discriminatedUnion('kind', [
      // Text on its own, centred.
      z.object({ kind: z.literal('text'), band, text: paragraphs }),
      // A photo filling the band from edge to edge. `height` is a share of the screen height, in %.
      z.object({ kind: z.literal('photo'), band, src: image(), alt: z.string().min(1), height: z.number().int().min(30).max(100) }),
      // A picture on the left with its text on the right.
      z.object({ kind: z.literal('beside'), band, src: image(), alt: z.string().min(1), text: paragraphs }),
      // One picture, or two side by side. `wide` lets one picture fill the page width;
      // `stagger` sets the second of two pictures a little lower.
      z.object({
        kind: z.literal('pictures'),
        band,
        pictures: z.array(picture).min(1).max(2),
        wide: z.boolean().default(false),
        stagger: z.boolean().default(false),
      }),
      // Pictures in two columns, each placed in whichever column is shorter.
      z.object({ kind: z.literal('gallery'), band, pictures: z.array(picture).min(2) }),
      // A video on the left with its title and text on the right.
      z.object({ kind: z.literal('video'), band, embed: z.url(), title: z.string().min(1), text: paragraphs }),
    ]);
    return z.object({
      title: z.string(),
      order: z.number().int(),
      summary: z.string(),
      disciplines: z.array(z.string()).min(1),
      client: z.string().optional(),
      collaborator: z.string().optional(),
      cover: image(),
      coverAlt: z.string().min(1),
      sections: z.array(section).min(1),
    });
  },
});

export const collections = { projects };
