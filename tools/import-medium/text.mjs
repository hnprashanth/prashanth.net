/** Text normalisation and inline HTML -> Markdown conversion. */

// The export contains 41 NBSP and 36 HAIR SPACE characters. Left alone they
// survive into Markdown and show up as odd gaps around em dashes.
const INVISIBLE = /[  -   　]/g;

export function normaliseSpace(s) {
  return s.replace(INVISIBLE, ' ').replace(/[ \t]+/g, ' ');
}

/**
 * Escape characters that would otherwise be read as Markdown syntax.
 * Deliberately conservative: we escape leading block markers and the inline
 * emphasis/link characters, and leave the author's smart quotes alone.
 */
function escapeText(s) {
  return s
    .replace(/([\\`*_[\]<>])/g, '\\$1')
    .replace(/^(\s*)([-+])(\s)/gm, '$1\\$2$3')
    .replace(/^(\s*)(\d+)\.(\s)/gm, '$1$2\\.$3')
    .replace(/^(\s*)(#{1,6})(\s)/gm, '$1\\$2$3');
}

/** Convert a cheerio node's children to inline Markdown. */
export function inline($, node, { escape = true } = {}) {
  let out = '';

  $(node)
    .contents()
    .each((_, el) => {
      if (el.type === 'text') {
        const t = normaliseSpace(el.data);
        out += escape ? escapeText(t) : t;
        return;
      }
      if (el.type !== 'tag') return;

      const $el = $(el);
      switch (el.tagName) {
        case 'br':
          // A genuine soft break (only the Simplenote post has these).
          out += '\\\n';
          break;
        case 'strong':
        case 'b': {
          const inner = inline($, el, { escape }).trim();
          out += inner ? `**${inner}**` : '';
          break;
        }
        case 'em':
        case 'i': {
          const inner = inline($, el, { escape }).trim();
          out += inner ? `_${inner}_` : '';
          break;
        }
        case 'code': {
          out += `\`${$el.text()}\``;
          break;
        }
        case 'a': {
          const href = $el.attr('href');
          const inner = inline($, el, { escape }).trim();
          if (!href) out += inner;
          else if (!inner) out += '';
          else out += `[${inner}](${href})`;
          break;
        }
        case 'span':
        default:
          // graf-dropCap spans and anything unexpected: keep the text.
          out += inline($, el, { escape });
      }
    });

  return out;
}

/**
 * Derive the homepage excerpt: a single sentence.
 * Medium auto-truncates most subtitles, so only a genuinely authored one is used.
 */
export function deriveDescription({ subtitle, firstParagraph }) {
  const genuine =
    subtitle &&
    !subtitle.endsWith('…') &&
    !subtitle.endsWith('...') &&
    !firstParagraph.startsWith(subtitle.slice(0, 40));

  if (genuine) return collapse(subtitle);
  return firstSentence(firstParagraph);
}

function collapse(s) {
  return normaliseSpace(s).replace(/\s+/g, ' ').trim();
}

/** First sentence, capped at ~165 chars on a word boundary, never mid-word. */
export function firstSentence(text, max = 165) {
  const t = collapse(text);
  if (!t) return '';

  // Sentence end = . ! ? followed by space+capital, or end of string.
  // Avoids splitting on decimals, "St.Mary's", "Relive.cc", "e.g." etc.
  const m = t.match(/^(.{20,}?[.!?])(?=\s+[A-Z“"'(])/);
  let s = m ? m[1] : t;

  if (s.length <= max) return s;

  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).replace(/[,;:—–-]$/, '').trim() + '…';
}
