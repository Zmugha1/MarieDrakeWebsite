import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ORIGIN = 'https://thedrakelawfirm.com';
const ALLOWED_HOSTS = new Set(['thedrakelawfirm.com', 'www.thedrakelawfirm.com']);
const USER_AGENT = 'Dr. Data (MarieDrakeWebsite read-only public inventory)';
const GAP_MS = 300;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY_DIR = join(ROOT, 'inventory');

const errors = [];
let requestCount = 0;
let lastRequestFinishedAt = 0;

function assertSafeRestBase(restBase) {
  if (!/^[a-z0-9_-]+$/i.test(restBase)) {
    throw new Error(`Refusing unexpected rest_base: ${restBase}`);
  }
}

function toPublicUrl(raw) {
  try {
    const url = new URL(String(raw).trim());
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

function normUrl(raw) {
  const url = new URL(raw.trim());
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

function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
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
      .replace(/&nbsp;/g, ' ');
  }
  return out.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function extractLocs(xml) {
  const locs = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)\s*<\/loc>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const value = decodeXml(match[1].replace(/\]\]>$/, '').trim());
    if (value) locs.push(value);
  }
  return locs;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function robotsText(robots) {
  if (!robots) return '';
  if (typeof robots === 'string') return robots;
  if (typeof robots === 'object') return Object.values(robots).filter(Boolean).join('; ');
  return String(robots);
}

function yoastFields(item) {
  const yoast = item.yoast_head_json;
  if (!yoast || typeof yoast !== 'object') {
    return {
      yoast_title: '',
      yoast_description: '',
      yoast_canonical: '',
      yoast_robots: '',
    };
  }
  return {
    yoast_title: decodeText(yoast.title || ''),
    yoast_description: decodeText(yoast.description || yoast.og_description || ''),
    yoast_canonical: yoast.canonical || '',
    yoast_robots: robotsText(yoast.robots),
  };
}

