// Saves a Squarespace site to ../archive/<timestamp>/. Read-only: it opens pages, it never clicks or saves.
//
//   node capture.ts --limit 1                                     trial run, one page (asks for the address)
//   node capture.ts https://NAME.squarespace.com [/hidden-page]   full run, plus any unlinked pages
//
// You sign in yourself in the Chrome window that opens, then press Enter here.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright-core';
import { acceptHeader, assetFile, assetKey, downloadCandidates, findCdnUrls, pageProblem, siteOrigin, slug, toPagePath } from './lib.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { limit: { type: 'string', default: '300' } },
});
const [siteArg, ...extraPaths] = positionals;

const prompt = createInterface({ input: process.stdin, output: process.stdout });
let address = siteOrigin(siteArg ?? (await prompt.question('Site address (NAME.squarespace.com): ')));
while (!address) address = siteOrigin(await prompt.question('That is not the site itself. Paste the NAME.squarespace.com address: '));
const origin = address;

const limit = Number(values.limit);
const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
const outDir = resolve(process.env.ARCHIVE_DIR ?? join(import.meta.dirname, '..', 'archive'), stamp);

const DESKTOP = { width: 1440, height: 900 };
const SIZES = { desktop: DESKTOP, mobile: { width: 390, height: 844 } };
const MAX_SHOT_HEIGHT = 16000; // Chrome cannot screenshot taller than about 16384px

const hosts = new Set([new URL(origin).host]);
const queue: string[] = ['/', ...extraPaths.map((p) => toPagePath(p, origin, hosts)).filter((p) => p !== null)];
const queued = new Set(queue);
const visited = new Set<string>();
const seenAssets = new Set<string>();
const manifest = {
  site: origin,
  capturedAt: new Date().toISOString(),
  pages: [] as Record<string, unknown>[],
  redirects: [] as { from: string; to: string }[],
  assets: [] as { url: string; file: string; bytes: number }[],
  failures: [] as { what: string; why: string }[],
  sitemap: [] as string[],
  notVisited: [] as string[],
};

const enqueue = (path: string | null) => {
  if (path && !queued.has(path)) {
    queued.add(path);
    queue.push(path);
  }
};
const fail = (what: string, why: unknown) => {
  const reason = why instanceof Error ? why.message.split('\n')[0] : String(why);
  manifest.failures.push({ what, why: reason });
  console.log(`  FAILED ${what}: ${reason}`);
};
const saveManifest = () => writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const inEditor = (url: string) => /^\/config(\/|$)/.test(new URL(url).pathname);

/** Opens a page directly or, when Squarespace sends owners to the editor, inside its preview frame. */
async function open(page: Page, path: string) {
  const url = origin + path;
  await page.setViewportSize(DESKTOP);
  const response = await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  if (!inEditor(page.url())) {
    return { target: page as Page | Frame, mode: 'page', status: response?.status() ?? 0, url: page.url() };
  }
  for (let i = 0; i < 40; i++) {
    const frame = page.frames().find((f) => {
      if (f === page.mainFrame() || !/^https?:/.test(f.url())) return false;
      return hosts.has(new URL(f.url()).host) && !inEditor(f.url());
    });
    if (frame) {
      const inner = await frame.goto(url, { waitUntil: 'load', timeout: 60_000 });
      return { target: frame as Page | Frame, mode: 'editor frame', status: inner?.status() ?? 0, url: frame.url() };
    }
    await page.waitForTimeout(500);
  }
  throw new Error('Squarespace opened the editor and no preview frame was found');
}

/** Scrolls through the page so lazy images load and fade-in content appears. */
async function settle(target: Page | Frame) {
  await target.evaluate(async () => {
    const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
    const root = document.documentElement;
    for (let y = 0; y < root.scrollHeight && y < 60_000; y += innerHeight * 0.8) {
      scrollTo({ top: y, behavior: 'instant' });
      await pause(150);
    }
    scrollTo({ top: 0, behavior: 'instant' });
    const loading = [...document.images].filter((img) => !img.complete && img.currentSrc);
    await Promise.race([
      Promise.all(loading.map((img) => new Promise((done) => (img.onload = img.onerror = done)))),
      pause(10_000),
    ]);
    await pause(300);
  });
}

