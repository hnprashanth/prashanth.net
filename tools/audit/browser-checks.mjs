#!/usr/bin/env node
/**
 * Browser assertions against the built site: no horizontal overflow at mobile
 * widths, WCAG AA contrast in both colour schemes, no broken images, no
 * requests to third parties, and no scripts.
 *
 *   npx astro preview &   node tools/audit/browser-checks.mjs [baseUrl]
 */
import { chromium } from 'playwright';
import { readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:4321';
const WIDTHS = [360, 390, 768];
const SHOTS = path.join(process.cwd(), 'tools', 'audit', 'screenshots');

let failures = 0;
let checks = 0;
const ok = (n) => { checks++; console.log(`  \x1b[32m✓\x1b[0m ${n}`); };
const fail = (n, d) => {
  checks++; failures++;
  console.log(`  \x1b[31m✗\x1b[0m ${n}`);
  if (d) String(d).split('\n').slice(0, 10).forEach((l) => console.log(`      ${l}`));
};
const assert = (c, n, d) => (c ? ok(n) : fail(n, d));

// --- WCAG relative luminance ----------------------------------------------
function parseRgb(s) {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b] = m[1].split(',').map((v) => parseFloat(v));
  return [r, g, b];
}
const lin = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
function contrast(fg, bg) {
  const [l1, l2] = [lum(parseRgb(fg)), lum(parseRgb(bg))].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

const slugs = (await readdir(path.join(process.cwd(), 'src', 'content', 'posts')))
  .filter((f) => f.endsWith('.md'))
  .map((f) => `/posts/${f.replace(/\.md$/, '')}`);
const pages = ['/', '/about', '/404', ...slugs];

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

// --- overflow --------------------------------------------------------------
console.log('\nNo horizontal overflow (360 / 390 / 768)\n');
for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 900 });
  const problems = [];
  for (const p of pages) {
    await page.goto(BASE + p, { waitUntil: 'load' });
    const res = await page.evaluate(() => {
      const docW = document.documentElement.scrollWidth;
      const winW = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll('body *')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.right > winW + 1 || r.left < -1);
        })
        .slice(0, 4)
        .map((el) => `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} (right=${Math.round(el.getBoundingClientRect().right)})`);
      return { docW, winW, wide };
    });
    if (res.docW > res.winW + 1 || res.wide.length) {
      problems.push(`${p}: scrollWidth=${res.docW} clientWidth=${res.winW} ${res.wide.join(', ')}`);
    }
  }
  assert(problems.length === 0, `${width}px — all ${pages.length} pages fit`, problems.join('\n'));
}

// --- tap targets -----------------------------------------------------------
console.log('\nTap targets\n');
await page.setViewportSize({ width: 390, height: 900 });
await page.goto(BASE + '/', { waitUntil: 'load' });
const taps = await page.evaluate(() => {
  const out = [];
  for (const a of document.querySelectorAll('.post-list a, .site-footer a, .site-nav a')) {
    const r = a.getBoundingClientRect();
    if (r.height < 44) out.push(`${a.textContent.trim().slice(0, 30)} = ${Math.round(r.height)}px`);
  }
  return out;
});
assert(taps.length === 0, 'every nav/footer/post-list target is >= 44px tall', taps.join('\n'));

// The whole post-list entry must be clickable, not just the title text.
const entryClickable = await page.evaluate(() => {
  const a = document.querySelector('.post-list a');
  const r = a.getBoundingClientRect();
  // Probe a point on the date line, well below the title.
  const el = document.elementFromPoint(r.left + r.width - 8, r.bottom - 8);
  return a.contains(el);
});
assert(entryClickable, 'post-list entry is tappable across its full area');

// Date must sit below the title, not beside it (no truncation on narrow screens).
await page.setViewportSize({ width: 360, height: 900 });
await page.goto(BASE + '/', { waitUntil: 'load' });
const dateBelow = await page.evaluate(() => {
  const a = document.querySelector('.post-list a');
  const t = a.querySelector('.title').getBoundingClientRect();
  const d = a.querySelector('time').getBoundingClientRect();
  return d.top >= t.bottom - 1;
});
assert(dateBelow, 'post-list date wraps below the title at 360px');

// --- contrast --------------------------------------------------------------
console.log('\nWCAG AA contrast, both schemes\n');
for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(BASE + slugs[0], { waitUntil: 'load' });
  const c = await page.evaluate(() => {
    const cs = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el) : null;
    };
    return {
      bg: getComputedStyle(document.body).backgroundColor,
      fg: getComputedStyle(document.body).color,
      muted: cs('.meta')?.color,
      accent: cs('.post-body a')?.color,
      linkDecoration: cs('.post-body a')?.textDecorationLine,
    };
  });
  const pairs = { 'body text': c.fg, 'muted text': c.muted, 'link accent': c.accent };
  for (const [name, fg] of Object.entries(pairs)) {
    if (!fg) { fail(`${scheme}: ${name} — element not found`); continue; }
    const ratio = contrast(fg, c.bg);
    assert(ratio >= 4.5, `${scheme}: ${name} ${ratio.toFixed(2)}:1 (AA needs 4.5)`, `fg=${fg} bg=${c.bg}`);
  }
  // Colour alone must not be the only link signal.
  assert(c.linkDecoration?.includes('underline'), `${scheme}: links are underlined, not colour-only`);
}
await page.emulateMedia({ colorScheme: 'light' });

// --- images and requests ---------------------------------------------------
console.log('\nImages and network\n');
const brokenAll = [];
const thirdParty = new Set();
const scriptReqs = new Set();
page.on('request', (r) => {
  const host = new URL(r.url()).host;
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) thirdParty.add(r.url());
  if (r.resourceType() === 'script') scriptReqs.add(r.url());
});
await page.setViewportSize({ width: 1280, height: 900 });
for (const p of pages) {
  await page.goto(BASE + p, { waitUntil: 'networkidle' });
  // Force lazy images to load so decode failures surface.
  await page.evaluate(() => {
    document.querySelectorAll('img[loading="lazy"]').forEach((i) => i.setAttribute('loading', 'eager'));
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(250);
  const broken = await page.evaluate(() =>
    [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.currentSrc || i.src),
  );
  broken.forEach((b) => brokenAll.push(`${p}: ${b}`));
}
assert(brokenAll.length === 0, 'every image decodes', brokenAll.join('\n'));
assert(scriptReqs.size === 0, 'zero script requests across all pages', [...scriptReqs].join('\n'));
assert(thirdParty.size === 0, 'zero third-party requests across all pages', [...thirdParty].join('\n'));

// --- screenshots -----------------------------------------------------------
await mkdir(SHOTS, { recursive: true });
const shots = [
  ['home', '/', 390],
  ['home-desktop', '/', 1280],
  ['post', slugs.find((s) => s.includes('into-the-ocean')) || slugs[0], 390],
  ['post-desktop', slugs.find((s) => s.includes('into-the-ocean')) || slugs[0], 1280],
];
for (const scheme of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: scheme });
  for (const [name, url, width] of shots) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(BASE + url, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`), fullPage: false });
  }
}
ok(`screenshots written to ${path.relative(process.cwd(), SHOTS)}`);

await browser.close();
console.log(`\n${checks - failures}/${checks} checks passed\n`);
if (failures) process.exit(1);
