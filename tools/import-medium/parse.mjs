/** Medium export HTML -> classified metadata + a normalised block list. */
import { inline, normaliseSpace } from './text.mjs';

/** Slugs we deliberately drop (see tools/import-medium/README.md). */
export const DROP_SLUGS = new Set(['5-reasons-why-i-got-hooked-on-to-cycling--repost']);

/** Filenames dropped as exact duplicates of another post. */
export const DROP_FILES = new Set([
  // Re-publish of the 2016-07-08 post: same title and text, but no images.
  '2016-07-13_5-reasons-why-I-got-hooked-on-to-Cycling-b9f0dce45b57.html',
]);

/** YouTube ids that no longer resolve (verified 404 on oEmbed and thumbnails). */
export const DEAD_VIDEOS = new Set(['gu8KqV90pKk']);

export function classify($, filename) {
  const canonical = $('footer a.p-canonical').attr('href');
  if (!canonical) return { kind: 'draft', reason: 'no canonical link' };
  if (DROP_FILES.has(filename)) return { kind: 'duplicate', reason: 'republished duplicate' };
  if (/medium\.com\/series\//.test(canonical)) return { kind: 'series', reason: 'Medium series, not a post' };

  const body = $('section[data-field="body"]');
  const hasTitleGraf = body.find('.graf--title').length > 0;
  const h1 = $('header h1.p-name').text().trim();
  const firstP = body.find('p.graf--p').first().text().trim();
  if (!hasTitleGraf && h1 && firstP && h1 === firstP) {
    return { kind: 'response', reason: 'Medium response/comment' };
  }
  return { kind: 'post', canonical };
}

export function extractMeta($, canonical) {
  const title = normaliseSpace($('header h1.p-name').text()).trim();
  const datetime = $('footer time.dt-published').attr('datetime');
  const slug = new URL(canonical).pathname
    .split('/')
    .pop()
    .replace(/-[0-9a-f]{9,14}$/, '');
  const subtitle = normaliseSpace($('section[data-field="subtitle"]').text()).trim();
  return { title, date: datetime, slug, subtitle };
}

const CAPTION_OPEN = /^\[caption\b[^\]]*\]$/i;
const CAPTION_CLOSE = /^([\s\S]*?)\[\/caption\]$/i;

/**
 * Walk the body into a flat block list, applying every known export quirk.
 * Returns { blocks, warnings }.
 */
export function parseBody($, { slug }) {
  const warnings = [];
  const body = $('section[data-field="body"]');
  const container = body.find('div.section-inner').length ? body.find('div.section-inner') : body;

  // Collect top-level blocks across all section-inner wrappers, in document order.
  const raw = [];
  container.each((_, inner) => {
    $(inner)
      .children()
      .each((__, el) => raw.push(el));
  });

  const blocks = [];
  let pendingCaption = null; // set by a [caption] closer, applied to the previous figure

  for (let i = 0; i < raw.length; i++) {
    const el = raw[i];
    const $el = $(el);
    const cls = $el.attr('class') || '';
    const tag = el.tagName;

    // --- structural noise -------------------------------------------------
    if (tag === 'hr' || cls.includes('section-divider')) continue;
    if (cls.includes('graf--empty')) continue;
    // The body repeats the H1 as its first heading.
    if (cls.includes('graf--title')) continue;

    // --- WordPress [caption] shortcodes (3 files) -------------------------
    const textRaw = normaliseSpace($el.text()).trim();
    if (tag === 'p' && CAPTION_OPEN.test(textRaw)) continue; // opener: drop
    if (tag === 'p') {
      const m = textRaw.match(CAPTION_CLOSE);
      if (m) {
        // Closer: its text is the caption for the figure just emitted.
        const caption = m[1].trim();
        const prev = blocks[blocks.length - 1];
        if (prev && prev.type === 'image' && caption && !prev.caption) prev.caption = caption;
        else if (caption) warnings.push(`[caption] closer with no preceding figure: "${caption}"`);
        continue;
      }
    }

    // --- figures ----------------------------------------------------------
    if (tag === 'figure') {
      const $img = $el.find('img').first();
      const $iframe = $el.find('iframe').first();
      const captionEl = $el.find('figcaption').first();
      const caption = captionEl.length ? inline($, captionEl[0]).trim() : '';

      if ($iframe.length) {
        const src = $iframe.attr('src') || '';
        const idMatch = src.match(/youtube\.com\/embed\/([\w-]+)/);
        if (!idMatch) {
          warnings.push(`Unrecognised iframe embed: ${src}`);
          continue;
        }
        const id = idMatch[1];
        if (DEAD_VIDEOS.has(id)) {
          warnings.push(`Skipped dead YouTube video ${id}`);
          continue;
        }
        blocks.push({ type: 'video', id, caption });
        continue;
      }

      if ($img.length) {
        const width = parseInt($img.attr('data-width') || '0', 10);
        const alt = normaliseSpace($img.attr('alt') || '').trim();
        // 15x15 WordPress smiley GIFs promoted to full-width figures.
        if (width && width <= 20) {
          const prev = blocks[blocks.length - 1];
          const emoticon = alt || '';
          if (prev && prev.type === 'para' && emoticon) prev.md = `${prev.md} ${emoticon}`.trim();
          continue;
        }
        blocks.push({
          type: 'image',
          url: $img.attr('src'),
          mediumId: $img.attr('data-image-id') || $img.attr('src'),
          alt,
          caption,
        });
        continue;
      }
      warnings.push('Figure with neither img nor iframe');
      continue;
    }

    // --- Medium "mixtape" link cards --------------------------------------
    if (cls.includes('graf--mixtapeEmbed')) {
      const $a = $el.find('a').first();
      const href = $a.attr('href');
      const title = normaliseSpace($a.find('strong').first().text()).trim();
      // The bare text node after </em> is the domain.
      let domain = '';
      $a.contents().each((_, n) => {
        if (n.type === 'text' && n.data.trim()) domain = n.data.trim();
      });
      if (!href || !title) {
        warnings.push('Mixtape card missing href or title');
        continue;
      }
      blocks.push({ type: 'linkcard', href, title, domain });
      continue;
    }

    // --- headings ---------------------------------------------------------
    // No file mixes h3 and h4, so both map to h2 and heading order never skips.
    if (tag === 'h3' || tag === 'h4') {
      const md = inline($, el).trim();
      if (md) blocks.push({ type: 'heading', md });
      continue;
    }

    // --- lists ------------------------------------------------------------
    if (tag === 'ul' || tag === 'ol') {
      const items = [];
      $el.children('li').each((__, li) => {
        const md = inline($, li).trim();
        if (md) items.push(md);
      });
      if (items.length) blocks.push({ type: 'list', ordered: tag === 'ol', items });
      continue;
    }

    if (tag === 'pre') {
      // Newlines are <br> and the content is entity-escaped.
      const html = $el.find('code').first().html() ?? $el.html() ?? '';
      const code = $('<div>')
        .html(html.replace(/<br\s*\/?>/gi, '\n'))
        .text();
      blocks.push({ type: 'code', code: code.replace(/\s+$/, '') });
      continue;
    }

    if (tag === 'blockquote') {
      const md = inline($, el).trim();
      if (md) blocks.push({ type: 'quote', md });
      continue;
    }

    // --- paragraphs and anything else text-bearing ------------------------
    if (tag === 'p' || tag === 'label' || tag === 'div') {
      const md = inline($, el).trim();
      if (md) blocks.push({ type: 'para', md });
      continue;
    }

    warnings.push(`Unhandled block <${tag} class="${cls}">`);
  }

  return { blocks, warnings };
}
