import { createHash } from 'node:crypto';

const hash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 8);

const FILE_EXT =
  /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|docx?|xlsx?|pptx?|mp[34]|m4a|mov|webm|ics|xml|json|css|js|txt|woff2?|ttf|otf)$/i;

// Never followed: the editor, sign-out (it would end the session mid-run), and shop plumbing.
const NOT_A_PAGE =
  /^\/(config|api|account|cart|checkout|search|s|universal|log-?in|log-?out|sign-?in|sign-?out)(\/|$)/i;

/** The site's origin from whatever was pasted, or null when it is not the site itself. */
export function siteOrigin(input: string): string | null {
  const text = input.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    const shared = /^(www|login|account|support|app)\.squarespace\.com$|^squarespace\.com$/i.test(url.host);
    return shared || !/[.:]/.test(url.host) ? null : url.origin;
  } catch {
    return null;
  }
}

/** The path to visit for a link, or null when the link is not a page of this site. */
export function toPagePath(href: string, base: string, hosts: Set<string>): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !hosts.has(url.host)) return null;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (NOT_A_PAGE.test(path) || FILE_EXT.test(path)) return null;
  if (/\/(category|tag)\//i.test(path)) return null; // filtered lists of posts captured anyway
  if (url.searchParams.has('reversePaginate')) return null; // "newer posts" link
  for (const key of ['offset', 'page']) {
    const value = url.searchParams.get(key);
    if (value && /^\d+$/.test(value)) return `${path}?${key}=${value}`;
  }
  return path;
}

/** Folder name for a page. Anything not safe on a case-insensitive disk gets a hash. */
export function slug(path: string): string {
  if (path === '/') return '_root';
  const plain = path.slice(1).replaceAll('/', '__');
  if (/^[a-z0-9_-]{1,100}$/.test(plain)) return plain;
  return `${plain.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80)}-${hash(path)}`;
}

/** Squarespace-hosted content files mentioned anywhere in saved HTML or JSON. */
export function findCdnUrls(text: string): string[] {
  const clean = text.replaceAll('\\/', '/').replaceAll('&amp;', '&').replaceAll('&quot;', '"');
  const found = clean.match(
    /(?:https?:)?\/\/(?:images\.squarespace-cdn\.com|static1\.squarespace\.com\/static)\/[^\s"'<>()\\]+/gi,
  );
  const urls = new Set<string>();
  for (const match of found ?? []) {
    const url = assetKey((match.startsWith('//') ? 'https:' : '') + match.replace(/[,;]+$/, ''));
    if (!url.endsWith('/') && !/\.js$/i.test(url)) urls.add(url);
  }
  return [...urls];
}

const isCdn = (url: string) =>
  /^https?:\/\/(images\.squarespace-cdn\.com|static1\.squarespace\.com)\//i.test(url);

/** One key per file: the CDN's ?format=750w variants are all the same image. */
export function assetKey(url: string): string {
  return isCdn(url) ? url.replace(/[?#].*$/, '') : url.replace(/#.*$/, '');
}

/** URLs to try in order, largest first. */
export function downloadCandidates(key: string): string[] {
  return isCdn(key) && /\.(jpe?g|png|gif|webp|avif)$|\/[^./]+$/i.test(key)
    ? [`${key}?format=original`, `${key}?format=2500w`, key]
    : [key];
}

/** The CDN swaps in WebP for anyone who accepts it, so ask for the uploaded formats only. */
export function acceptHeader(key: string): string {
  const path = new URL(key).pathname;
  const image = /\.(jpe?g|png|gif)$/i.test(path) || (isCdn(key) && !/\.[a-z0-9]+$/i.test(path));
  return image ? 'image/png,image/jpeg,image/gif' : '*/*';
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/css': '.css',
};

/** Unique, safe file name for a downloaded asset. */
export function assetFile(key: string, contentType: string): string {
  let name = new URL(key).pathname.split('/').pop() || 'file';
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep the encoded name
  }
  name = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file';
  const ext = FILE_EXT.test(name) ? '' : (EXT_BY_TYPE[contentType.split(';')[0].trim()] ?? '');
  return `${hash(key)}-${name}${ext}`;
}

/** Why a loaded page must not be counted as captured, or null when it looks real. */
export function pageProblem(page: { status: number; url: string; text: string; media: number }): string | null {
  if (/^(login|account)\.squarespace\.com$/i.test(new URL(page.url).host)) return 'asked to sign in';
  if (page.status >= 400) return `HTTP ${page.status}`;
  const text = page.text.trim();
  // Owners see a "Website expired" banner over the real page, so only a bare notice counts.
  const bare = text.length < 400 && page.media < 5;
  if (bare && /website expired|this (web)?site is (private|unavailable|not available)/i.test(text)) {
    return 'Squarespace shows an expired or private notice';
  }
  if (text.length < 20 && page.media === 0) return 'page is empty';
  return null;
}
