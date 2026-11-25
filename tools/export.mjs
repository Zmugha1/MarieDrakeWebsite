import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ORIGIN = 'https://thedrakelawfirm.com';
const ALLOWED_HOSTS = new Set(['thedrakelawfirm.com', 'www.thedrakelawfirm.com']);
const USER_AGENT = 'Dr. Data (MarieDrakeWebsite read-only content export)';
const GAP_MS = 300;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = join(ROOT, 'content');
const INVENTORY_DIR = join(ROOT, 'inventory');
const SNAPSHOT_DIR = join(INVENTORY_DIR, 'snapshots');
const UPLOADS_BACKUP = 'C:\\Users\\zumah\\Drake_Backups\\2026-11-24\\uploads_extracted\\uploads';
const KEEP_ALIMONY_ID = 10129;
const DUPLICATE_ALIMONY_ID = 1069;
const CONTENT_TYPES = [
  { type: 'page', restBase: 'pages' },
  { type: 'post', restBase: 'posts' },
  { type: 'video-faqs', restBase: 'video-faqs' },
];

const errors = [];
let requestCount = 0;
let lastRequestFinishedAt = 0;

function assertSafeRestBase(restBase) {
  if (!/^[a-z0-9_-]+$/i.test(restBase)) {
    throw new Error(`Refusing unexpected rest_base: ${restBase}`);
  }
}

function toPublicUrl(raw, base = ORIGIN) {
  try {
    const url = new URL(String(raw).trim(), base);
    const host = url.hostname.toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) return null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.protocol = 'https:';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function normUrl(raw, base = ORIGIN) {
  const url = new URL(String(raw).trim(), base);
  url.protocol = 'https:';
  url.hash = '';
  const host = url.hostname.toLowerCase();
  url.hostname = host === 'www.thedrakelawfirm.com' ? 'thedrakelawfirm.com' : host;
  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  return url.toString();
}

function decodeText(value) {
  let out = String(value ?? '');
  for (let i = 0; i < 2; i += 1) {
    out = out
      .replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#0?39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function linkPath(link) {
  const url = new URL(link);
  return url.pathname || '/';
}

function safeSlug(slug, id) {
  const cleaned = String(slug || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(cleaned)) {
    return `id-${id}`;
  }
  return cleaned;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      field = '';
      if (row.some((cell) => cell.length > 0)) rows.push(row);
      row = [];
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell.length > 0)) rows.push(row);
  }
  const [header, ...body] = rows;
  return body.map((cells) => {
    const record = {};
    header.forEach((name, index) => {
      record[name] = cells[index] ?? '';
    });
    return record;
  });
}

async function getText(url, accept, attempt = 1) {
  const publicUrl = toPublicUrl(url);
  if (!publicUrl) {
    throw new Error(`Refusing non-public or off-site URL: ${url}`);
  }
  const wait = Math.max(0, lastRequestFinishedAt + GAP_MS - Date.now());
  if (wait > 0) await delay(wait);

  requestCount += 1;
  let response;
  try {
    response = await fetch(publicUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(90000),
    });
  } finally {
    lastRequestFinishedAt = Date.now();
  }

  const finalHost = (() => {
    try { return new URL(response.url || publicUrl).hostname.toLowerCase(); } catch { return ''; }
  })();
  if (!ALLOWED_HOSTS.has(finalHost)) {
    throw new Error(`Redirect left thedrakelawfirm.com for ${finalHost || 'an unknown host'}`);
  }

  const text = await response.text();
  if ((response.status === 429 || response.status === 502 || response.status === 503) && attempt === 1) {
    errors.push(`HTTP ${response.status} for ${publicUrl}; waited and tried once more`);
    await delay(2000);
    return getText(publicUrl, accept, 2);
  }

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text,
    finalUrl: response.url || publicUrl,
  };
}

async function getJson(url) {
  const result = await getText(url, 'application/json');
  let data = null;
  try {
    data = JSON.parse(result.text);
  } catch {
    errors.push(`JSON parse failed for ${url} (HTTP ${result.status})`);
  }
  return { ...result, data };
}

