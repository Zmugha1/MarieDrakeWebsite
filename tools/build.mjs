// Builds the static site in site/ from content/ and inventory/snapshots/.
// Pages reuse their saved live HTML, cleaned of WordPress, plugin code and scripts.
// Posts and video FAQs use the saved sample of their template with their own content.
// Run: node tools/build.mjs

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { buildCss } from './lib/css.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = join(ROOT, 'inventory', 'snapshots');
const CONTENT = join(ROOT, 'content');
const SITE = join(ROOT, 'site');
const ORIGIN = 'https://thedrakelawfirm.com';
const POST_SAMPLE = '3-myths-regarding-alimony-in-colorado.html';
const FAQ_SAMPLE = 'video-faqs/addressing-missing-child-support-payments.html';
const ONLY = process.argv.slice(2);
// Staging is the default: no analytics, and every page tells search engines not to index it.
// Only SITE_MODE=production builds the public site.
const PRODUCTION = process.env.SITE_MODE === 'production'; // optional list of paths to build, for quick checks

const read = (p) => readFileSync(p, 'utf8');
const json = (p) => JSON.parse(read(p));

function loadItems() {
  const items = [];
  for (const type of ['page', 'post', 'video-faqs']) {
    const dir = join(CONTENT, type);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const d = json(join(dir, f));
      d.type = type;
      items.push(d);
    }
  }
  return items;
}

function snapshotFile(path) {
  if (path === '/') return join(SNAP, 'index.html');
  return join(SNAP, path.replace(/^\/|\/$/g, '') + '.html');
}

const localUrl = (u) => (u || '').replace(/^https?:\/\/(www\.)?thedrakelawfirm\.com/i, '') || '/';

// ---------- cleaning ----------

const DROP_ATTRS = /^(data-(eae|id$|e-type|elementor-(post-type|type|id)|form_instance|recptcha_key|form_id|name|type|swiper|ti-|wpel|lazy)|aria-invalid$)/;

