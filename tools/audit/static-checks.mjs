#!/usr/bin/env node
/**
 * Static assertions over dist/. No browser required; runs in CI as a deploy gate.
 *
 *   node tools/audit/static-checks.mjs
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const CONTENT = path.join(ROOT, 'src', 'content', 'posts');

let failures = 0;
let checks = 0;

function ok(name) {
  checks++;
  console.log(`  [32m✓[0m ${name}`);
}
function fail(name, detail) {
  checks++;
  failures++;
  console.log(`  [31m✗[0m ${name}`);
  if (detail) String(detail).split('\n').slice(0, 12).forEach((l) => console.log(`      ${l}`));
}
function assert(cond, name, detail) {
  cond ? ok(name) : fail(name, detail);
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

const exists = (p) => stat(p).then(() => true, () => false);

const files = await walk(DIST);
const html = files.filter((f) => f.endsWith('.html'));
const postFiles = (await readdir(CONTENT)).filter((f) => f.endsWith('.md'));

console.log('\nBuild output\n');

// --- page inventory --------------------------------------------------------
assert(
  html.length === postFiles.length + 3,
  `page count: ${html.length} html files for ${postFiles.length} posts + index/about/404`,
  `got: ${html.map((f) => path.relative(DIST, f)).join(', ')}`,
);

for (const f of postFiles) {
  const slug = f.replace(/\.md$/, '');
  const src = await readFile(path.join(CONTENT, f), 'utf8');
  const fmSlug = src.match(/^slug: "(.*)"$/m)?.[1];
  const built = path.join(DIST, 'posts', `${slug}.html`);
  if (!(await exists(built))) {
    fail(`renders: ${slug}`, 'no HTML emitted');
    continue;
  }
  const out = await readFile(built, 'utf8');
  const hasH1 = /<h1[^>]*>[^<]{3,}<\/h1>/.test(out);
  const bodyText = out
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (fmSlug !== slug) fail(`renders: ${slug}`, `frontmatter slug "${fmSlug}" != filename`);
  else if (!hasH1) fail(`renders: ${slug}`, 'no non-empty <h1>');
  else if (bodyText.length < 300) fail(`renders: ${slug}`, `body only ${bodyText.length} chars`);
  else ok(`renders: ${slug} (${bodyText.length} chars)`);
}

console.log('\nZero client-side JavaScript\n');

// --- zero JS ---------------------------------------------------------------
const jsFiles = files.filter((f) => /\.(js|mjs|cjs)$/.test(f));
assert(jsFiles.length === 0, 'no .js emitted', jsFiles.map((f) => path.relative(DIST, f)).join('\n'));

const withScript = [];
for (const f of html) {
  const src = await readFile(f, 'utf8');
  if (/<script[\s>]/i.test(src)) withScript.push(path.relative(DIST, f));
}
assert(withScript.length === 0, 'no <script> tags in any page', withScript.join('\n'));

const withHandlers = [];
for (const f of html) {
  const src = await readFile(f, 'utf8');
  const m = src.match(/\son(?:click|load|error|mouseover|submit)\s*=/i);
  if (m) withHandlers.push(`${path.relative(DIST, f)}: ${m[0].trim()}`);
}
assert(withHandlers.length === 0, 'no inline event handlers', withHandlers.join('\n'));

console.log('\nAssets and links\n');

// --- every referenced local asset resolves ---------------------------------
const missing = [];
const referenced = new Set();
for (const f of html) {
  const src = await readFile(f, 'utf8');
  const urls = [
    ...[...src.matchAll(/(?:src|href)="(\/[^"#?]*)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/srcset="([^"]+)"/g)].flatMap((m) =>
      m[1].split(',').map((p) => p.trim().split(/\s+/)[0]),
    ),
  ];
  for (const u of urls) {
    if (!u.startsWith('/') || u.startsWith('//')) continue;
    referenced.add(u);
    // Pages are emitted as .html but linked without the extension.
    const candidates = [
      path.join(DIST, u),
      path.join(DIST, `${u}.html`),
      path.join(DIST, u, 'index.html'),
    ];
    let found = false;
    for (const c of candidates) if (await exists(c)) { found = true; break; }
    if (!found) missing.push(`${path.relative(DIST, f)} -> ${u}`);
  }
}
assert(missing.length === 0, `all ${referenced.size} local references resolve`, missing.join('\n'));

// --- images ----------------------------------------------------------------
const imgTags = [];
for (const f of html) {
  const src = await readFile(f, 'utf8');
  for (const m of src.matchAll(/<img\b[^>]*>/g)) imgTags.push({ file: path.relative(DIST, f), tag: m[0] });
}
assert(imgTags.length > 0, `${imgTags.length} <img> tags found`);

const noDims = imgTags.filter((i) => !/\bwidth="/.test(i.tag) || !/\bheight="/.test(i.tag));
assert(noDims.length === 0, 'every image has width+height (no layout shift)', noDims.map((i) => i.tag.slice(0, 120)).join('\n'));

const noLazy = imgTags.filter((i) => !/loading="lazy"/.test(i.tag));
assert(noLazy.length === 0, 'every image is lazy-loaded', noLazy.map((i) => i.tag.slice(0, 120)).join('\n'));

const noAlt = imgTags.filter((i) => !/\balt="/.test(i.tag));
assert(noAlt.length === 0, 'every image has an alt attribute', noAlt.map((i) => `${i.file}: ${i.tag.slice(0, 100)}`).join('\n'));

// The animated GIF must bypass sharp or it loses its frames.
const gif = path.join(DIST, 'images');
const gifs = (await exists(gif)) ? (await readdir(gif)).filter((f) => f.endsWith('.gif')) : [];
assert(gifs.length === 1, 'animated GIF passed through public/', `found: ${gifs.join(', ')}`);
if (gifs.length === 1) {
  const buf = await readFile(path.join(gif, gifs[0]));
  const frames = buf.toString('latin1').split('\x21\xf9\x04').length - 1;
  assert(frames > 30, `GIF still animated (${frames} frames)`);
}

// --- no third-party requests ----------------------------------------------
const external = new Set();
for (const f of html) {
  const src = await readFile(f, 'utf8');
  for (const m of src.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) {
    const host = new URL(m[1]).host;
    // Anchor targets are fine; only subresources would make a request.
    const isSubresource = /<(?:img|script|link(?![^>]*rel="(?:canonical|alternate|me)")|iframe)[^>]*$/i.test(
      src.slice(Math.max(0, m.index - 200), m.index),
    );
    if (isSubresource && host !== 'prashanth.net') external.add(`${path.relative(DIST, f)}: ${m[1]}`);
  }
}
assert(external.size === 0, 'no third-party subresources', [...external].join('\n'));

console.log('\nFeeds, metadata, deploy files\n');

// --- feeds and metadata ----------------------------------------------------
const cname = await readFile(path.join(DIST, 'CNAME'), 'utf8').catch(() => '');
assert(cname.trim() === 'prashanth.net', 'CNAME contains prashanth.net', `got: ${JSON.stringify(cname)}`);

const rss = await readFile(path.join(DIST, 'rss.xml'), 'utf8').catch(() => '');
const items = (rss.match(/<item>/g) || []).length;
assert(items === postFiles.length, `RSS has ${items} items (expected ${postFiles.length})`);
assert(rss.includes('<?xml'), 'RSS is well-formed XML');

assert(await exists(path.join(DIST, 'sitemap-index.xml')), 'sitemap-index.xml exists');
assert(await exists(path.join(DIST, '404.html')), '404 page exists');

// --- per-page head ---------------------------------------------------------
const headProblems = [];
for (const f of html) {
  const src = await readFile(f, 'utf8');
  const rel = path.relative(DIST, f);
  if (!/<html lang="en">/.test(src)) headProblems.push(`${rel}: missing lang`);
  if (!/name="viewport" content="width=device-width/.test(src)) headProblems.push(`${rel}: missing viewport`);
  if (!/<meta name="description"/.test(src)) headProblems.push(`${rel}: missing description`);
  if (!/property="og:title"/.test(src)) headProblems.push(`${rel}: missing og:title`);
  if (!/rel="canonical"/.test(src)) headProblems.push(`${rel}: missing canonical`);
  const h1s = (src.match(/<h1[\s>]/g) || []).length;
  if (h1s !== 1) headProblems.push(`${rel}: ${h1s} <h1> elements`);
}
assert(headProblems.length === 0, 'every page has lang, viewport, description, OG, canonical, one h1', headProblems.join('\n'));

// Posts must declare article metadata.
const postHtml = html.filter((f) => f.includes(`${path.sep}posts${path.sep}`));
const badArticle = postHtml.filter((f) => !/property="og:type" content="article"/.test(''));
const articleProblems = [];
for (const f of postHtml) {
  const src = await readFile(f, 'utf8');
  if (!/content="article"/.test(src)) articleProblems.push(`${path.relative(DIST, f)}: og:type not article`);
  if (!/property="article:published_time"/.test(src)) articleProblems.push(`${path.relative(DIST, f)}: no published_time`);
}
assert(articleProblems.length === 0, 'every post declares og:type=article + published_time', articleProblems.join('\n'));

// --- heading order ---------------------------------------------------------
const headingProblems = [];
for (const f of html) {
  const src = await readFile(f, 'utf8');
  const levels = [...src.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) {
      headingProblems.push(`${path.relative(DIST, f)}: h${levels[i - 1]} -> h${levels[i]}`);
      break;
    }
  }
}
assert(headingProblems.length === 0, 'heading levels never skip', headingProblems.join('\n'));

console.log(`\n${checks - failures}/${checks} checks passed\n`);
if (failures) process.exit(1);