async function fetchCollection(restBase, extraParams = '') {
  assertSafeRestBase(restBase);
  const items = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    if (page > 500) {
      errors.push(`Stopped ${restBase} at page 500`);
      break;
    }
    const url = `${ORIGIN}/wp-json/wp/v2/${restBase}?per_page=100&page=${page}${extraParams}`;
    console.error(`GET ${restBase} page ${page}`);
    const result = await getJson(url);
    if (!result.ok) {
      const code = result.data?.code || '';
      if (page > 1 && (result.status === 400 || code === 'rest_post_invalid_page_number')) break;
      errors.push(`HTTP ${result.status} for ${restBase} page ${page}${code ? ` (${code})` : ''}`);
      break;
    }
    const headerPages = Number(result.headers.get('x-wp-totalpages') || '1');
    if (Number.isFinite(headerPages) && headerPages > 0) totalPages = headerPages;
    if (!Array.isArray(result.data) || result.data.length === 0) break;
    items.push(...result.data);
    if (result.data.length < 100) break;
    page += 1;
  }

  return items;
}

function termList(item, taxonomy, idField) {
  const groups = item._embedded?.['wp:term'];
  if (Array.isArray(groups)) {
    const found = [];
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      for (const term of group) {
        if (!term || term.taxonomy !== taxonomy) continue;
        found.push({
          id: term.id ?? null,
          name: decodeText(term.name || ''),
          slug: term.slug || '',
        });
      }
    }
    if (found.length > 0 || groups.length > 0) return found;
  }
  const ids = Array.isArray(item[idField]) ? item[idField] : [];
  return ids.map((id) => ({ id, name: '', slug: '' }));
}

function featuredImageUrl(item) {
  const media = item._embedded?.['wp:featuredmedia'];
  if (!Array.isArray(media)) return '';
  for (const entry of media) {
    if (entry && typeof entry.source_url === 'string' && entry.source_url) return entry.source_url;
  }
  return '';
}

function yoastExport(item) {
  const yoast = item.yoast_head_json;
  if (!yoast || typeof yoast !== 'object') return null;
  const og = {};
  for (const [key, value] of Object.entries(yoast)) {
    if (key.startsWith('og_')) og[key] = value;
  }
  return {
    title: yoast.title || '',
    description: yoast.description || '',
    canonical: yoast.canonical || '',
    robots: yoast.robots ?? null,
    ...og,
    schema: yoast.schema ?? null,
  };
}

function contentRecord(item) {
  const link = item.link || '';
  return {
    id: item.id,
    slug: item.slug || '',
    link,
    path: link ? linkPath(link) : '',
    title: decodeText(item.title?.rendered ?? item.title ?? ''),
    date: item.date || '',
    modified: item.modified || '',
    status: item.status || '',
    parent: item.parent ?? 0,
    menu_order: item.menu_order ?? 0,
    template: item.template || '',
    categories: termList(item, 'category', 'categories'),
    tags: termList(item, 'post_tag', 'tags'),
    featured_image_url: featuredImageUrl(item),
    content: { rendered: item.content?.rendered || '' },
    excerpt: { rendered: item.excerpt?.rendered || '' },
    yoast_head_json: yoastExport(item),
  };
}

function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function snapshotPath(pathname) {
  if (pathname === '/' || pathname === '') return join(SNAPSHOT_DIR, 'index.html');
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  if (!trimmed || trimmed.includes('..') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new Error(`Refusing snapshot path: ${pathname}`);
  }
  return join(SNAPSHOT_DIR, `${trimmed}.html`);
}

function balancedElement(html, start, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'gi');
  re.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = re.exec(html))) {
    if (match[0].toLowerCase().startsWith(`</${tag}`)) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(start, match.index + match[0].length);
  }
  return '';
}

function parseMenu(ulHtml) {
  const openEnd = ulHtml.indexOf('>') + 1;
  const closeAt = ulHtml.toLowerCase().lastIndexOf('</ul>');
  const inner = ulHtml.slice(openEnd, closeAt);
  const tokenRe = /<li\b[^>]*>|<\/li>/gi;
  const top = [];
  let depth = 0;
  let start = -1;
  let match;
  while ((match = tokenRe.exec(inner))) {
    if (match[0].toLowerCase().startsWith('<li')) {
      if (depth === 0) start = match.index;
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        top.push(inner.slice(start, match.index + match[0].length));
        start = -1;
      }
    }
  }
  return top.map(parseMenuItem);
}