/** Everything the inventory and the downloader need from the rendered page. */
const inspect = (target: Page | Frame) =>
  target.evaluate(() => {
    const media = new Set<string>();
    const add = (value: string | null | undefined) => {
      if (!value || /^(data|blob|about|javascript):/i.test(value)) return;
      try {
        media.add(new URL(value, document.baseURI).href);
      } catch {
        // not a URL
      }
    };
    for (const el of document.querySelectorAll('img, source, video, audio, [data-src], [data-image]')) {
      for (const name of ['src', 'data-src', 'data-image', 'poster']) add(el.getAttribute(name));
      const widest = (el.getAttribute('srcset') ?? el.getAttribute('data-srcset') ?? '')
        .split(/,\s+/)
        .map((entry) => entry.trim().split(/\s+/))
        .sort((a, b) => parseFloat(b[1] ?? '0') - parseFloat(a[1] ?? '0'))[0];
      add(widest?.[0]);
    }
    const fonts = new Set<string>();
    for (const el of document.querySelectorAll('body, body *')) {
      const style = getComputedStyle(el);
      for (const match of style.backgroundImage.matchAll(/url\("?([^")]+)"?\)/g)) add(match[1]);
      if (/^(BODY|H[1-6]|P|A|BUTTON|LI)$/.test(el.tagName)) fonts.add(style.fontFamily);
    }
    for (const el of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"], link[rel~="icon"]')) {
      if (new URL(el.href, document.baseURI).host === location.host || /site\.css|\/static\//.test(el.href)) add(el.href);
    }
    const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].map((a) => a.href);
    for (const href of links) {
      if (/\/s\/[^/]+$|\.(pdf|zip|docx?|xlsx?|pptx?|mp3)$/i.test(href.replace(/[?#].*$/, ''))) add(href);
    }
    return {
      title: document.title,
      description: document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? '',
      text: document.body?.innerText ?? '',
      height: document.documentElement.scrollHeight,
      images: document.images.length,
      links,
      media: [...media],
      fonts: [...fonts],
      embeds: [
        ...[...document.querySelectorAll('iframe')].map((f) => f.src),
        ...[...document.querySelectorAll('[data-html]')].map((e) => /src="([^"]+)/.exec(e.getAttribute('data-html')!)?.[1]),
      ].filter(Boolean),
      videos: [
        ...[...document.querySelectorAll('video')].map((v) => v.currentSrc || v.src),
        ...[...document.querySelectorAll('[data-config-video]')].map((e) => e.getAttribute('data-config-video')),
      ].filter(Boolean),
      forms: [...document.forms].map((form) => [...form.elements].map((e) => e.getAttribute('name')).filter(Boolean)),
    };
  });

async function saveMhtml(page: Page, dir: string) {
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
  await writeFile(join(dir, 'page.mhtml'), data);
  await cdp.detach();
}

/** Screenshots and offline copy of a page that opened directly. */
async function shootLive(page: Page, path: string, dir: string) {
  await saveMhtml(page, dir).catch((e) => fail(`${path} offline copy`, e));
  for (const [name, size] of Object.entries(SIZES)) {
    await page.setViewportSize(size);
    await settle(page);
    await page
      .screenshot({ path: join(dir, `${name}.png`), fullPage: true, timeout: 60_000 })
      .catch((e) => fail(`${path} ${name} screenshot`, e));
  }
}

let renderer: Browser | undefined;

/**
 * The same for a page read from the editor's frame, where the editor would be in the picture.
 * Draws the HTML just saved as a plain document: no scripts, no sign-in, nothing but that file and its images.
 */
async function shootSaved(html: string, path: string, dir: string) {
  renderer ??= await chromium.launch({ channel: 'chrome', chromiumSandbox: true, headless: true });
  const body = html.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  for (const [name, viewport] of Object.entries(SIZES)) {
    const page = await renderer.newPage({ viewport, reducedMotion: 'reduce', javaScriptEnabled: false });
    try {
      await page.route('**/*', (route) =>
        route.request().isNavigationRequest() && route.request().frame() === page.mainFrame()
          ? route.fulfill({ contentType: 'text/html; charset=utf-8', body })
          : route.continue(),
      );
      await page.goto(origin + path, { waitUntil: 'load', timeout: 60_000 });
      await page.waitForTimeout(1500);
      // Chrome does not draw large images below the first screen in time for a full-page screenshot unless they are decoded first.
      await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode().catch(() => {}))));
      await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true, timeout: 60_000 });
      if (name === 'desktop') await saveMhtml(page, dir);
    } catch (error) {
      fail(`${path} ${name} screenshot`, error);
    } finally {
      await page.close();
    }
  }
}

async function download(context: BrowserContext, url: string) {
  const key = assetKey(url);
  if (seenAssets.has(key)) return;
  seenAssets.add(key);
  let why: unknown = 'no response';
  for (const candidate of downloadCandidates(key)) {
    try {
      const response = await context.request.get(candidate, { timeout: 60_000, headers: { accept: acceptHeader(key) } });
      const type = response.headers()['content-type'] ?? '';
      if (!response.ok()) {
        why = `HTTP ${response.status()}`;
        continue;
      }
      if (/text\/html/i.test(type)) {
        why = 'got a web page instead of a file';
        continue;
      }
      const body = await response.body();
      const file = assetFile(key, type);
      await writeFile(join(outDir, 'assets', file), body);
      manifest.assets.push({ url: key, file, bytes: body.length });
      return;
    } catch (error) {
      why = error;
    }
  }
  fail(key, why);
}

