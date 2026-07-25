/**
 * Promote a paragraph that contains only an image into a real <figure>.
 *
 *   ![alt](./img.jpg "caption")   ->   <figure><img …><figcaption>caption</figcaption></figure>
 *   ![alt](./img.jpg)             ->   <figure><img …></figure>
 *
 * Markdown has no figure/figcaption syntax, and the design calls for captions
 * as a distinct element rather than a styled paragraph. The <img> node is moved,
 * never rebuilt, so Astro's image pipeline (srcset/width/height/lazy) is intact.
 *
 * A wrapping link is preserved so linked-thumbnail figures still work:
 *   [![alt](./thumb.jpg "caption")](https://…)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

// The measure is 68ch of Newsreader at up to 20px, i.e. ~680px, plus side padding
// below that breakpoint. Keeps the browser from downloading oversized variants.
const COLUMN_SIZES = '(min-width: 43rem) 680px, calc(100vw - 2 * clamp(1.25rem, 1rem + 1.1vw, 1.5rem))';

/**
 * Intrinsic size of a file in public/, read straight from its header.
 * Needed because images served from public/ skip astro:assets, so nothing
 * else supplies width/height — and without those the page shifts as it loads.
 * Only animated GIFs take this path (sharp would flatten them to one frame).
 */
function publicImageSize(src) {
  try {
    const buf = readFileSync(path.join(process.cwd(), 'public', src.replace(/^\//, '')));
    if (buf.subarray(0, 3).toString('latin1') === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Minimal inline markdown for captions: _em_, **strong**, [text](href). */
function inlineToHast(text) {
  const out = [];
  // Ordered alternation: links first so their label isn't eaten by emphasis.
  const re = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|_([^_]+)_/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: text.slice(last, m.index) });
    if (m[1] !== undefined) {
      out.push({
        type: 'element',
        tagName: 'a',
        properties: { href: m[2], rel: ['noopener'] },
        children: [{ type: 'text', value: m[1] }],
      });
    } else if (m[3] !== undefined) {
      out.push({ type: 'element', tagName: 'strong', properties: {}, children: [{ type: 'text', value: m[3] }] });
    } else {
      out.push({ type: 'element', tagName: 'em', properties: {}, children: [{ type: 'text', value: m[4] }] });
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ type: 'text', value: text.slice(last) });
  return out.length ? out : [{ type: 'text', value: text }];
}

const isElement = (n, tag) => n && n.type === 'element' && n.tagName === tag;

/** Ignore whitespace-only text nodes when deciding if a <p> holds only an image. */
const meaningful = (children) =>
  children.filter((c) => !(c.type === 'text' && c.value.trim() === ''));

export function rehypeFigures() {
  return (tree) => {
    visit(tree);
  };

  function visit(node) {
    if (!node || !Array.isArray(node.children)) return;

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      if (!isElement(child, 'p')) {
        visit(child);
        continue;
      }

      const kids = meaningful(child.children);
      if (kids.length !== 1) continue;

      // Either a bare <img> or an <a> wrapping exactly one <img>.
      let wrapper = null;
      let img = null;
      if (isElement(kids[0], 'img')) {
        img = kids[0];
      } else if (isElement(kids[0], 'a')) {
        const inner = meaningful(kids[0].children);
        if (inner.length === 1 && isElement(inner[0], 'img')) {
          wrapper = kids[0];
          img = inner[0];
        }
      }
      if (!img) continue;

      const caption = img.properties?.title;
      if (caption) delete img.properties.title;

      // Astro defaults markdown images to sizes="100vw", which makes a desktop
      // browser fetch a 2000w file for a ~680px column. Describe the real column.
      if (img.properties) {
        img.properties.sizes = COLUMN_SIZES;

        // Images served from public/ never pass through astro:assets, so they
        // arrive with none of the loading hints or intrinsic dimensions.
        const src = String(img.properties.src ?? '');
        if (src.startsWith('/')) {
          img.properties.loading ??= 'lazy';
          img.properties.decoding ??= 'async';
          if (img.properties.width == null) {
            const size = publicImageSize(src);
            if (size) {
              img.properties.width = size.width;
              img.properties.height = size.height;
            }
          }
        }
      }

      const figureChildren = [wrapper ?? img];
      if (caption) {
        figureChildren.push({
          type: 'element',
          tagName: 'figcaption',
          properties: {},
          children: inlineToHast(String(caption)),
        });
      }

      node.children[i] = {
        type: 'element',
        tagName: 'figure',
        properties: {},
        children: figureChildren,
      };
    }
  }
}