function parseMenuItem(liHtml) {
  const openEnd = liHtml.indexOf('>') + 1;
  const subAt = liHtml.toLowerCase().indexOf('<ul', openEnd);
  const head = subAt >= 0 ? liHtml.slice(openEnd, subAt) : liHtml;
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(head);
  let label = '';
  let url = '';
  if (anchor) {
    url = decodeText((anchor[1].match(/\bhref\s*=\s*["']([^"']*)["']/i) || [])[1] || '');
    label = decodeText(anchor[2].replace(/<[^>]+>/g, ' '));
  }
  let children = [];
  if (subAt >= 0) {
    const sub = balancedElement(liHtml, subAt, 'ul');
    if (sub) children = parseMenu(sub);
  }
  return { label, url, children };
}

function extractMenus(html) {
  const mainAt = html.indexOf('<ul id="ast-hf-menu-1"');
  if (mainAt < 0) {
    errors.push('Homepage snapshot has no desktop main menu (ast-hf-menu-1)');
  }
  const mainHtml = mainAt >= 0 ? balancedElement(html, mainAt, 'ul') : '';
  const footerAt = html.search(/<footer\b/i);
  const footer = footerAt >= 0 ? html.slice(footerAt) : '';
  const mainMarker = footer.indexOf('elementor-nav-menu--main');
  let footerHtml = '';
  if (mainMarker >= 0) {
    const rel = footer.slice(mainMarker);
    const ulRel = rel.search(/<ul\b[^>]*elementor-nav-menu/i);
    if (ulRel >= 0) footerHtml = balancedElement(footer, mainMarker + ulRel, 'ul');
  }
  if (!footerHtml) errors.push('Homepage snapshot has no Elementor footer menu');
  return {
    source: `${ORIGIN}/`,
    main: mainHtml ? parseMenu(mainHtml) : [],
    footer: footerHtml ? parseMenu(footerHtml) : [],
  };
}

function addImageUse(map, rawUrl, usedBy) {
  if (!rawUrl || rawUrl.startsWith('data:')) return;
  const absolute = toPublicUrl(rawUrl, ORIGIN) || (() => {
    try {
      const url = new URL(rawUrl, ORIGIN);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      url.hash = '';
      return url.toString();
    } catch {
      return '';
    }
  })();
  if (!absolute) return;
  let key;
  try {
    const url = new URL(absolute);
    url.hash = '';
    url.search = '';
    key = url.toString();
  } catch {
    return;
  }
  const pathname = new URL(key).pathname;
  const marker = '/wp-content/uploads/';
  const at = pathname.indexOf(marker);
  let uploadsPath = '';
  if (at >= 0) {
    uploadsPath = decodeURIComponent(pathname.slice(at + marker.length)).replace(/^\/+/, '');
    if (uploadsPath.includes('..')) uploadsPath = '';
  }
  const looksLikeImage = /\.(avif|gif|jpe?g|png|svg|webp|ico|bmp)(\s|$)/i.test(pathname)
    || Boolean(uploadsPath);
  if (!looksLikeImage) return;
  if (!map.has(key)) map.set(key, { url: key, uploads_path: uploadsPath, used_by: new Set() });
  const entry = map.get(key);
  if (!entry.uploads_path && uploadsPath) entry.uploads_path = uploadsPath;
  if (usedBy) entry.used_by.add(usedBy);
}

function collectImages(map, record) {
  const html = `${record.content.rendered}\n${record.excerpt.rendered}`;
  const attrRe = /\b(?:src|data-src|data-lazy-src|data-orig-file|data-large_image|poster)\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = attrRe.exec(html))) addImageUse(map, match[1], record.path);
  const srcsetRe = /\bsrcset\s*=\s*["']([^"']+)["']/gi;
  while ((match = srcsetRe.exec(html))) {
    for (const part of match[1].split(',')) {
      const url = part.trim().split(/\s+/)[0];
      if (url) addImageUse(map, url, record.path);
    }
  }
  const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  while ((match = urlRe.exec(html))) addImageUse(map, match[1], record.path);
  if (record.featured_image_url) addImageUse(map, record.featured_image_url, record.path);
}

function taxonomyRecord(item) {
  return {
    id: item.id,
    name: decodeText(item.name || ''),
    slug: item.slug || '',
    link: item.link || '',
    count: item.count ?? 0,
  };
}

