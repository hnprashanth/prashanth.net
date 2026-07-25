#!/usr/bin/env node
/**
 * Convert the Medium export in ./medium-export/posts into Markdown + local images.
 *
 *   node tools/import-medium/import.mjs [--dry-run] [--only=<slug>] [--no-download]
 *
 * Idempotent: images already recorded in manifest.json are not re-fetched.
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

import { classify, extractMeta, parseBody, RETIRED_SLUGS } from './parse.mjs';
import { deriveDescription, firstSentence, normaliseSpace } from './text.mjs';
import { ImageStore } from './images.mjs';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'medium-export', 'posts');
const OUT = path.join(ROOT, 'src', 'content', 'posts');
const ASSETS = path.join(ROOT, 'src', 'assets', 'posts');
const PUBLIC_IMG = path.join(ROOT, 'public', 'images');
const MANIFEST = path.join(ROOT, 'tools', 'import-medium', 'manifest.json');
const OVERRIDES = path.join(ROOT, 'tools', 'import-medium', 'overrides.json');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];

const DRY = flag('dry-run');
const NO_DOWNLOAD = flag('no-download');
const ONLY = opt('only');

/** Images are always animated GIFs here; sharp would flatten them to one frame. */
const isAnimatedGif = (url) => /\.gif$/i.test(url);

function yamlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderBlocks(blocks, imageRefs) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        out.push(`## ${b.md}`);
        break;
      case 'para':
        out.push(b.md);
        break;
      case 'quote':
        out.push(
          b.md
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        );
        break;
      case 'list':
        out.push(b.items.map((it, i) => (b.ordered ? `${i + 1}. ${it}` : `- ${it}`)).join('\n'));
        break;
      case 'code':
        out.push('```\n' + b.code + '\n```');
        break;
      case 'image': {
        const ref = imageRefs.get(b.mediumId);
        if (!ref) break;
        const alt = (b.alt || b.caption || '').replace(/[[\]]/g, '').replace(/"/g, "'");
        const title = b.caption ? ` "${b.caption.replace(/"/g, "'")}"` : '';
        out.push(`![${alt}](${ref}${title})`);
        break;
      }
      case 'video': {
        // A YouTube iframe would load third-party JS and set tracking cookies,
        // which the zero-JS / no-analytics rule forbids. Link out instead.
        const label = b.caption ? b.caption : 'Watch on YouTube';
        out.push(`[${label} →](https://www.youtube.com/watch?v=${b.id})`);
        break;
      }
      case 'linkcard':
        // The design forbids cards and boxes, so this is a plain sentence.
        out.push(`[${b.title}](${b.href}) — ${b.domain}`);
        break;
    }
  }
  return out.join('\n\n');
}

/** Re-parse what we just wrote and assert it is a usable post. */
function verify(md, meta) {
  const fm = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fm) throw new Error('frontmatter did not round-trip');
  const [, front, body] = fm;
  for (const key of ['title', 'date', 'description', 'slug', 'draft']) {
    if (!new RegExp(`^${key}:`, 'm').test(front)) throw new Error(`missing frontmatter key: ${key}`);
  }
  if (body.trim().length < 40) throw new Error('body is empty or trivially short');
  if (/\bundefined\b|\[object Object\]/.test(md)) throw new Error('placeholder leaked into output');
  if (!meta.title || !meta.slug || !meta.date || !meta.description) throw new Error('empty metadata field');
  return { bodyLength: body.trim().length };
}