async function capturePage(context: BrowserContext, page: Page, path: string) {
  const opened = await open(page, path);
  await settle(opened.target);
  const info = await inspect(opened.target);
  const problem = pageProblem({ status: opened.status, url: opened.url, text: info.text, media: info.media.length });
  if (problem) throw new Error(problem);

  const host = new URL(opened.url).host;
  if (!hosts.has(host)) {
    hosts.add(host);
    console.log(`  NOTE: the site sends visitors to ${host}. Check that this is the right site, not a parked domain.`);
  }
  const landed = toPagePath(opened.url, origin, hosts);
  if (landed && landed !== path) {
    manifest.redirects.push({ from: path, to: landed });
    path = landed;
    queued.add(path);
    if (queue.includes(path)) queue.splice(queue.indexOf(path), 1);
  }
  if (visited.has(path)) return;

  const dir = join(outDir, 'pages', slug(path));
  await mkdir(dir, { recursive: true });
  const html = await opened.target.content();
  await writeFile(join(dir, 'page.html'), html);
  await writeFile(join(dir, 'text.txt'), info.text);

  let json = '';
  const dataUrl = `${origin}${path}${path.includes('?') ? '&' : '?'}format=json-pretty`;
  const response = await context.request.get(dataUrl, { timeout: 60_000 }).catch(() => null);
  if (response?.ok() && /json/i.test(response.headers()['content-type'] ?? '')) {
    json = await response.text();
    await writeFile(join(dir, 'data.json'), json);
  }

  const { text, links, media, ...details } = info;
  visited.add(path);
  manifest.pages.push({ path, url: opened.url, folder: slug(path), mode: opened.mode, words: text.split(/\s+/).length, json: json !== '', ...details });
  for (const link of links) enqueue(toPagePath(link, opened.url, hosts));

  if (opened.target === page) await shootLive(page, path, dir);
  else await shootSaved(html, path, dir);
  if (info.height > MAX_SHOT_HEIGHT) fail(`${path} screenshot`, `page is ${info.height}px tall, bottom is cut off (page.mhtml is complete)`);

  for (const url of new Set([...media, ...findCdnUrls(html), ...findCdnUrls(json)])) await download(context, url);
}

// A new profile each time: Chrome may refuse to reopen a used one, and no sign-in is left behind.
const profileDir = await mkdtemp(join(tmpdir(), 'tannaz-capture-'));
const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'chrome',
  chromiumSandbox: true,
  headless: process.env.HEADLESS === '1',
  viewport: DESKTOP,
  reducedMotion: 'reduce',
});

await mkdir(join(outDir, 'assets'), { recursive: true });

let closed = false;
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${origin}/config`).catch(() => {}); // sends you to Squarespace's sign-in page
  await prompt.question('\nSign in to Squarespace in the Chrome window. When you can see the site, press Enter here. ');
  prompt.close();

  const sitemap = await context.request.get(`${origin}/sitemap.xml`).catch(() => null);
  if (sitemap?.ok()) {
    for (const [, loc] of (await sitemap.text()).matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
      const path = toPagePath(new URL(loc).pathname, origin, hosts);
      if (path) manifest.sitemap.push(path);
    }
    manifest.sitemap.forEach(enqueue);
  } else if (!page.isClosed()) {
    console.log(`NOTE: could not read sitemap.xml (${sitemap ? `HTTP ${sitemap.status()}` : 'no response'}), finding pages from links only.`);
  }

  for (let count = 0; queue.length && count < limit && !page.isClosed(); count++) {
    const path = queue.shift()!;
    console.log(`[${count + 1}] ${path}  (${queue.length} waiting)`);
    const first = await capturePage(context, page, path).then(() => null, (error: Error) => error);
    if (first && !page.isClosed()) {
      console.log(`  trying again: ${first.message.split('\n')[0]}`);
      await sleep(3000);
      await capturePage(context, page, path).catch(async (error) => {
        if (page.isClosed()) return;
        fail(`page ${path}`, error);
        console.log(`  was showing: ${page.frames().map((f) => f.url()).join('  |  ')}`);
        await page.screenshot({ path: join(outDir, `problem-${slug(path)}.png`) }).catch(() => {});
      });
    }
    if (page.isClosed()) {
      if (!visited.has(path)) queue.unshift(path);
      break;
    }
    await saveManifest();
    if (count === 0 && manifest.failures.length && manifest.pages.length === 0) {
      console.log('\nThe first page could not be captured, so stopping here.');
      break;
    }
  }
  if (page.isClosed()) {
    closed = true;
    console.log('\nThe Chrome window was closed, so the run stopped. Run the same command again, sign in, and leave that window open until the run finishes.');
  }
} finally {
  manifest.notVisited = [...queue];
  await saveManifest();
  await context.close().catch(() => {});
  await renderer?.close().catch(() => {});
  await rm(profileDir, { recursive: true, force: true });
}

const bytes = manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
console.log(`
Saved to ${outDir}
  pages       ${manifest.pages.length}
  files       ${manifest.assets.length} (${(bytes / 1e6).toFixed(1)} MB)
  redirects   ${manifest.redirects.length}
  not visited ${manifest.notVisited.length}${manifest.notVisited.length ? ` (limit ${limit})` : ''}
  failures    ${manifest.failures.length}`);
process.exitCode = closed || manifest.failures.length || manifest.pages.length === 0 ? 1 : 0;