function mediaRecord(item) {
  const source = item.source_url || '';
  let uploadsPath = '';
  try {
    const pathname = new URL(source, ORIGIN).pathname;
    const marker = '/wp-content/uploads/';
    const at = pathname.indexOf(marker);
    if (at >= 0) uploadsPath = decodeURIComponent(pathname.slice(at + marker.length)).replace(/^\/+/, '');
  } catch {
    uploadsPath = '';
  }
  return {
    id: item.id,
    source_url: source,
    path: uploadsPath,
    alt_text: item.alt_text || '',
    width: item.media_details?.width ?? null,
    height: item.media_details?.height ?? null,
    mime_type: item.mime_type || '',
  };
}

function redirectTargetsOutside(csvLinks) {
  const known = new Set();
  for (const link of csvLinks) {
    if (!link) continue;
    try { known.add(normUrl(link)); } catch { /* skip unreadable inventory links */ }
  }
  const file = JSON.parse(readFileSync(join(INVENTORY_DIR, 'redirects.json'), 'utf8'));
  const outside = [];
  for (const redirect of file.redirects || []) {
    const target = redirect.action_data?.url || '';
    let normalized = '';
    let readable = true;
    try {
      normalized = normUrl(target || ' ', ORIGIN);
    } catch {
      readable = false;
    }
    if (!readable || !known.has(normalized)) {
      outside.push({
        source: redirect.url || '',
        target,
        code: redirect.action_code ?? '',
      });
    }
  }
  return outside;
}

function imageFileReport(images) {
  const foundPaths = new Map();
  const missing = [];
  let outsideUploads = 0;
  for (const image of images) {
    if (!image.uploads_path) {
      outsideUploads += 1;
      continue;
    }
    const filePath = join(UPLOADS_BACKUP, ...image.uploads_path.split('/'));
    try {
      const info = statSync(filePath);
      if (info.isFile()) {
        if (!foundPaths.has(image.uploads_path)) foundPaths.set(image.uploads_path, info.size);
        continue;
      }
    } catch {
      /* missing */
    }
    missing.push(image);
  }
  let bytes = 0;
  for (const size of foundPaths.values()) bytes += size;
  return {
    foundFiles: foundPaths.size,
    bytes,
    missing,
    outsideUploads,
  };
}

function bulletList(items) {
  if (items.length === 0) return '- None.';
  return items.map((item) => `- ${item}`).join('\n');
}

function writeNotes(duplicateSeen, outsideRedirects) {
  const lines = [];
  lines.push('# Export notes');
  lines.push('');
  lines.push('## Duplicate page');
  lines.push('');
  if (duplicateSeen) {
    lines.push(`Kept page ${KEEP_ALIMONY_ID} for https://thedrakelawfirm.com/colorado/alimony/. Page ${DUPLICATE_ALIMONY_ID} is a duplicate of that URL and was not exported.`);
  } else {
    lines.push(`Page ${KEEP_ALIMONY_ID} is the /colorado/alimony record in the export. Page ${DUPLICATE_ALIMONY_ID} was not returned by the public API during this run, so it was not saved.`);
  }
  lines.push('');
  lines.push('## Redirect targets not in urls.csv');
  lines.push('');
  if (outsideRedirects.length === 0) {
    lines.push('None. Every redirect target matches a URL in inventory/urls.csv.');
  } else {
    lines.push(`${outsideRedirects.length} redirect target${outsideRedirects.length === 1 ? '' : 's'} are not in inventory/urls.csv.`);
    lines.push('');
    for (const redirect of outsideRedirects) {
      lines.push(`- \`${redirect.source}\` (${redirect.code}) -> \`${redirect.target}\``);
    }
  }
  lines.push('');
  lines.push('## HTML snapshot for /colorado/');
  lines.push('');
  lines.push('The public URL /colorado/ returns 307 to /. inventory/snapshots/colorado.html is the homepage HTML that response leads to. The API page content is kept in content/page/colorado.json (id 9390).');
  lines.push('');
  writeFileSync(join(INVENTORY_DIR, 'notes.md'), lines.join('\n'), 'utf8');
}

