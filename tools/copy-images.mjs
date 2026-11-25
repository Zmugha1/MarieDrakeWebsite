import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const CSS_FILE = join(SITE, 'assets', 'site.css');
const BACKUP = 'C:\\Users\\zumah\\Drake_Backups\\2026-11-24\\uploads_extracted\\uploads';
const DEST_ROOT = join(SITE, 'wp-content', 'uploads');
const PREFIX = '/wp-content/uploads/';

function walkHtml(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'wp-content') continue;
      walkHtml(path, out);
    } else if (entry.name.toLowerCase().endsWith('.html')) {
      out.push(path);
    }
  }
  return out;
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?34;/g, '"')
    .replace(/&apos;|&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function toUploadPath(raw) {
  let text = decodeHtml(raw).trim().replace(/^['"]|['"]$/g, '');
  if (!text || text.startsWith('data:') || text.startsWith('blob:')) return '';
  let pathname = text;
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith('//')) {
      const url = new URL(text.startsWith('//') ? `https:${text}` : text);
      pathname = url.pathname;
    } else {
      pathname = text.split('#')[0].split('?')[0];
    }
  } catch {
    pathname = text.split('#')[0].split('?')[0];
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* keep the path if an escape is malformed */
  }
  if (!pathname.startsWith(PREFIX)) return '';
  const rest = pathname.slice(PREFIX.length);
  if (!rest || rest.split('/').some((part) => part === '' || part === '.' || part === '..')) return '';
  return `${PREFIX}${rest}`;
}

function addUrl(paths, raw) {
  const path = toUploadPath(raw);
  if (path) paths.add(path);
}

function addSrcset(paths, value) {
  for (const part of decodeHtml(value).split(',')) {
    const url = part.trim().split(/\s+/)[0];
    if (url) addUrl(paths, url);
  }
}

function collectFromHtml(text, paths) {
  const attrRe = /\b(src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  let match;
  while ((match = attrRe.exec(text))) {
    addUrl(paths, match[2] ?? match[3] ?? match[4] ?? '');
  }
  const srcsetRe = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  while ((match = srcsetRe.exec(text))) addSrcset(paths, match[1] ?? match[2] ?? '');
  collectUrls(text, paths);
}

function collectUrls(text, paths) {
  const urlRe = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let match;
  while ((match = urlRe.exec(text))) addUrl(paths, match[2]);
}

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function writeReport(found, copied, missing) {
  const total = copied.reduce((sum, file) => sum + file.bytes, 0);
  const largest = [...copied].sort((a, b) => b.bytes - a.bytes).slice(0, 20);
  const lines = [];
  lines.push('# Image copy');
  lines.push('');
  lines.push('Paths are unique `/wp-content/uploads/` references from `src`, `srcset`, `href`, `poster`, inline `style` `url()`, `<style>` blocks, and `site/assets/site.css`.');
  lines.push('');
  lines.push(`- Paths found: ${found.length}`);
  lines.push(`- Files copied: ${copied.length}`);
  lines.push(`- Total size copied: ${mb(total)} (${total} bytes)`);
  lines.push('');
  lines.push('## 20 largest files');
  lines.push('');
  if (largest.length === 0) {
    lines.push('None.');
  } else {
    for (const file of largest) lines.push(`- ${file.path} (${mb(file.bytes)}, ${file.bytes} bytes)`);
  }
  lines.push('');
  lines.push('## Paths not found in the backup');
  lines.push('');
  if (missing.length === 0) lines.push('None.');
  else for (const path of missing) lines.push(`- ${path}`);
  lines.push('');
  writeFileSync(join(ROOT, 'inventory', 'images-report.md'), lines.join('\n'), 'utf8');
}

function main() {
  const paths = new Set();
  for (const file of walkHtml(SITE)) collectFromHtml(readFileSync(file, 'utf8'), paths);
  collectUrls(readFileSync(CSS_FILE, 'utf8'), paths);

  const found = [...paths].sort();
  const copied = [];
  const missing = [];
  for (const uploadPath of found) {
    const rest = uploadPath.slice(PREFIX.length);
    const source = join(BACKUP, ...rest.split('/'));
    const destination = join(DEST_ROOT, ...rest.split('/'));
    try {
      const info = statSync(source);
      if (!info.isFile()) {
        missing.push(uploadPath);
        continue;
      }
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      copied.push({ path: uploadPath, bytes: statSync(destination).size });
    } catch {
      missing.push(uploadPath);
    }
  }
  writeReport(found, copied, missing);
  const total = copied.reduce((sum, file) => sum + file.bytes, 0);
  console.error(`found=${found.length} copied=${copied.length} missing=${missing.length} bytes=${total}`);
}

main();