function typeBlob(slug, info) {
  return [slug, info?.rest_base, info?.name, info?.slug, info?.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function isVideoFaqType(slug, info) {
  const blob = typeBlob(slug, info);
  const compact = blob.replace(/[^a-z0-9]+/g, '');
  return (blob.includes('video') && blob.includes('faq')) || compact.includes('videofaq') || compact.includes('faqvideo');
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
      signal: AbortSignal.timeout(45000),
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

function asTypeMap(data) {
  if (!data || typeof data !== 'object') return {};
  if (data.code && data.message) return {};
  if (Array.isArray(data)) {
    const map = {};
    for (const entry of data) {
      const slug = entry?.slug || entry?.name;
      if (slug) map[slug] = entry;
    }
    return map;
  }
  if (typeof data === 'object') return data;
  return {};
}

async function fetchCollection(restBase) {
  assertSafeRestBase(restBase);
  const items = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    if (page > 500) {
      errors.push(`Stopped ${restBase} at page 500`);
      break;
    }
    const url = `${ORIGIN}/wp-json/wp/v2/${restBase}?per_page=100&page=${page}&_fields=id,type,slug,link,title,date,modified,yoast_head_json`;
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

function recordApiItem(item, bucket) {
  const link = item.link || '';
  let key = '';
  try {
    key = link ? normUrl(link) : '';
  } catch {
    errors.push(`API item ${item.id} has an unreadable link: ${link}`);
    return;
  }
  if (!key) {
    errors.push(`API item ${item.id} has no link`);
    return;
  }
  const row = {
    id: item.id ?? '',
    type: item.type || '',
    slug: item.slug || '',
    link,
    title: decodeText(item.title?.rendered ?? item.title ?? ''),
    date: item.date || '',
    modified: item.modified || '',
    ...yoastFields(item),
    in_api: 'yes',
    in_sitemap: 'no',
    sitemap_file: '',
  };
  if (bucket.has(key)) {
    errors.push(`Duplicate API URL ${key} (ids ${bucket.get(key).id} and ${row.id})`);
    return;
  }
  bucket.set(key, row);
}

function sitemapStem(fileUrl) {
  try {
    const name = new URL(fileUrl).pathname.split('/').pop() || '';
    return name.replace(/-sitemap\d*\.xml$/i, '').replace(/\.xml$/i, '');
  } catch {
    return '';
  }
}

async function collectSitemaps() {
  const indexUrl = `${ORIGIN}/sitemap_index.xml`;
  const index = await getText(indexUrl, 'application/xml, text/xml');
  const pageUrls = [];
  if (!index.ok) {
    errors.push(`HTTP ${index.status} for sitemap_index.xml`);
    return pageUrls;
  }
  if (!/<sitemapindex[\s>]/i.test(index.text)) {
    errors.push('sitemap_index.xml was not a sitemap index');
  }

  const children = [...new Set(extractLocs(index.text))];
  const seenSitemaps = new Set();

  async function readSitemap(fileUrl, depth) {
    if (seenSitemaps.has(fileUrl)) return;
    seenSitemaps.add(fileUrl);
    if (depth > 3) {
      errors.push(`Sitemap nesting too deep at ${fileUrl}`);
      return;
    }
    const publicSitemap = toPublicUrl(fileUrl);
    if (!publicSitemap || !publicSitemap.toLowerCase().split('?')[0].endsWith('.xml')) {
      errors.push(`Skipped sitemap URL outside the public site map files: ${fileUrl}`);
      return;
    }
    const result = await getText(publicSitemap, 'application/xml, text/xml');
    if (!result.ok) {
      errors.push(`HTTP ${result.status} for ${fileUrl}`);
      return;
    }
    const locs = extractLocs(result.text);
    if (/<sitemapindex[\s>]/i.test(result.text)) {
      for (const child of locs) await readSitemap(child, depth + 1);
      return;
    }
    const fileName = new URL(fileUrl).pathname.split('/').pop();
    for (const loc of locs) {
      pageUrls.push({ loc, fileName, fileUrl });
    }
  }

  for (const child of children) await readSitemap(child, 1);
  return pageUrls;
}

function writeCsv(rows) {
  const headers = [
    'id',
    'type',
    'slug',
    'link',
    'title',
    'date',
    'modified',
    'yoast_title',
    'yoast_description',
    'yoast_canonical',
    'yoast_robots',
    'in_api',
    'in_sitemap',
    'sitemap_file',
  ];
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(','));
  }
  writeFileSync(join(INVENTORY_DIR, 'urls.csv'), `${lines.join('\n')}\n`, 'utf8');
}

function bulletList(items) {
  if (items.length === 0) return '- None.';
  return items.map((item) => `- ${item}`).join('\n');
}

function writeSummary(model) {
  const lines = [];
  lines.push('# Public URL inventory');
  lines.push('');
  lines.push(`Read-only check of ${ORIGIN} on ${model.generated}. No WordPress login. No page content exported.`);
  lines.push('');
  lines.push('## Post types exposed in the REST API');
  lines.push('');
  lines.push('| Type | rest_base | Name |');
  lines.push('| --- | --- | --- |');
  for (const entry of model.types) {
    lines.push(`| ${entry.slug} | ${entry.rest_base} | ${entry.name} |`);
  }
  if (model.types.length === 0) lines.push('| (none) |  |  |');
  lines.push('');
  lines.push('## Counts');
  lines.push('');
  lines.push('| Item | Count |');
  lines.push('| --- | --- |');
  lines.push(`| Pages | ${model.pageCount} |`);
  lines.push(`| Posts | ${model.postCount} |`);
  lines.push(`| Video FAQs | ${model.videoFaqCount} |`);
  lines.push(`| Sitemap URLs | ${model.sitemapCount} |`);
  lines.push(`| In sitemap but not in API | ${model.sitemapOnly.length} |`);
  lines.push(`| In API but not in sitemap | ${model.apiOnly.length} |`);
  lines.push('');
  lines.push('API counts cover pages, posts, and the video FAQ type when that type is exposed. Sitemap counts cover every URL in the public sitemap index.');
  lines.push('');
  lines.push('## Video FAQ type');
  lines.push('');
  lines.push(model.videoFaqNote);
  lines.push('');
  lines.push('## Post types not exposed in the API');
  lines.push('');
  if (model.unexposed.length === 0) {
    lines.push('None. Content sitemap names matched a public REST post type or a public taxonomy. Author archives in author-sitemap.xml are users, not a post type.');
  } else {
    lines.push(bulletList(model.unexposed));
  }
  lines.push('');
  lines.push('## In sitemap but not in API');
  lines.push('');
  if (model.sitemapOnly.length === 0) {
    lines.push('None.');
  } else {
    const groups = new Map();
    for (const row of model.sitemapOnly) {
      const key = row.sitemap_file || '(unknown sitemap)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row.link);
    }
    for (const [file, urls] of groups) {
      lines.push(`### ${file} (${urls.length})`);
      lines.push('');
      lines.push(bulletList(urls));
      lines.push('');
    }
  }
  lines.push('## In API but not in sitemap');
  lines.push('');
  lines.push(bulletList(model.apiOnly.map((row) => `${row.link} (${row.type})`)));
  lines.push('');
  lines.push('## Errors');
  lines.push('');
  lines.push(model.errors.length === 0 ? 'None.' : bulletList(model.errors));
  lines.push('');
  lines.push(`Requests sent: ${model.requestCount}. Wait between requests: ${GAP_MS} ms.`);
  lines.push('');
  writeFileSync(join(INVENTORY_DIR, 'summary.md'), lines.join('\n'), 'utf8');
}

async function main() {
  mkdirSync(INVENTORY_DIR, { recursive: true });
  const generated = new Date().toISOString();

  const typesResult = await getJson(`${ORIGIN}/wp-json/wp/v2/types`);
  const typeMap = typesResult.ok ? asTypeMap(typesResult.data) : {};
  if (!typesResult.ok) errors.push(`HTTP ${typesResult.status} for /wp-json/wp/v2/types`);

  const types = Object.entries(typeMap)
    .map(([slug, info]) => ({
      slug: info?.slug || slug,
      rest_base: info?.rest_base || '',
      name: decodeText(info?.name || slug),
      info,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const targets = [];
  const seenBases = new Set();
  function addTarget(kind, entry) {
    if (!entry?.rest_base || seenBases.has(entry.rest_base)) return;
    assertSafeRestBase(entry.rest_base);
    seenBases.add(entry.rest_base);
    targets.push({ kind, slug: entry.slug, rest_base: entry.rest_base });
  }

  for (const entry of types) {
    if (entry.slug === 'page' || entry.rest_base === 'pages') addTarget('page', entry);
    if (entry.slug === 'post' || entry.rest_base === 'posts') addTarget('post', entry);
    if (isVideoFaqType(entry.slug, entry.info)) addTarget('video_faq', entry);
  }

  const apiRows = new Map();
  const counts = { page: 0, post: 0, video_faq: 0 };
  let yoastMissing = 0;

  for (const target of targets) {
    const items = await fetchCollection(target.rest_base);
    counts[target.kind] += items.length;
    for (const item of items) {
      if (!item.yoast_head_json) yoastMissing += 1;
      recordApiItem(item, apiRows);
    }
  }

  const videoFaqTargets = targets.filter((target) => target.kind === 'video_faq');
  let videoFaqNote = 'The video FAQ type is not exposed in the REST API. No public type name, slug, or rest_base matched video and faq.';
  if (videoFaqTargets.length > 0) {
    videoFaqNote = `Exposed as ${videoFaqTargets.map((target) => `${target.slug} (rest_base \`${target.rest_base}\`)`).join(', ')}.`;
  }

  const taxResult = await getJson(`${ORIGIN}/wp-json/wp/v2/taxonomies`);
  const taxMap = taxResult.ok ? asTypeMap(taxResult.data) : {};
  if (!taxResult.ok) errors.push(`HTTP ${taxResult.status} for /wp-json/wp/v2/taxonomies`);
  const taxonomySlugs = new Set(Object.entries(taxMap).map(([slug, info]) => info?.slug || slug));

  const sitemapEntries = await collectSitemaps();
  const sitemapByKey = new Map();
  for (const entry of sitemapEntries) {
    let key = '';
    try {
      key = normUrl(entry.loc);
    } catch {
      errors.push(`Skipped unreadable sitemap URL: ${entry.loc}`);
      continue;
    }
    if (!sitemapByKey.has(key)) sitemapByKey.set(key, entry);
  }

  for (const [key, row] of apiRows) {
    const siteEntry = sitemapByKey.get(key);
    if (siteEntry) {
      row.in_sitemap = 'yes';
      row.sitemap_file = siteEntry.fileName;
    }
  }

  const sitemapOnly = [];
  for (const [key, entry] of sitemapByKey) {
    if (apiRows.has(key)) continue;
    sitemapOnly.push({
      id: '',
      type: '',
      slug: '',
      link: entry.loc,
      title: '',
      date: '',
      modified: '',
      yoast_title: '',
      yoast_description: '',
      yoast_canonical: '',
      yoast_robots: '',
      in_api: 'no',
      in_sitemap: 'yes',
      sitemap_file: entry.fileName,
    });
  }

  const apiOnly = [...apiRows.entries()]
    .filter(([, row]) => row.in_sitemap !== 'yes')
    .map(([, row]) => row);

  const exposedSlugs = new Set(types.map((entry) => entry.slug));
  const exposedBases = new Set(types.map((entry) => entry.rest_base));
  const sitemapFiles = [...new Set(sitemapEntries.map((entry) => entry.fileUrl))];
  const unexposed = [];
  const authorArchives = new Set(['author']);

  for (const fileUrl of [...new Set(sitemapEntries.map((entry) => entry.fileUrl))]) {
    const stem = sitemapStem(fileUrl);
    if (!stem) continue;
    if (exposedSlugs.has(stem) || exposedBases.has(stem) || taxonomySlugs.has(stem) || authorArchives.has(stem)) continue;
    const fileName = new URL(fileUrl).pathname.split('/').pop();
    const urls = sitemapEntries.filter((entry) => entry.fileUrl === fileUrl).map((entry) => entry.loc);
    const overlap = urls.filter((loc) => {
      try { return apiRows.has(normUrl(loc)); } catch { return false; }
    }).length;
    let probe = 'route not checked';
    if (/^[a-z0-9_-]+$/i.test(stem)) {
      const probeUrl = `${ORIGIN}/wp-json/wp/v2/${stem}?per_page=1&_fields=id`;
      const probeResult = await getJson(probeUrl);
      probe = probeResult.ok ? 'REST route responded' : `REST route HTTP ${probeResult.status}`;
      if (probeResult.ok) {
        videoFaqNote += ` Sitemap stem ${stem} answered the REST route even though it was missing from /types.`;
        continue;
      }
    }
    const overlapNote = urls.length > 0 && overlap === urls.length
      ? 'All of its URLs are already in the paged API set, so this looks like an extra sitemap (often a Yoast video sitemap) rather than a separate post type.'
      : `${overlap} of ${urls.length} URLs are already in the paged API set.`;
    unexposed.push(`${fileName}: no matching public post type or taxonomy. ${probe}. ${overlapNote}`);
  }

  if (yoastMissing > 0) {
    errors.push(`${yoastMissing} API items had no yoast_head_json`);
  }

  const rows = [...apiRows.values(), ...sitemapOnly].sort((a, b) => a.link.localeCompare(b.link));
  writeCsv(rows);

  const videoFaqCount = videoFaqTargets.length === 0 ? 'not exposed' : String(counts.video_faq);
  writeSummary({
    generated,
    types,
    pageCount: counts.page,
    postCount: counts.post,
    videoFaqCount,
    videoFaqNote,
    sitemapCount: sitemapByKey.size,
    sitemapOnly,
    apiOnly,
    unexposed,
    errors,
    requestCount,
  });

  console.log(JSON.stringify({
    pages: counts.page,
    posts: counts.post,
    videoFaqs: videoFaqCount,
    sitemapUrls: sitemapByKey.size,
    sitemapNotInApi: sitemapOnly.length,
    apiNotInSitemap: apiOnly.length,
    unexposed,
    errors,
    requests: requestCount,
    sitemapFiles: sitemapFiles.length,
    types: types.map((entry) => `${entry.slug}:${entry.rest_base}`),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