function writeSummary(model) {
  const mb = model.imageBytes / (1024 * 1024);
  const lines = [];
  lines.push('# Content export');
  lines.push('');
  lines.push(`Read-only export of ${ORIGIN} on ${model.generated}. No WordPress login. No changes to the live site. Images were not copied into the repo.`);
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  lines.push('| Type | Count |');
  lines.push('| --- | ---: |');
  lines.push(`| Pages | ${model.counts.page} |`);
  lines.push(`| Posts | ${model.counts.post} |`);
  lines.push(`| Video FAQs | ${model.counts['video-faqs']} |`);
  lines.push(`| Categories | ${model.counts.categories} |`);
  lines.push(`| Tags | ${model.counts.tags} |`);
  lines.push(`| Media | ${model.counts.media} |`);
  lines.push(`| Page HTML snapshots | ${model.snapshotCounts.page} |`);
  lines.push(`| Sample post HTML snapshots | ${model.snapshotCounts.post} |`);
  lines.push(`| Sample video FAQ HTML snapshots | ${model.snapshotCounts['video-faqs']} |`);
  lines.push('');
  lines.push('Page HTML covers each unique page URL in inventory/urls.csv. The public API also returns page 1069 for /colorado/alimony, which is the same URL as page 10129, so it does not add a second snapshot.');
  lines.push('');
  lines.push('## Sample HTML');
  lines.push('');
  lines.push(bulletList(model.samples.map((sample) => `${sample.type}: ${sample.path}`)));
  lines.push('');
  lines.push('## Images');
  lines.push('');
  lines.push(`Image URLs used by content: ${model.imageCount}.`);
  lines.push(`Unique uploads files found in \`${UPLOADS_BACKUP}\`: ${model.foundFiles}.`);
  lines.push(`Total size of those files: ${model.imageBytes} bytes (${mb.toFixed(2)} MB).`);
  lines.push(`Image URLs that are not under /wp-content/uploads/: ${model.outsideUploads}.`);
  lines.push('');
  lines.push('### Used uploads images missing from the backup folder');
  lines.push('');
  if (model.missing.length === 0) {
    lines.push('None.');
  } else {
    lines.push(bulletList(model.missing.map((image) => `${image.uploads_path} (${image.url})`)));
  }
  lines.push('');
  lines.push('## Errors');
  lines.push('');
  lines.push(model.errors.length === 0 ? 'None.' : bulletList(model.errors));
  lines.push('');
  lines.push(`Requests sent: ${model.requestCount}. Wait between requests: ${GAP_MS} ms.`);
  lines.push('');
  writeFileSync(join(INVENTORY_DIR, 'export-summary.md'), lines.join('\n'), 'utf8');
}

