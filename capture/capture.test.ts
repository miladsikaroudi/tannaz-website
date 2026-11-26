import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { chromium } from 'playwright-core';
import { PNG, startMockSite, type Mode } from './mock-site.ts';

const temp: string[] = [];
after(async () => {
  for (const dir of temp) await rm(dir, { recursive: true, force: true });
});

async function run(mode: Mode, args: string[] = [], typeAddress = false, closeChrome = false) {
  const site = await startMockSite(mode);
  const work = await mkdtemp(join(tmpdir(), 'capture-test-'));
  temp.push(work);
  const child = spawn(process.execPath, [join(import.meta.dirname, 'capture.ts'), ...(typeAddress ? [] : [site.origin]), ...args], {
    env: { ...process.env, HEADLESS: '1', ARCHIVE_DIR: join(work, 'archive'), TMPDIR: work },
  });
  let output = '';
  let answered = false;
  let typed = !typeAddress;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      output += chunk;
      if (!typed && /Site address/.test(output)) {
        typed = true;
        child.stdin.write('account.squarespace.com\n');
        setTimeout(() => child.stdin.write(`${site.origin}/config/pages\n`), 300);
      }
      if (!answered && /press Enter/.test(output)) {
        answered = true;
        // Like quitting Chrome before pressing Enter: kills only this test's browser, found by its profile folder.
        if (closeChrome) spawnSync('pkill', ['-f', join(work, 'tannaz-capture-')]);
        setTimeout(() => child.stdin.write('\n'), closeChrome ? 2000 : 500);
      }
    });
  }
  const code = await new Promise<number | null>((done) => child.on('close', done));
  site.stop();
  const left = (await readdir(work)).filter((name) => name.startsWith('tannaz-capture-'));
  assert.deepEqual(left, [], 'the sign-in profile must be deleted');
  const [stamp] = await readdir(join(work, 'archive'));
  const dir = join(work, 'archive', stamp);
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  return { code, output, dir, manifest, hits: site.hits };
}

/** How many pure green pixels a screenshot has, read back through Chrome. */
async function greenPixels(png: Buffer) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    return await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const canvas = new OffscreenCanvas(img.width, img.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(img, 0, 0);
      const { data } = context.getImageData(0, 0, img.width, img.height);
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 20 && data[i + 1] > 235 && data[i + 2] < 20) count++;
      return count;
    }, `data:image/png;base64,${png.toString('base64')}`);
  } finally {
    await browser.close();
  }
}

const ALL = ['/', '/about', '/blog', '/blog/new-post', '/blog/old-post', '/blog?offset=1500', '/hidden', '/in-sitemap-only'];

for (const mode of ['direct', 'editor'] as const) {
  test(`captures the whole site (${mode})`, { timeout: 240_000 }, async () => {
    const { manifest, dir, hits, output } = await run(mode, ['/hidden']);
    assert.deepEqual(manifest.pages.map((p: { path: string }) => p.path).sort(), ALL, output);
    assert.ok(manifest.pages.every((p: { mode: string }) => p.mode === (mode === 'editor' ? 'editor frame' : 'page')));
    assert.deepEqual(manifest.redirects, [{ from: '/old-about', to: '/about' }]);
    assert.deepEqual(manifest.notVisited, []);
    assert.ok(!hits.includes('/logout'), 'must never sign out');
    assert.match(output, /trying again: HTTP 503/);

    for (const page of manifest.pages) {
      for (const file of ['page.html', 'text.txt', 'page.mhtml', 'desktop.png', 'mobile.png', 'data.json']) {
        assert.ok((await stat(join(dir, 'pages', page.folder, file))).size > 0, `${page.path} ${file}`);
      }
    }
    const names = manifest.assets.map((a: { url: string }) => new URL(a.url).pathname);
    for (const name of ['/img/lazy.png', '/img/big.png', '/img/background.png', '/s/cv.pdf']) assert.ok(names.includes(name), name);
    for (const asset of manifest.assets) assert.equal((await stat(join(dir, 'assets', asset.file))).size, asset.bytes);

    assert.equal(manifest.failures.length, 1, JSON.stringify(manifest.failures));
    assert.match(manifest.failures[0].what, /missing\.png$/);

    const about = manifest.pages.find((p: { path: string }) => p.path === '/about');
    assert.deepEqual(about.forms, [['email', 'message']]);
    assert.equal(about.embeds.length, 2);
    assert.ok(about.embeds.includes('https://player.vimeo.com/video/1'));

    for (const [name, width] of [['desktop', 1440], ['mobile', 390]] as const) {
      const png = await readFile(join(dir, 'pages', '_root', `${name}.png`));
      assert.equal(png.readUInt32BE(16), width, `${name} screenshot width, editor must not be in the picture`);
      assert.ok(png.readUInt32BE(20) > 3000, `${name} screenshot is only ${png.readUInt32BE(20)}px tall`);
      assert.ok((await greenPixels(png)) > 1000, `${name} screenshot is missing the large photo far down the page`);
    }
    const mhtml = await readFile(join(dir, 'pages', '_root', 'page.mhtml'), 'utf8');
    assert.doesNotMatch(mhtml, /Website expired/, 'offline copy must be the page, not the editor');
    const big = manifest.assets.find((a: { url: string }) => a.url.endsWith('/img/big.png'));
    assert.deepEqual(await readFile(join(dir, 'assets', big.file)), PNG, 'must be the original, not a WebP copy');
    const html = await readFile(join(dir, 'pages', '_root', 'page.html'), 'utf8');
    assert.match(html, /Tall home page/);
    assert.match(html, /[^-]src="\/img\/lazy\.png"/, 'lazy image was never scrolled into view');
  });
}

test('a trial run asks for the address, captures one page and says what is left', { timeout: 60_000 }, async () => {
  const { manifest, output } = await run('direct', ['--limit', '1'], true);
  assert.match(output, /not the site itself/);
  assert.deepEqual(manifest.pages.map((p: { path: string }) => p.path), ['/']);
  assert.ok(manifest.notVisited.length > 0);
  assert.match(output, /not visited\s+[1-9]/);
});

for (const mode of ['expired', 'signed out'] as const) {
  test(`stops instead of saving junk (${mode})`, { timeout: 60_000 }, async () => {
    const { code, manifest, output, dir } = await run(mode);
    assert.equal(code, 1);
    assert.equal(manifest.pages.length, 0);
    assert.match(output, /stopping here/);
    assert.match(output, /was showing: http/);
    assert.ok((await stat(join(dir, 'problem-_root.png'))).size > 0);
  });
}

test('stops with a clear message when the Chrome window is closed', { timeout: 60_000 }, async () => {
  const { code, manifest, output } = await run('direct', [], false, true);
  assert.equal(code, 1);
  assert.equal(manifest.pages.length, 0);
  assert.match(output, /Chrome window was closed/);
  assert.doesNotMatch(output, /triggerUncaughtException|capture\.ts:\d+/, 'must not crash');
  assert.ok(manifest.notVisited.includes('/'), 'the pages still to do must be listed');
});
