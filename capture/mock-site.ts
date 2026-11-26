// A stand-in for a Squarespace site that is down for visitors, used by the tests.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';

export type Mode = 'direct' | 'editor' | 'expired' | 'signed out';

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** A large photo-sized PNG, all pure green: the only pure green on the page. */
function greenPng(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8 bits per channel
  header[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).fill(Buffer.from([0, 255, 0]))]);
  const pixels = deflateSync(Buffer.concat(Array<Buffer>(height).fill(row)));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}
const PHOTO = greenPng(2500, 1667);

const NAV = `<nav><a href="/">Home</a> <a href="/about/">About</a> <a href="/blog">Blog</a> <a href="/old-about">Old</a>
  <a href="/logout">Log out</a> <a href="/blog/category/News">News</a> <a href="https://example.com/x">Elsewhere</a></nav>`;

const PAGES: Record<string, string> = {
  '/': `<h1>Tall home page with enough words to be real</h1><div style="height:3000px;background:linear-gradient(#c33,#33c)"></div>
    <img data-src="/img/lazy.png" width="50" height="50"><img src="/img/missing.png">
    <img srcset="/img/small.png 100w, /img/big.png 2000w" width="50">
    <div style="background-image:url('/img/background.png');height:50px"></div>
    <div style="height:3000px"></div><img src="/img/photo.png" loading="lazy" decoding="async" width="1000" height="667" style="max-width:100%;height:auto">
    <script>new IntersectionObserver((es, o) => es.forEach(e => { if (e.isIntersecting) { e.target.src = e.target.dataset.src; o.disconnect(); } }))
      .observe(document.querySelector('[data-src]'))</script>`,
  '/about': `<h1>About page text that is long enough</h1><a href="/s/cv.pdf">CV</a>
    <form><input name="email"><input name="message"></form><iframe src="/embed"></iframe>
    <div data-html='<iframe src="https://player.vimeo.com/video/1"></iframe>'></div><script>window.top !== window || (document.title = 'script ran')</script>`,
  '/blog': `<h1>Blog listing with enough words</h1><a href="/blog/new-post">New</a><a href="/blog?offset=1500">Older</a>`,
  '/blog?offset=1500': `<h1>Older posts with enough words</h1><a href="/blog/old-post">Old</a><a href="/blog?offset=9&reversePaginate=true">Newer</a>`,
  '/blog/new-post': `<h1>New post with enough words</h1>`,
  '/blog/old-post': `<h1>Old post with enough words</h1>`,
  '/hidden': `<h1>Unlinked page with enough words</h1>`,
  '/in-sitemap-only': `<h1>Only the sitemap knows this page</h1>`,
};

export async function startMockSite(mode: Mode) {
  const hits: string[] = [];
  let failedOnce = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://mock');
    const signedIn = /session=1/.test(req.headers.cookie ?? '') && mode !== 'signed out';
    hits.push(url.pathname + url.search);
    const send = (status: number, type: string, body: string | Buffer, headers = {}) =>
      res.writeHead(status, { 'content-type': type, ...headers }).end(body);
    const html = (status: number, body: string) =>
      send(status, 'text/html', `<!doctype html><title>Mock</title><body style="margin:0">${body}</body>`);

    if (url.pathname === '/do-login') return send(200, 'text/plain', 'ok', { 'set-cookie': 'session=1; Path=/' });
    if (url.pathname === '/logout') return send(200, 'text/html', 'bye', { 'set-cookie': 'session=0; Path=/' });
    if (url.pathname.startsWith('/config')) {
      return signedIn
        ? html(200, `<div style="display:flex;height:100vh"><aside style="width:200px">Editor. Website expired. Subscribe</aside>
            <iframe src="/" style="flex:1;border:0"></iframe></div>`)
        : html(200, `Sign in<script>fetch('/do-login')</script>`);
    }
    if (url.pathname.startsWith('/img/')) {
      if (/missing/.test(url.pathname)) return send(404, 'text/plain', 'no');
      if (/photo\.png$/.test(url.pathname)) return send(200, 'image/png', PHOTO);
      // Like Squarespace's CDN: anyone who accepts WebP, or anything, gets a converted copy.
      return /webp|\*\/\*/.test(req.headers.accept ?? '*/*')
        ? send(200, 'image/webp', Buffer.concat([PNG, Buffer.from('converted')]))
        : send(200, 'image/png', PNG);
    }
    if (!signedIn) return html(401, `<form>This site is private<input name="password"></form>`);
    if (url.pathname === '/s/cv.pdf') return send(200, 'application/pdf', '%PDF-1.4 mock');
    if (url.pathname === '/embed') return html(200, 'embedded');
    if (url.pathname === '/sitemap.xml') {
      return send(200, 'application/xml', '<urlset><url><loc>https://www.custom-domain.test/in-sitemap-only</loc></url></urlset>');
    }
    if (mode === 'expired') return html(200, '<h1>Website Expired</h1><p>This account has expired.</p>');
    if (url.pathname === '/blog/new-post' && !failedOnce && !url.search) {
      failedOnce = true;
      return html(503, 'Busy');
    }
    if (url.pathname === '/old-about') return res.writeHead(302, { location: '/about' }).end();

    const key = url.searchParams.has('offset') ? `${url.pathname}?offset=${url.searchParams.get('offset')}` : url.pathname;
    if (url.searchParams.has('format')) return send(200, 'application/json', JSON.stringify({ path: key }, null, 2));
    if (mode === 'editor' && req.headers['sec-fetch-dest'] === 'document') {
      return res.writeHead(302, { location: '/config/' }).end();
    }
    return PAGES[key] ? html(200, NAV + PAGES[key]) : html(404, 'not found');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
