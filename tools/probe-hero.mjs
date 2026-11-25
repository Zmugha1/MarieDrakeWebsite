import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ORIGIN = 'https://thedrakelawfirm.com/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'inventory', 'design', 'hero-probe.md');
const SHOT = join(ROOT, 'inventory', 'design', 'screens', 'home-hero-probe.png');
const MEDIA_TAGS = new Set(['video', 'source', 'iframe', 'canvas', 'img']);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classTokenInHtml(html, token) {
  if (!token) return false;
  const re = new RegExp(`(?:^|[\\s"'=])${escapeRegExp(token)}(?:$|[\\s"'])`);
  return re.test(html);
}

function interestingRequest(url) {
  const lower = url.toLowerCase();
  if (lower.includes('youtube') || lower.includes('vimeo')) return true;
  try {
    return /\.(?:jpe?g|png|webp|mp4)$/i.test(new URL(url).pathname);
  } catch {
    return /\.(?:jpe?g|png|webp|mp4)(?:$|\?)/i.test(lower);
  }
}

function line(text) {
  return `- ${String(text).replace(/\s+/g, ' ').trim()}`;
}

function shortClass(value) {
  const text = String(value || '');
  return text.length > 120 ? `${text.slice(0, 120)}` : text;
}

async function main() {
  const rawResponse = await fetch(ORIGIN, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
  });
  const rawHtml = await rawResponse.text();

  const requests = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      userAgent: USER_AGENT,
    });
    page.on('request', (request) => {
      const url = request.url();
      if (interestingRequest(url)) requests.push(url);
    });
    await page.goto(ORIGIN, { waitUntil: 'networkidle', timeout: 90000 });
    await page.waitForTimeout(3000);

    const probed = await page.evaluate(() => {
      function classText(el) {
        if (typeof el.className === 'string') return el.className;
        if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
        return el.getAttribute('class') || '';
      }
      function overlaps(box) {
        return box.width > 0 && box.height > 0 && box.bottom > 100 && box.top < 700;
      }
      const band = [];
      const media = [];
      for (const el of document.querySelectorAll('*')) {
        const box = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const selfOverlaps = overlaps(box);
        let sourceParentOverlaps = false;
        if (tag === 'source' && !selfOverlaps) {
          const parent = el.closest('video, audio, picture');
          if (parent) sourceParentOverlaps = overlaps(parent.getBoundingClientRect());
        }
        if (!selfOverlaps && !sourceParentOverlaps) continue;
        const style = getComputedStyle(el);
        const before = getComputedStyle(el, '::before');
        const after = getComputedStyle(el, '::after');
        const className = classText(el);
        band.push({
          tag,
          id: el.id || '',
          className,
          backgroundImage: style.backgroundImage,
          beforeBackground: before.backgroundImage,
          afterBackground: after.backgroundImage,
          opacity: style.opacity,
        });
        if (tag === 'video' || tag === 'source' || tag === 'iframe' || tag === 'canvas' || tag === 'img') {
          const sizeBox = selfOverlaps ? box : el.parentElement.getBoundingClientRect();
          media.push({
            tag,
            src: el.currentSrc || el.src || el.getAttribute('src') || '',
            poster: el.poster || el.getAttribute('poster') || '',
            className,
            width: Math.round(sizeBox.width),
            height: Math.round(sizeBox.height),
          });
        }
      }
      return { band, media };
    });

    mkdirSync(dirname(SHOT), { recursive: true });
    await page.screenshot({
      path: SHOT,
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    const injected = [];
    for (const item of probed.band) {
      const tokens = item.className.split(/\s+/).filter(Boolean);
      const missing = tokens.filter((token) => !classTokenInHtml(rawHtml, token));
      if (missing.length > 0) {
        injected.push({ tag: item.tag, id: item.id, className: item.className, missing });
      }
    }

    const lines = [];
    lines.push('# Homepage banner probe');
    lines.push('');
    lines.push(line(`Page: ${ORIGIN}`));
    lines.push(line('Viewport: 1440 x 900'));
    lines.push(line(`User-Agent: ${USER_AGENT}`));
    lines.push(line(`Server HTML status: ${rawResponse.status}, ${rawHtml.length} characters`));
    lines.push(line('Band: y=100 through y=700'));
    lines.push(line('A source element with no box is included when its video, audio, or picture parent overlaps the band.'));
    lines.push('');

    lines.push('## Background images in the band');
    lines.push('');
    const backgrounds = probed.band.filter((item) => (
      (item.backgroundImage && item.backgroundImage !== 'none')
      || (item.beforeBackground && item.beforeBackground !== 'none')
      || (item.afterBackground && item.afterBackground !== 'none')
    ));
    if (backgrounds.length === 0) lines.push(line('None.'));
    for (const item of backgrounds) {
      lines.push(line(`${item.tag}${item.id ? `#${item.id}` : ''} class="${shortClass(item.className)}" opacity=${item.opacity}`));
      lines.push(`  - background-image: ${item.backgroundImage}`);
      lines.push(`  - ::before background-image: ${item.beforeBackground}`);
      lines.push(`  - ::after background-image: ${item.afterBackground}`);
    }
    lines.push('');

    lines.push('## Video, iframe, canvas, and img in the band');
    lines.push('');
    const visualMedia = probed.media.filter((item) => item.tag !== 'source');
    if (visualMedia.length === 0) lines.push(line('None.'));
    for (const item of visualMedia) {
      lines.push(line(`${item.tag} ${item.width}x${item.height} class="${shortClass(item.className)}"`));
      lines.push(`  - src: ${item.src || '(none)'}`);
      lines.push(`  - poster: ${item.poster || '(none)'}`);
    }
    lines.push('');

    lines.push('## Source elements in the band');
    lines.push('');
    const sources = probed.media.filter((item) => item.tag === 'source');
    if (sources.length === 0) lines.push(line('None.'));
    for (const item of sources) {
      lines.push(line(`source ${item.width}x${item.height} class="${shortClass(item.className)}"`));
      lines.push(`  - src: ${item.src || '(none)'}`);
      lines.push(`  - poster: ${item.poster || '(none)'}`);
    }
    lines.push('');

    lines.push('## Network requests');
    lines.push('');
    if (requests.length === 0) lines.push(line('None.'));
    requests.forEach((url, index) => lines.push(`${index + 1}. ${url}`));
    lines.push('');

    lines.push('## Elements in the band whose class is not in the server HTML');
    lines.push('');
    if (injected.length === 0) lines.push(line('None.'));
    for (const item of injected) {
      lines.push(line(`${item.tag}${item.id ? `#${item.id}` : ''} missing="${item.missing.join(' ')}" class="${shortClass(item.className)}"`));
    }
    lines.push('');

    lines.push('## Every element in the band');
    lines.push('');
    lines.push(line(`Count: ${probed.band.length}`));
    for (const item of probed.band) {
      lines.push(line(`${item.tag}${item.id ? `#${item.id}` : ''} class="${shortClass(item.className)}" opacity=${item.opacity} background=${item.backgroundImage} before=${item.beforeBackground} after=${item.afterBackground}`));
    }
    lines.push('');

    mkdirSync(dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, `${lines.join('\n')}\n`, 'utf8');
    console.error(`band=${probed.band.length} backgrounds=${backgrounds.length} media=${visualMedia.length} requests=${requests.length} injected=${injected.length}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
