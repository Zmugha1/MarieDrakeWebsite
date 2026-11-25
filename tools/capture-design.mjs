import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ORIGIN = 'https://thedrakelawfirm.com';
const SITE_HOSTS = new Set(['thedrakelawfirm.com', 'www.thedrakelawfirm.com']);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
const GAP_MS = 300;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_DIR = join(ROOT, 'inventory', 'snapshots');
const DESIGN_DIR = join(ROOT, 'inventory', 'design');
const CSS_DIR = join(DESIGN_DIR, 'css');
const FONT_DIR = join(DESIGN_DIR, 'fonts');
const BRAND_DIR = join(DESIGN_DIR, 'brand');

const failures = [];
let lastRequestFinishedAt = 0;

function walkHtml(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkHtml(path, out);
    else if (entry.name.toLowerCase().endsWith('.html')) out.push(path);
  }
  return out;
}

function snapshotName(filePath) {
  return relative(SNAPSHOT_DIR, filePath).split('\\').join('/');
}

function decodeAttr(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  if (!match) return '';
  return decodeAttr(match[1] ?? match[2] ?? match[3] ?? '');
}

function relTokens(tag) {
  return attr(tag, 'rel').toLowerCase().split(/\s+/).filter(Boolean);
}

function resolveUrl(raw, base = ORIGIN) {
  const text = decodeAttr(String(raw || '')).trim();
  if (!text || text.startsWith('data:') || text.startsWith('blob:') || text.startsWith('javascript:')) return '';
  try {
    const url = new URL(text, base);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function hostOf(raw) {
  try { return new URL(raw).hostname.toLowerCase(); } catch { return ''; }
}

function pathOf(raw) {
  try { return new URL(raw).pathname.toLowerCase(); } catch { return ''; }
}

function isGoogleFont(raw) {
  const host = hostOf(raw);
  return host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com' || host.endsWith('.fonts.googleapis.com');
}

function isSite(raw) {
  return SITE_HOSTS.has(hostOf(raw));
}

function isFontFile(raw) {
  return /\.(?:woff2?|ttf)$/i.test(pathOf(raw));
}

function isStylesheetPath(raw) {
  return pathOf(raw).endsWith('.css');
}

function extractCssUrls(css, baseUrl) {
  const found = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let match;
  while ((match = urlRe.exec(clean))) {
    const resolved = resolveUrl(match[2], baseUrl);
    if (resolved) found.push(resolved);
  }
  const importRe = /@import\s+(['"])([^'"]+)\1/gi;
  while ((match = importRe.exec(clean))) {
    const resolved = resolveUrl(match[2], baseUrl);
    if (resolved) found.push(resolved);
  }
  return found;
}

function extractFontUrls(text, baseUrl) {
  const found = [];
  const re = /(?:https?:)?\/\/[^"'()\s>]+\.(?:woff2?|ttf)(?:\?[^"'()\s>]*)?|(?:\.|\.\.)?\/[^"'()\s>]+\.(?:woff2?|ttf)(?:\?[^"'()\s>]*)?/gi;
  let match;
  while ((match = re.exec(text))) {
    const resolved = resolveUrl(match[0], baseUrl);
    if (resolved && isFontFile(resolved)) found.push(resolved);
  }
  return found;
}

function readableName(raw) {
  const url = new URL(raw);
  let base = url.pathname.split('/').filter(Boolean).pop() || 'file';
  try { base = decodeURIComponent(base); } catch { /* keep raw */ }
  base = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base || base === '.' || base === '..') base = 'file';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const queryMark = url.search
    ? `-${createHash('sha1').update(url.search).digest('hex').slice(0, 8)}`
    : '';
  const trimmedStem = stem.length > 80 ? stem.slice(0, 80) : stem;
  return `${trimmedStem}${queryMark}${ext}`;
}

function allocateName(dir, raw, usedNames) {
  const preferred = readableName(raw);
  const dot = preferred.lastIndexOf('.');
  const stem = dot > 0 ? preferred.slice(0, dot) : preferred;
  const ext = dot > 0 ? preferred.slice(dot) : '';
  let name = preferred;
  let n = 2;
  while (usedNames.has(`${dir}/${name}`)) {
    name = `${stem}-${n}${ext}`;
    n += 1;
  }
  usedNames.add(`${dir}/${name}`);
  return name;
}

async function request(url, accept) {
  const wait = Math.max(0, lastRequestFinishedAt + GAP_MS - Date.now());
  if (wait > 0) await delay(wait);
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    lastRequestFinishedAt = Date.now();
    return { ok: false, status: 0, error: error.message || String(error), buffer: null, text: '' };
  }
  lastRequestFinishedAt = Date.now();
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    ok: response.ok,
    status: response.status,
    error: '',
    buffer,
    text: buffer.toString('utf8'),
  };
}

function recordFailure(url, result) {
  failures.push({
    url,
    status: result.status || 0,
    error: result.error || '',
  });
}

function addPage(map, url, page) {
  if (!map.has(url)) map.set(url, new Set());
  if (page) map.get(url).add(page);
}

function pagesOf(map, url) {
  return [...(map.get(url) || [])].sort();
}

function bulletPages(pages) {
  if (pages.length === 0) return '- Snapshots: none.';
  return ['- Snapshots:', ...pages.map((page) => `  - ${page}`)].join('\n');
}

function writeManifest(saved, googleFonts, otherCssUrls) {
  const lines = [];
  lines.push('# Design capture');
  lines.push('');
  lines.push(`Read-only download from ${ORIGIN} on ${new Date().toISOString()}. The live WordPress site was not changed.`);
  lines.push('');
  lines.push('Requests use a Firefox 133 User-Agent. A Chrome User-Agent was closed by the server before any HTTP status was returned.');
  lines.push('');
  lines.push('## Files saved');
  lines.push('');
  if (saved.length === 0) {
    lines.push('None.');
  }
  for (const file of saved) {
    lines.push(`### ${file.file}`);
    lines.push('');
    lines.push(`- Source: ${file.url}`);
    lines.push(`- Size: ${file.bytes} bytes`);
    lines.push(bulletPages(file.pages));
    lines.push('');
  }
  lines.push('## Google Fonts listed only');
  lines.push('');
  lines.push('These URLs were not downloaded.');
  lines.push('');
  if (googleFonts.length === 0) {
    lines.push('None.');
    lines.push('');
  }
  for (const item of googleFonts) {
    lines.push(`- ${item.url}`);
    if (item.pages.length > 0) lines.push(`  - Snapshots: ${item.pages.join(', ')}`);
  }
  lines.push('');
  lines.push('## Failed URLs');
  lines.push('');
  if (failures.length === 0) {
    lines.push('None.');
  } else {
    for (const failure of failures) {
      const detail = failure.status ? `HTTP ${failure.status}` : `no status (${failure.error})`;
      lines.push(`- ${failure.url} (${detail})`);
    }
  }
  lines.push('');
  lines.push('## CSS urls not saved');
  lines.push('');
  lines.push('Stylesheet url() values that are not font files and not further stylesheets were not downloaded. The task asks for stylesheets, on-site font files, the header logo, and the favicon.');
  lines.push('');
  lines.push(`Count: ${otherCssUrls.length}.`);
  lines.push('');
  mkdirSync(DESIGN_DIR, { recursive: true });
  writeFileSync(join(DESIGN_DIR, 'manifest.md'), `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const htmlFiles = walkHtml(SNAPSHOT_DIR).sort();
  const stylesheetPages = new Map();
  const fontPages = new Map();
  const htmlBySnapshot = new Map();

  for (const filePath of htmlFiles) {
    const page = snapshotName(filePath);
    const html = readFileSync(filePath, 'utf8');
    htmlBySnapshot.set(page, html);
    const linkRe = /<link\b[^>]*>/gi;
    let match;
    while ((match = linkRe.exec(html))) {
      const tag = match[0];
      const rel = relTokens(tag);
      if (!rel.includes('stylesheet')) continue;
      const href = resolveUrl(attr(tag, 'href'), `${ORIGIN}/`);
      if (href) addPage(stylesheetPages, href, page);
    }
    for (const fontUrl of extractFontUrls(html, `${ORIGIN}/`)) addPage(fontPages, fontUrl, page);
  }

  const homepage = htmlBySnapshot.get('index.html') || '';
  if (!homepage) failures.push({ url: 'inventory/snapshots/index.html', status: 0, error: 'homepage snapshot missing' });
  const headerAt = homepage.search(/\bid=(?:"|')masthead(?:"|')/i);
  const headerHtml = headerAt >= 0 ? homepage.slice(headerAt, headerAt + 200000) : homepage;
  const logoUrls = [];
  const imgRe = /<img\b[^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRe.exec(headerHtml))) {
    const tag = imgMatch[0];
    if (!/\bcustom-logo\b/i.test(attr(tag, 'class'))) continue;
    const src = resolveUrl(attr(tag, 'src'), `${ORIGIN}/`);
    if (src && !logoUrls.includes(src)) logoUrls.push(src);
  }
  const iconUrls = [];
  const linkRe = /<link\b[^>]*>/gi;
  let linkMatch;
  while ((linkMatch = linkRe.exec(homepage))) {
    const tag = linkMatch[0];
    if (!relTokens(tag).includes('icon')) continue;
    const href = resolveUrl(attr(tag, 'href'), `${ORIGIN}/`);
    if (href && !iconUrls.includes(href)) iconUrls.push(href);
  }

  const usedNames = new Set();
  const saved = [];
  const googleMap = new Map();
  const otherCssUrls = new Set();
  const seenCss = new Set();
  const seenFonts = new Set();
  const cssQueue = [...stylesheetPages.keys()];

  function noteGoogle(url, pages) {
    if (!googleMap.has(url)) googleMap.set(url, new Set());
    for (const page of pages) googleMap.get(url).add(page);
  }

  async function saveBytes(dir, url, buffer, pages) {
    const name = allocateName(dir, url, usedNames);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, name);
    writeFileSync(filePath, buffer);
    const bytes = statSync(filePath).size;
    const folder = dir === CSS_DIR ? 'css' : dir === FONT_DIR ? 'fonts' : 'brand';
    saved.push({ file: `${folder}/${name}`, url, bytes, pages: [...pages].sort() });
    console.error(`saved ${folder}/${name} ${bytes}`);
  }

  while (cssQueue.length > 0) {
    const url = cssQueue.shift();
    if (seenCss.has(url)) continue;
    seenCss.add(url);
    const pages = pagesOf(stylesheetPages, url);
    if (isGoogleFont(url)) {
      noteGoogle(url, pages);
      console.error(`google stylesheet ${url}`);
      continue;
    }
    console.error(`css ${url}`);
    const result = await request(url, 'text/css,*/*;q=0.1');
    if (!result.ok) {
      recordFailure(url, result);
      console.error(`fail ${result.status} ${url}`);
      continue;
    }
    await saveBytes(CSS_DIR, url, result.buffer, pages);
    for (const found of extractCssUrls(result.text, url)) {
      if (isGoogleFont(found)) {
        noteGoogle(found, pages);
        continue;
      }
      if (isFontFile(found)) {
        for (const page of pages) addPage(fontPages, found, page);
        continue;
      }
      if (isStylesheetPath(found) || /\/css(\?|$)/i.test(found)) {
        for (const page of pages) addPage(stylesheetPages, found, page);
        if (!seenCss.has(found)) cssQueue.push(found);
        continue;
      }
      otherCssUrls.add(found);
    }
  }

  for (const url of fontPages.keys()) {
    if (seenFonts.has(url)) continue;
    seenFonts.add(url);
    const pages = pagesOf(fontPages, url);
    if (isGoogleFont(url)) {
      noteGoogle(url, pages);
      continue;
    }
    if (!isSite(url)) {
      otherCssUrls.add(url);
      continue;
    }
    console.error(`font ${url}`);
    const result = await request(url, '*/*');
    if (!result.ok) {
      recordFailure(url, result);
      console.error(`fail ${result.status} ${url}`);
      continue;
    }
    await saveBytes(FONT_DIR, url, result.buffer, pages);
  }

  async function saveBrand(url, pages) {
    console.error(`brand ${url}`);
    const result = await request(url, 'image/*,*/*;q=0.1');
    if (!result.ok) {
      recordFailure(url, result);
      console.error(`fail ${result.status} ${url}`);
      return;
    }
    await saveBytes(BRAND_DIR, url, result.buffer, pages);
  }

  for (const url of logoUrls) {
    const pages = htmlFiles.filter((filePath) => htmlBySnapshot.get(snapshotName(filePath)).includes(url)).map(snapshotName);
    await saveBrand(url, pages);
  }
  for (const url of iconUrls) {
    const pages = htmlFiles.filter((filePath) => htmlBySnapshot.get(snapshotName(filePath)).includes(url)).map(snapshotName);
    await saveBrand(url, pages);
  }

  const googleFonts = [...googleMap.entries()]
    .map(([url, pages]) => ({ url, pages: [...pages].sort() }))
    .sort((a, b) => a.url.localeCompare(b.url));
  saved.sort((a, b) => a.file.localeCompare(b.file));
  failures.sort((a, b) => a.url.localeCompare(b.url));
  writeManifest(saved, googleFonts, [...otherCssUrls].sort());
  console.error(`done css=${saved.filter((file) => file.file.startsWith('css/')).length} fonts=${saved.filter((file) => file.file.startsWith('fonts/')).length} brand=${saved.filter((file) => file.file.startsWith('brand/')).length} google=${googleFonts.length} failed=${failures.length} other=${otherCssUrls.size}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
