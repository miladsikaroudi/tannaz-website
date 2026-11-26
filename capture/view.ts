// Shows a saved copy of the site at http://localhost:4321 so you can click through it.
// Squarespace's scripts are left out, because they would send you to its sign-in page.
// Styles, fonts and images still come from Squarespace's public servers.
//
//   node view.ts ../archive/<run>

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '.');
const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
const folders = new Map<string, string>(manifest.pages.map((p: { path: string; folder: string }) => [p.path, p.folder]));
const port = Number(process.env.PORT ?? 4321);

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
  const folder = folders.get(path);
  if (!folder) return res.writeHead(404, { 'content-type': 'text/plain' }).end(`${path} is not in the saved copy`);
  const html = (await readFile(join(dir, 'pages', folder, 'page.html'), 'utf8'))
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replaceAll(manifest.site, '');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
}).listen(port, () => console.log(`Saved copy of ${manifest.site} at http://localhost:${port}`));
