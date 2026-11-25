// Turns the live site's per-page combined stylesheets into:
//   one shared stylesheet (rules used by any page, deduplicated, unused rules removed)
//   a small inline block per page (rules that only style that page's own Elementor ids)
import { readFileSync, readdirSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import postcss from 'postcss';
import { PurgeCSS } from 'purgecss';
import CleanCSS from 'clean-css';

const SAFE = [
  /^toggled$/, /-active$/, /^elementor-active$/, /expanded/, /-open$/,
  /^ast-(header|mobile|desktop|main|primary|builder|menu|nav|flyout|submenu|icon)/, /^menu-/, /^sub-menu/,
  /^elementor-(tab|accordion|video|custom-embed|open|fit-aspect)/,
  /^pojo-a11y/, /^pojo-sr-only$/, /^sr-only$/, /^screen-reader-text$/, /^ff-/, /^swiper-pagination-bullet/,
];

function manifestMap(root) {
  const text = readFileSync(join(root, 'inventory', 'design', 'manifest.md'), 'utf8');
  const map = new Map();
  const re = /^### (\S+)\s*\n+- Source: (\S+)/gm;
  let m;
  while ((m = re.exec(text))) map.set(m[2], m[1]);
  return map;
}

export async function buildCss(root, pages) {
  const design = join(root, 'inventory', 'design');
  const map = manifestMap(root);
  const byBase = new Map();
  for (const [src, file] of map) {
    const b = basename(src.split(/[?#]/)[0]);
    if (!byBase.has(b)) byBase.set(b, file);
  }
  const fontsOut = join(root, 'site', 'assets', 'fonts');
  mkdirSync(fontsOut, { recursive: true });

  const fixUrls = (css) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, q, u) => {
    if (u.startsWith('data:')) return all;
    const clean = u.split(/[?#]/)[0];
    const file = map.get(u) || map.get(clean) || byBase.get(basename(clean));
    if (file && file.startsWith('fonts/')) {
      const b = basename(file);
      if (!existsSync(join(fontsOut, b))) copyFileSync(join(design, file), join(fontsOut, b));
      return `url("/assets/fonts/${b}")`;
    }
    return `url("${u.replace(/https?:\/\/(www\.)?thedrakelawfirm\.com/gi, '')}")`;
  });

  // which stylesheet files each source snapshot used
  const cssCache = new Map();
  const loadFile = (url) => {
    if (cssCache.has(url)) return cssCache.get(url);
    const file = map.get(url) || map.get(url.split('?')[0]);
    const css = file && existsSync(join(design, file)) ? readFileSync(join(design, file), 'utf8') : '';
    cssCache.set(url, css);
    return css;
  };

  const shared = [];
  const seen = new Set();
  const pageRules = new Map();

  const take = (css, ownIds, path, allOwn = false) => {
    const tree = postcss.parse(fixUrls(css));
    tree.walkRules((rule) => {
      if (rule.parent.type === 'atrule' && /keyframes/i.test(rule.parent.name)) return;
      const wrap = rule.parent.type === 'atrule' ? `@${rule.parent.name} ${rule.parent.params}` : '';
      // Elementor's "hide title" page setting is written as a bare :root rule; it belongs to its page
      const own = allOwn || (rule.selector === ':root' && rule.toString().includes('--page-title-display')) || ownIds.some((id) => rule.selector.includes(`.elementor-${id} `) || rule.selector.includes(`.elementor-${id}.`) || rule.selector.endsWith(`.elementor-${id}`));
      const text = rule.toString();
      if (own) {
        if (!pageRules.has(path)) pageRules.set(path, []);
        pageRules.get(path).push({ wrap, text });
      } else {
        const key = wrap + '|' + text;
        if (!seen.has(key)) { seen.add(key); shared.push({ wrap, text }); }
      }
    });
    tree.walkAtRules((at) => {
      if (/^(font-face|keyframes|-webkit-keyframes)$/i.test(at.name)) {
        const text = at.toString();
        const key = '|' + text;
        if (!seen.has(key)) { seen.add(key); shared.push({ wrap: '', text }); }
      }
    });
  };

  // inline style blocks that repeat on many pages are shared; one-off blocks belong to their page
  const freq = new Map();
  for (const p of pages) for (const s of new Set(p.styles)) freq.set(s, (freq.get(s) || 0) + 1);
  const common = (s) => freq.get(s) > pages.length / 2;
  for (const p of pages) {
    const ids = [String(p.elementorId)];
    for (const url of p.cssUrls || []) take(loadFile(url), ids, p.item.path);
    for (const s of p.styles) if (s) take(s, ids, p.item.path, !common(s));
  }

  const join2 = (rules) => {
    let out = '';
    let open = '';
    for (const r of rules) {
      if (r.wrap !== open) {
        if (open) out += '}\n';
        if (r.wrap) out += r.wrap + '{\n';
        open = r.wrap;
      }
      out += r.text + '\n';
    }
    if (open) out += '}\n';
    return out;
  };

  const htmls = pages.map((p) => ({ raw: p.html, extension: 'html' }));
  const purger = new PurgeCSS();
  const [sharedPurged] = await purger.purge({ content: htmls, css: [{ raw: join2(shared) }], safelist: { standard: SAFE }, fontFace: false, keyframes: true });
  const pageCss = new Map();
  for (const p of pages) {
    const rules = pageRules.get(p.item.path);
    if (!rules) continue;
    const [r] = await new PurgeCSS().purge({ content: [{ raw: p.html, extension: 'html' }], css: [{ raw: join2(rules) }], safelist: { standard: SAFE } });
    const min = new CleanCSS({ level: 1 }).minify(r.css).styles;
    if (min) pageCss.set(p.item.path, min);
  }

  // keep only the @font-face rules for families some rule still uses
  const fam = (v) => v.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
  const used = new Set();
  const tree = postcss.parse(sharedPurged.css);
  const collect = (t) => t.walkDecls(/^font(-family)?$/, (d) => {
    if (d.parent.type === 'atrule' && d.parent.name === 'font-face') return;
    const v = d.prop === 'font' ? (d.value.match(/[^\s]*\s*["'][^"']+["']|[a-z ]+$/i) || [''])[0] : d.value;
    for (const part of v.split(',')) used.add(part.replace(/['"]/g, '').replace(/^.*\d(px|em|rem|%)\s*\/?[\d.]*\s*/, '').trim().toLowerCase());
  });
  collect(tree);
  for (const c of pageCss.values()) collect(postcss.parse(c));
  tree.walkAtRules('font-face', (at) => {
    let f = '';
    at.walkDecls('font-family', (d) => { f = fam(d.value); });
    let range = '';
    at.walkDecls('unicode-range', (d) => { range = d.value; });
    const western = !range || /^U\+(\?\?|0000-00FF|0-FF|100-2BA|0100-02)/i.test(range.trim());
    if (!used.has(f) || !western) at.remove();
  });
  const sharedCss = new CleanCSS({ level: 1 }).minify(tree.toString()).styles;
  const sizes = [...pageCss.values()].map((c) => c.length);
  const report = `Page CSS: ${pageCss.size} pages, largest ${(Math.max(0, ...sizes) / 1024).toFixed(1)} KB.`;
  return { sharedCss, pageCss, report };
}
