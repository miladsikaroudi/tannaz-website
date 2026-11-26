import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptHeader, assetFile, downloadCandidates, findCdnUrls, pageProblem, siteOrigin, slug, toPagePath } from './lib.ts';

const hosts = new Set(['x.squarespace.com']);
const path = (href: string) => toPagePath(href, 'https://x.squarespace.com/blog', hosts);

test('follows pages of the site only', () => {
  assert.equal(path('/about/?utm=1#team'), '/about');
  assert.equal(path('https://x.squarespace.com'), '/');
  assert.equal(path('/blog?offset=1500&x=1'), '/blog?offset=1500');
  for (const href of ['https://other.com/a', 'mailto:a@b.c', '/s/cv.pdf', '/img/a.JPG', '/blog/tag/x', '/blog?offset=1&reversePaginate=true', 'http://[bad']) {
    assert.equal(path(href), null, href);
  }
});

test('never follows the editor or sign-out', () => {
  for (const href of ['/config', '/config/pages', '/logout', '/log-out', '/account/login', '/api/auth/logout', '/cart']) {
    assert.equal(path(href), null, href);
  }
  assert.equal(path('/configuration-guide'), '/configuration-guide');
});

test('folder names are safe and unique', () => {
  const paths = ['/', '/home', '/About', '/about', '/a/b', '/blog?offset=1', '/blog', '/../../etc', '/%D8%AA%D9%86', '/%D8%AA%D9%87'];
  const slugs = paths.map(slug);
  assert.equal(new Set(slugs.map((s) => s.toLowerCase())).size, paths.length);
  for (const s of slugs) assert.match(s, /^[A-Za-z0-9_-]+$/);
});

test('finds each Squarespace image once, in HTML and JSON', () => {
  const a = 'https://images.squarespace-cdn.com/content/v1/abc/1-XY/Photo+One.jpg';
  const html = `<img src="${a}?format=750w"><img srcset="${a}?format=100w 100w, ${a}?format=300w 300w">
    <div style="background:url(&quot;//images.squarespace-cdn.com/content/v1/abc/2/b.png?x=1&amp;y=2&quot;)">
    <script src="https://static1.squarespace.com/static/vta/site-bundle.js"></script>
    <link href="https://images.squarespace-cdn.com/content/v1/abc/">`;
  const json = `{"assetUrl":"https:\\/\\/images.squarespace-cdn.com\\/content\\/v1\\/abc\\/1-XY\\/Photo+One.jpg"}`;
  assert.deepEqual(findCdnUrls(html + json).sort(), [a, 'https://images.squarespace-cdn.com/content/v1/abc/2/b.png']);
});

test('tries the original size first on the CDN and leaves other URLs alone', () => {
  const image = 'https://images.squarespace-cdn.com/content/v1/abc/1/a.jpg';
  assert.deepEqual(downloadCandidates(image), [`${image}?format=original`, `${image}?format=2500w`, image]);
  assert.deepEqual(downloadCandidates('https://x.squarespace.com/s/cv.pdf'), ['https://x.squarespace.com/s/cv.pdf']);
});

test('asks for original image formats, and for anything else as it comes', () => {
  const original = 'image/png,image/jpeg,image/gif';
  assert.equal(acceptHeader('https://images.squarespace-cdn.com/content/v1/abc/1/a+b.JPG'), original);
  assert.equal(acceptHeader('https://images.squarespace-cdn.com/content/v1/abc/1/image-asset'), original);
  for (const url of ['https://x.squarespace.com/s/cv.pdf', 'https://static1.squarespace.com/static/a/site.css', 'https://images.squarespace-cdn.com/a/b.svg']) {
    assert.equal(acceptHeader(url), '*/*', url);
  }
});

test('file names are safe and get an extension', () => {
  assert.match(assetFile('https://h/a/..%2F..%2Fetc%2Fpasswd', 'image/png'), /^[0-9a-f]{8}-[A-Za-z0-9._-]+\.png$/);
  assert.ok(!assetFile('https://h/a/..%2F..%2Fx', 'image/png').includes('/'));
  assert.match(assetFile('https://h/photo.jpg', 'image/jpeg'), /-photo\.jpg$/);
});

test('recognises pages that must not count as captured', () => {
  const ok = { status: 200, url: 'https://x.squarespace.com/', text: 'Plenty of real words on this page', media: 1 };
  assert.equal(pageProblem(ok), null);
  assert.equal(pageProblem({ ...ok, text: '', media: 3 }), null);
  assert.ok(pageProblem({ ...ok, text: '', media: 0 }));
  assert.ok(pageProblem({ ...ok, status: 401 }));
  assert.ok(pageProblem({ ...ok, url: 'https://login.squarespace.com/' }));
  assert.ok(pageProblem({ ...ok, text: 'Website Expired. This account has expired.' }));
  assert.ok(pageProblem({ ...ok, text: 'Website Expired. If you are the owner, log in.', media: 2 }));
});

test('keeps real pages that carry the owner\'s "Website expired" banner', () => {
  const ok = { status: 200, url: 'https://x.squarespace.com/', media: 1 };
  const banner = 'Website expired. Subscribe to bring it back. ';
  assert.equal(pageProblem({ ...ok, text: banner + 'A short about page. '.repeat(25) }), null);
  assert.equal(pageProblem({ ...ok, text: banner + 'Portfolio', media: 12 }), null);
});

test('accepts whatever form of the address is pasted', () => {
  for (const text of ['x.squarespace.com', ' https://x.squarespace.com/config/pages ', 'http://x.squarespace.com/about?a=1']) {
    assert.match(siteOrigin(text) ?? '', /^https?:\/\/x\.squarespace\.com$/, text);
  }
  assert.equal(siteOrigin('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  for (const text of ['', 'tannaz', 'https://account.squarespace.com/', 'login.squarespace.com', 'squarespace.com', 'not a url']) {
    assert.equal(siteOrigin(text), null, text);
  }
});