function cleanDoc($, styles) {
  $('script').each((_, el) => {
    if ($(el).attr('type') !== 'application/ld+json') $(el).remove();
  });
  $('noscript, link, meta[name=generator]').remove();
  $('body style, #page style').each((_, el) => {
    styles.push($(el).html());
    $(el).remove();
  });
  $('.pojo-a11y-toolbar, #pojo-a11y-toolbar, .pojo-skip-link').remove();
  $('[class]').each((_, el) => {
    const c = $(el).attr('class').split(/\s+/).filter((x) => x && x !== 'has_eae_slider' && x !== 'ff-form-loading');
    $(el).attr('class', c.join(' '));
  });
  $('*').each((_, el) => {
    for (const a of Object.keys(el.attribs || {})) {
      if (DROP_ATTRS.test(a)) $(el).removeAttr(a);
    }
  });
  // video widgets: keep the YouTube address the plugin kept in data-settings
  $('[data-settings]').each((_, el) => {
    const s = $(el).attr('data-settings');
    const m = s && s.match(/youtube_url&quot;:&quot;([^&]+)|"youtube_url":"([^"]+)"/);
    if (m) $(el).attr('data-video', (m[1] || m[2]).replace(/\\\//g, '/'));
    $(el).removeAttr('data-settings');
  });
  // links and media on our own domain become root-relative
  for (const a of ['href', 'src', 'srcset', 'action', 'poster']) {
    $(`[${a}]`).each((_, el) => {
      $(el).attr(a, $(el).attr(a).replace(/https?:\/\/(www\.)?thedrakelawfirm\.com(?=\/|$)/gi, ''));
    });
  }
  $('[style*="thedrakelawfirm.com"]').each((_, el) => {
    $(el).attr('style', $(el).attr('style').replace(/https?:\/\/(www\.)?thedrakelawfirm\.com/gi, ''));
  });
  convertForms($);
}

// Fluent Forms become Netlify forms with the same fields and look.
function convertForms($) {
  $('form.frm-fluent-form').each((_, el) => {
    const f = $(el);
    const id = (f.attr('id') || '').replace('fluentform_', '') || 'x';
    const name = `contact-form-${id}`;
    f.attr({ name, method: 'POST', action: '/thank-you/', 'data-netlify': 'true', 'netlify-honeypot': 'company' });
    f.find('input[name^="_"], input[name="__fluent_form_embded_post_id"], input[name="submission_date"]').remove();
    f.prepend(`<input type="hidden" name="form-name" value="${name}"><p hidden><label>Leave empty <input name="company"></label></p><input type="hidden" name="page" value="">`);
    f.find('[aria-required]').attr('required', '');
  });
}

// ---------- head ----------

function headFrom($, item) {
  const keep = [];
  const title = $('head title').first().text();
  for (const sel of ['meta[name=description]', 'meta[name=robots]', 'link[rel=canonical]', 'meta[property^="og:"]', 'meta[name^="twitter:"]', 'meta[property^="article:"]', 'meta[name^="geo."]', 'meta[name=ICBM]', 'meta[name^="DC."]']) {
    $(`head ${sel}`).each((_, el) => keep.push($.html(el)));
  }
  $('head script[type="application/ld+json"]').each((_, el) => keep.push($.html(el)));
  return { title, meta: keep.map((h) => h.replace(/https?:\/\/(www\.)?thedrakelawfirm\.com/gi, ORIGIN)).join('\n') };
}

// ---------- templates for posts and video FAQs ----------

function fillSingle($, item, sample) {
  const title = cheerio.load(item.title || '').text();
  $('.elementor-widget-theme-post-title .elementor-heading-title, .elementor-location-single h1.elementor-heading-title').first().text(title);
  const body = $('.elementor-widget-theme-post-content .elementor-widget-container').first();
  body.html(item.content.rendered);
  // hero background is the featured image
  $('style').each((_, el) => {
    const css = $(el).html();
    if (css && /background-image:url\(/.test(css) && css.includes('.elementor-' + sample)) {
      $(el).html(css.replace(/background-image:url\("[^"]*"\)/, item.featured_image_url ? `background-image:url("${item.featured_image_url}")` : 'background-image:none'));
    }
  });
  // head comes from the item's own Yoast data, not the sample
  $('head title, head meta, head link[rel=canonical], head script[type="application/ld+json"]').remove();
  const y = item.yoast_head_json || {};
  const head = [];
  head.push(`<title>${y.title || title}</title>`);
  if (y.description) head.push(`<meta name="description" content="${attr(y.description)}">`);
  if (y.robots) head.push(`<meta name="robots" content="${Object.values(y.robots).join(', ')}">`);
  head.push(`<link rel="canonical" href="${y.canonical || ORIGIN + item.path}">`);
  for (const [k, v] of Object.entries({ 'og:locale': y.og_locale, 'og:type': y.og_type, 'og:title': y.og_title, 'og:description': y.og_description, 'og:url': y.og_url, 'og:site_name': y.og_site_name, 'article:published_time': y.article_published_time, 'article:modified_time': y.article_modified_time })) {
    if (v) head.push(`<meta property="${k}" content="${attr(v)}">`);
  }
  if (y.og_image?.[0]?.url) head.push(`<meta property="og:image" content="${y.og_image[0].url}">`);
  if (y.twitter_card) head.push(`<meta name="twitter:card" content="${y.twitter_card}">`);
  if (y.schema) head.push(`<script type="application/ld+json">${JSON.stringify(y.schema)}</script>`);
  $('head').append(head.join('\n'));
}

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Previous and next post links, by date, like the live template.
function fillNav($, item, siblings) {
  const i = siblings.findIndex((s) => s.id === item.id);
  const prev = siblings[i + 1];
  const next = siblings[i - 1];
  const nav = $('.elementor-widget-post-navigation');
  if (!nav.length) return;
  const set = (cls, it) => {
    const a = nav.find(`.elementor-post-navigation__${cls} a`);
    if (!it) { nav.find(`.elementor-post-navigation__${cls}`).empty(); return; }
    a.attr('href', it.path);
    a.find('.elementor-post-navigation__link__' + cls + '--title, .post-navigation__' + cls + '--title').text(cheerio.load(it.title).text());
  };
  set('prev', prev);
  set('next', next);
}

// Blog and News list pages: WordPress served /blog/page/2/ and so on from the same
// page. The saved page 1 is the template; later pages get their own cards and links.
const LISTINGS = { '/blog/': 'blog', '/news/': 'news' };

function excerptText(item) {
  const t = cheerio.load(item.excerpt?.rendered || '').text().replace(/\[(&hellip;|…)\]|\s+/g, ' ').trim();
  const words = t.split(' ').slice(0, 25).join(' ');
  return ' ' + words + ' ...';
}

function pageLinks(base, cur, total) {
  const url = (n) => (n === 1 ? base : `${base}page/${n}/`);
  const out = [];
  if (cur > 1) out.push(`<a class="prev page-numbers" href="${url(cur - 1)}">&laquo; Previous</a>`);
  let dots = false;
  for (let n = 1; n <= total; n++) {
    if (n === cur) { out.push(`<span aria-current="page" class="page-numbers current">${n}</span>`); dots = false; }
    else if (n <= 1 || n > total - 1 || Math.abs(n - cur) <= 2) { out.push(`<a class="page-numbers" href="${url(n)}">${n}</a>`); dots = false; }
    else if (!dots) { out.push('<span class="page-numbers dots">&hellip;</span>'); dots = true; }
  }
  if (cur < total) out.push(`<a class="next page-numbers" href="${url(cur + 1)}">Next &raquo;</a>`);
  return out.join(' ');
}

function fillListing($, base, cur, total, posts) {
  const w = $('.elementor-widget-uael-posts').filter((_, el) => $(el).find('.uael-grid-pagination').length).first();
  const cards = w.find('.uael-post-wrapper');
  const withImg = cards.filter((_, c) => $(c).find('.uael-post__thumbnail').length).first();
  const tpl = $.html(withImg.length ? withImg : cards.first());
  const inner = cards.first().parent();
  cards.remove();
  for (const p of posts) {
    const c = $(tpl);
    const title = cheerio.load(p.title).text();
    c.find('a').attr('href', ORIGIN + p.path);
    c.find('.uael-post__thumbnail a').attr('title', title);
    c.find('.uael-post__title a').text(' ' + title + ' ');
    c.find('.uael-post__excerpt').text(excerptText(p));
    const d = new Date(p.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
    c.find('.uael-post__date').html(`<i aria-hidden="true" class="fa fa-calendar"></i> ${d} `);
    c.find('.uael-post__read-more').attr('aria-labelledby', 'uael-post-' + p.id);
    c.find('.uael-post__read-more .elementor-button-text').attr('id', 'uael-post-' + p.id);
    if (p.featured_image_url) c.find('.uael-post__thumbnail img').attr({ src: p.featured_image_url, width: null, height: null, srcset: null, sizes: null, fetchpriority: null });
    else c.find('.uael-post__thumbnail').remove();
    inner.append(c);
  }
  w.find('.uael-grid-pagination').html(' ' + pageLinks(ORIGIN + base, cur, total)).attr({ 'data-total': total, 'data-next-page': cur + 1 });
}

// ---------- page assembly ----------

function render(item, ctx, listing) {
  let file = snapshotFile(listing ? listing.base : item.path);
  let sample = null;
  if (item.type !== 'page') {
    file = join(SNAP, item.type === 'post' ? POST_SAMPLE : FAQ_SAMPLE);
    sample = item.type === 'post' ? '932' : '6209';
  }
  if (!existsSync(file)) return { error: `no snapshot for ${item.path}` };
  const $ = cheerio.load(read(file));
  if (sample) {
    fillSingle($, item, sample);
    fillNav($, item, item.type === 'post' ? ctx.posts : ctx.faqs);
  }
  if (listing) fillListing($, listing.base, listing.n, listing.total, listing.posts);
  const cssUrls = $('link[rel=stylesheet]').map((_, el) => $(el).attr('href')).get();
  const head = headFrom($, item);
  if (listing) {
    const suffix = ` - Page ${listing.n} of ${listing.total}`;
    head.title = head.title.replace(/^(.*?)( [-|] [^-|]*)?$/, (all, a, b) => a + suffix + (b || ''));
    head.meta = head.meta
      .replace(/(<link rel="canonical" href=")[^"]*/, `$1${ORIGIN}${item.path}`)
      .replace(/(<meta property="og:url" content=")[^"]*/, `$1${ORIGIN}${item.path}`)
      .replace(/(<meta property="og:title" content=")([^"]*)/, (all, a, b) => a + b + suffix);
  }
  const styles = [];
  $('head style').each((_, el) => styles.push($(el).html()));
  const bodyClass = ($('body').attr('class') || '').split(/\s+/).filter((c) => /^(ast-|elementor-|page|single|wp-child|wp-theme|home|blog|post|archive|ehf)/.test(c)).join(' ');
  cleanDoc($, styles);
  const body = $('#page').length ? $.html($('#page')) : $('body').html();
  const html = `<!doctype html>
<html lang="en-US">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${head.title.replace(/&(?!amp;|#|[a-z]+;)/g, '&amp;')}</title>
${head.meta}
<link rel="icon" href="/wp-content/uploads/2021/12/Group-2316.png">
<link rel="stylesheet" href="/assets/site.css">
<!--PAGE-CSS-->
<!--ANALYTICS-HEAD-->
</head>
<body class="${bodyClass}">
<!--ANALYTICS-BODY-->
<a class="skip-link screen-reader-text" href="#content">Skip to content</a>
${body}
<!--A11Y-->
<script src="/assets/site.js" defer></script>
</body>
</html>
`;
  return { html, styles, cssUrls, elementorId: item.id };
}

// ---------- main ----------

const items = loadItems();
const byDate = (a, b) => (a.date < b.date ? 1 : -1);
const ctx = {
  posts: items.filter((i) => i.type === 'post').sort(byDate),
  faqs: items.filter((i) => i.type === 'video-faqs').sort(byDate),
};
const todo = ONLY.length ? items.filter((i) => ONLY.includes(i.path)) : items;

if (!ONLY.length && existsSync(SITE)) {
  for (const f of readdirSync(SITE)) if (f !== 'wp-content') rmSync(join(SITE, f), { recursive: true, force: true });
}

const pages = [];
const errors = [];
for (const item of todo) {
  const out = render(item, ctx);
  if (out.error) { errors.push(out.error); continue; }
  pages.push({ item, ...out });
  const cat = LISTINGS[item.path];
  if (!cat) continue;
  const $p = cheerio.load(read(snapshotFile(item.path)));
  const per = $p('.elementor-widget-uael-posts').filter((_, el) => $p(el).find('.uael-grid-pagination').length).first().find('.uael-post-wrapper').length;
  const list = ctx.posts.filter((p) => (p.categories || []).some((c) => c.slug === cat));
  const total = Math.ceil(list.length / per);
  for (let n = 2; n <= total; n++) {
    const virtual = { ...item, path: `${item.path}page/${n}/` };
    const o = render(virtual, ctx, { base: item.path, n, total, posts: list.slice((n - 1) * per, n * per) });
    pages.push({ item: virtual, ...o });
  }
}

const { sharedCss, pageCss, report } = await buildCss(ROOT, pages);
mkdirSync(join(SITE, 'assets'), { recursive: true });
writeFileSync(join(SITE, 'assets', 'site.css'), sharedCss + read(join(ROOT, 'tools', 'assets', 'extra.css')));
cpSync(join(ROOT, 'tools', 'assets', 'site.js'), join(SITE, 'assets', 'site.js'));
const partial = (n) => read(join(ROOT, 'tools', 'partials', n));

for (const p of pages) {
  const css = pageCss.get(p.item.path);
  let html = p.html
    .replace('<!--PAGE-CSS-->', css ? `<style>${css}</style>` : '')
    .replace('<!--ANALYTICS-HEAD-->', PRODUCTION ? partial('analytics-head.html') : '<meta name="robots" content="noindex, nofollow">')
    .replace('<!--ANALYTICS-BODY-->', PRODUCTION ? partial('analytics-body.html') : '')
    .replace('<!--A11Y-->', partial('a11y.html'));
  if (!PRODUCTION) html = html.replace(/<meta name="robots" content="(?!noindex, nofollow)[^"]*">\n?/g, '');
  const out = p.item.path === '/' ? join(SITE, 'index.html') : join(SITE, p.item.path, 'index.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
}

console.log(`${PRODUCTION ? 'PRODUCTION' : 'STAGING'} build: ${pages.length} pages. Shared CSS ${(sharedCss.length / 1024).toFixed(1)} KB. ${report}`);
if (errors.length) console.log('Errors:\n' + errors.join('\n'));