async function main() {
  const generated = new Date().toISOString();
  const csv = parseCsv(readFileSync(join(INVENTORY_DIR, 'urls.csv'), 'utf8'));
  const wanted = new Map();
  for (const type of CONTENT_TYPES) wanted.set(type.type, new Map());
  for (const row of csv) {
    if (!wanted.has(row.type) || !row.id) continue;
    wanted.get(row.type).set(Number(row.id), row);
  }

  const counts = { page: 0, post: 0, 'video-faqs': 0, categories: 0, tags: 0, media: 0 };
  const savedIds = { page: new Set(), post: new Set(), 'video-faqs': new Set() };
  const usedFiles = new Set();
  const imageMap = new Map();
  const savedRecords = [];
  let duplicateSeen = false;

  for (const target of CONTENT_TYPES) {
    const items = await fetchCollection(target.restBase, '&_embed');
    const byId = wanted.get(target.type);
    for (const item of items) {
      const id = Number(item.id);
      if (target.type === 'page' && id === DUPLICATE_ALIMONY_ID) {
        duplicateSeen = true;
        const path = item.link ? linkPath(item.link) : '';
        if (path.replace(/\/+$/, '') !== '/colorado/alimony') {
          errors.push(`Page ${DUPLICATE_ALIMONY_ID} link was ${item.link}, expected /colorado/alimony/`);
        }
        continue;
      }
      if (!byId.has(id)) {
        errors.push(`API ${target.type} ${id} is not in urls.csv and was not exported`);
        continue;
      }
      if (target.type === 'page' && id === KEEP_ALIMONY_ID) {
        const path = item.link ? linkPath(item.link) : '';
        if (path.replace(/\/+$/, '') !== '/colorado/alimony') {
          errors.push(`Page ${KEEP_ALIMONY_ID} link was ${item.link}, expected /colorado/alimony/`);
        }
      }
      const record = contentRecord(item);
      let fileSlug = safeSlug(record.slug, record.id);
      if (fileSlug !== record.slug) {
        errors.push(`Slug ${record.slug || '(empty)'} for ${target.type} ${record.id} was stored as ${fileSlug}`);
      }
      let filePath = join(CONTENT_DIR, target.type, `${fileSlug}.json`);
      if (usedFiles.has(filePath)) {
        fileSlug = `${fileSlug}-${record.id}`;
        filePath = join(CONTENT_DIR, target.type, `${fileSlug}.json`);
        errors.push(`Duplicate slug file for ${target.type} ${record.id}; stored as ${fileSlug}.json`);
      }
      usedFiles.add(filePath);
      writeJson(filePath, record);
      counts[target.type] += 1;
      savedIds[target.type].add(id);
      savedRecords.push({ type: target.type, ...record });
      collectImages(imageMap, record);
    }
    for (const id of byId.keys()) {
      if (!savedIds[target.type].has(id)) {
        errors.push(`urls.csv ${target.type} ${id} was not returned by the API`);
      }
    }
  }

  const categories = (await fetchCollection('categories')).map(taxonomyRecord);
  const tags = (await fetchCollection('tags')).map(taxonomyRecord);
  counts.categories = categories.length;
  counts.tags = tags.length;
  writeJson(join(CONTENT_DIR, 'taxonomies.json'), { categories, tags });

  const media = (await fetchCollection('media', '&_fields=id,source_url,alt_text,mime_type,media_details')).map(mediaRecord);
  counts.media = media.length;
  writeJson(join(CONTENT_DIR, 'media.json'), media);

  const samples = [];
  for (const row of csv) {
    if (row.type === 'post' && samples.filter((item) => item.type === 'post').length < 3 && row.link) {
      samples.push({ type: 'post', link: row.link, path: linkPath(row.link) });
    }
    if (row.type === 'video-faqs' && samples.filter((item) => item.type === 'video-faqs').length < 2 && row.link) {
      samples.push({ type: 'video-faqs', link: row.link, path: linkPath(row.link) });
    }
  }
  const pageRows = csv.filter((row) => row.type === 'page' && row.link);
  const snapshotCounts = { page: 0, post: 0, 'video-faqs': 0 };
  const htmlJobs = [
    ...pageRows.map((row) => ({ type: 'page', link: row.link, path: linkPath(row.link) })),
    ...samples,
  ];
  let homepageHtml = '';
  for (const job of htmlJobs) {
    console.error(`HTML ${job.path}`);
    const result = await getText(job.link, 'text/html');
    if (!result.ok) {
      errors.push(`HTTP ${result.status} for HTML ${job.link}`);
      continue;
    }
    const filePath = snapshotPath(job.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, result.text, 'utf8');
    snapshotCounts[job.type] += 1;
    if (job.path === '/') homepageHtml = result.text;
  }
  if (!homepageHtml) errors.push('Homepage HTML was not saved, so menus were not extracted');
  const menus = homepageHtml ? extractMenus(homepageHtml) : { source: `${ORIGIN}/`, main: [], footer: [] };
  writeJson(join(CONTENT_DIR, 'menus.json'), menus);

  const images = [...imageMap.values()]
    .map((image) => ({
      url: image.url,
      uploads_path: image.uploads_path,
      used_by: [...image.used_by].sort(),
    }))
    .sort((a, b) => a.url.localeCompare(b.url));
  writeJson(join(CONTENT_DIR, 'images-used.json'), images);

  const fileReport = imageFileReport(images);
  const outsideRedirects = redirectTargetsOutside(csv.map((row) => row.link));
  writeNotes(duplicateSeen, outsideRedirects);
  writeSummary({
    generated,
    counts,
    snapshotCounts,
    samples,
    imageCount: images.length,
    foundFiles: fileReport.foundFiles,
    imageBytes: fileReport.bytes,
    outsideUploads: fileReport.outsideUploads,
    missing: fileReport.missing,
    errors,
    requestCount,
  });

  console.error(`Done. requests=${requestCount} pages=${counts.page} posts=${counts.post} video-faqs=${counts['video-faqs']} images=${images.length} missing=${fileReport.missing.length} redirect-outside=${outsideRedirects.length} errors=${errors.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
