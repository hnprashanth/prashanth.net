# Medium import

Converts `medium-export/posts/*.html` into `src/content/posts/*.md` plus local images.

```bash
node tools/import-medium/import.mjs [--dry-run] [--only=<slug>] [--no-download]
```

Idempotent: images recorded in `manifest.json` are not re-fetched.

> `medium-export/` is gitignored. It contains an IP-address history and session
> logs, and this repository is public.

## What gets skipped

Of the 28 exported files, 22 become posts:

| Skipped | Why |
| --- | --- |
| 3 × `draft_*.html` | No `footer a.p-canonical` — the definitive published test |
| `2016-07-13_5-reasons…b9f0dce45b57` | Re-publish of the 2016-07-08 post; no images |
| `2017-05-11_Tried-this-recipe…` | A Medium *response*, not a post |
| `2017-08-16_Journey-of-Incorporating…` | A Medium *series* (canonical is `/series/`) |

## Export quirks this handles

- **`h3.graf--title`** duplicates the H1 in the body — dropped.
- **Headings**: no file mixes `h3` and `h4`, so both map to `##` and heading
  levels never skip.
- **WordPress `[caption]` shortcodes** survived Medium's import as literal
  paragraphs in 3 files. The opener is dropped and the closer's text becomes the
  figure's caption, recovering 5 captions that have no `<figcaption>`.
- **Smiley GIFs**: two 15×15 WordPress emoticons were promoted to full-width
  figures. Any figure whose image is ≤20px wide is demoted back to its alt text
  (`:P`, `:-)`) and appended to the preceding paragraph.
- **Invisible characters**: 41 NBSP and 36 HAIR SPACE are normalised to plain
  spaces, otherwise they leave odd gaps around em dashes.
- **Images**: the size segment of every `cdn-images-1.medium.com` URL is
  rewritten to `/max/2000/`, the largest variant Medium still stores. The
  `data-external-src` originals are dead (404) and are never used.
- **Animated GIF**: `0*TnjyMCx5l3UtaMmP.gif` is a 39-frame animation. It is
  written to `public/images/` instead of `src/assets/`, because Astro's sharp
  pipeline would flatten it to a single frame.
- **Extensionless URLs**: three CDN URLs end in a bare `.`. File type comes from
  magic-byte sniffing, falling back to Content-Type, then the URL.
- **YouTube embeds** become plain links. An `<iframe>` would load third-party
  JavaScript and set tracking cookies, which the zero-JS/no-analytics rule
  forbids. One video (`gu8KqV90pKk`) is dead upstream and is dropped with a warning.
- **Medium "mixtape" link cards** become plain sentences, since the design
  forbids cards and boxes.

## overrides.json

Hand-recorded, per slug, with the reason on each entry:

- `description` — replaces the derived excerpt where the opening sentence makes a
  poor homepage summary.
- `remove` — exact text fragments to delete. Currently one: injected SEO spam (a
  Swedish payday-loan link) carried over from the old WordPress blog. The import
  fails loudly if a fragment is not found, so it can never silently stop applying.