async function main() {
  const overrides = await readFile(OVERRIDES, 'utf8').then(JSON.parse, () => ({}));
  const files = (await readdir(SRC)).filter((f) => f.endsWith('.html')).sort();

  const store = new ImageStore({
    assetsDir: ASSETS,
    publicDir: PUBLIC_IMG,
    manifestPath: MANIFEST,
    concurrency: 6,
  });
  await store.load();

  const skipped = [];
  const staged = [];
  const allWarnings = [];

  for (const file of files) {
    const html = await readFile(path.join(SRC, file), 'utf8');
    const $ = cheerio.load(html);

    const verdict = classify($, file);
    if (verdict.kind !== 'post') {
      skipped.push({ file, ...verdict });
      continue;
    }

    const meta = extractMeta($, verdict.canonical);
    if (RETIRED_SLUGS.has(meta.slug)) {
      skipped.push({ file, kind: 'retired', reason: 'retired by author' });
      continue;
    }
    if (ONLY && meta.slug !== ONLY) continue;

    const { blocks, warnings } = parseBody($, { slug: meta.slug });
    warnings.forEach((w) => allWarnings.push(`${meta.slug}: ${w}`));

    const firstPara = blocks.find((b) => b.type === 'para');
    const description =
      overrides[meta.slug]?.description ??
      deriveDescription({
        subtitle: meta.subtitle,
        firstParagraph: firstPara ? stripMd(firstPara.md) : '',
      });

    // Register images in document order so filenames read chronologically.
    let n = 0;
    for (const b of blocks) {
      if (b.type !== 'image') continue;
      n += 1;
      store.register({
        url: b.url,
        mediumId: b.mediumId,
        slug: meta.slug,
        index: n,
        label: b.alt || b.caption || `image-${n}`,
        raw: isAnimatedGif(b.url),
      });
    }

    staged.push({ file, meta, blocks, description });
  }

  console.log(`\nClassified ${files.length} files -> ${staged.length} posts, ${skipped.length} skipped`);
  for (const s of skipped) console.log(`  skip  ${s.kind.padEnd(9)} ${s.file.slice(0, 62)}`);

  if (!DRY && !NO_DOWNLOAD) {
    console.log(`\nDownloading ${store.queue.length} images…`);
    await store.downloadAll((m) => console.log(m));
  }
  const imageRefs = store.finalise();

  if (DRY) {
    console.log('\n--dry-run: no files written');
    printWarnings(allWarnings);
    return;
  }

  await mkdir(OUT, { recursive: true });
  const report = [];

  for (const { meta, blocks, description } of staged) {
    let body = renderBlocks(blocks, imageRefs);

    // Hand-recorded content fixes (see overrides.json for the reason on each).
    for (const fragment of overrides[meta.slug]?.remove ?? []) {
      if (!body.includes(fragment)) throw new Error(`override for ${meta.slug}: fragment not found: ${fragment.slice(0, 60)}…`);
      body = body.replace(fragment, '');
    }
    for (const [from, to] of overrides[meta.slug]?.rewrite ?? []) {
      if (!body.includes(from)) throw new Error(`override for ${meta.slug}: rewrite source not found: ${from.slice(0, 60)}…`);
      body = body.replaceAll(from, to);
    }
    const md =
      [
        '---',
        `title: ${yamlString(meta.title)}`,
        `date: ${meta.date}`,
        `description: ${yamlString(description)}`,
        `slug: ${yamlString(meta.slug)}`,
        'draft: false',
        '---',
      ].join('\n') +
      '\n\n' +
      body +
      '\n';

    const stats = verify(md, { ...meta, description });
    await writeFile(path.join(OUT, `${meta.slug}.md`), md);
    report.push({
      slug: meta.slug,
      blocks: blocks.length,
      images: blocks.filter((b) => b.type === 'image').length,
      videos: blocks.filter((b) => b.type === 'video').length,
      chars: stats.bodyLength,
    });
  }

  console.log(`\nWrote ${report.length} posts to src/content/posts/\n`);
  console.log('  slug                                              blk  img  vid   chars');
  for (const r of report) {
    console.log(
      `  ${r.slug.slice(0, 48).padEnd(48)} ${String(r.blocks).padStart(3)} ${String(r.images).padStart(4)} ${String(
        r.videos,
      ).padStart(4)} ${String(r.chars).padStart(7)}`,
    );
  }
  printWarnings(allWarnings);
}

function printWarnings(ws) {
  if (!ws.length) return;
  console.log(`\n${ws.length} warning(s):`);
  ws.forEach((w) => console.log(`  ! ${w}`));
}

/** Strip inline Markdown so descriptions read as plain prose. */
function stripMd(s) {
  return normaliseSpace(
    s
      .replace(/\\([\\`*_[\]<>#+.-])/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1'),
  );
}

main().catch((err) => {
  console.error('\nImport failed:', err);
  process.exit(1);
});
