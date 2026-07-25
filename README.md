# prashanth.net

Personal blog — [prashanth.net](https://prashanth.net). Static [Astro](https://astro.build) site
on GitHub Pages, with **zero client-side JavaScript**, no analytics, and no third-party requests.

---

## Writing a new post

**1. Create the file.** One Markdown file per post, in `src/content/posts/`.
The filename must be the slug:

```
src/content/posts/my-new-post.md      ->  https://prashanth.net/posts/my-new-post
```

**2. Write the frontmatter.** All five fields are required and validated at build time:

```markdown
---
title: "My New Post"
date: 2026-07-25T10:00:00.000Z
description: "One sentence. This is the excerpt shown on the homepage and in the feed."
slug: "my-new-post"
draft: false
---
```

| Field | Notes |
| --- | --- |
| `title` | Rendered as the page `<h1>`. Don't repeat it in the body. |
| `date` | ISO 8601. Drives ordering (newest first) and the feed's `pubDate`. |
| `description` | **One sentence.** It's the homepage excerpt, the `<meta name="description">`, and the RSS summary. Keep it under ~165 characters. |
| `slug` | Lowercase, hyphenated. **Must match the filename.** |
| `draft` | `true` keeps the post out of the build entirely — no page, no feed entry, no sitemap entry. |

**3. Write the body in Markdown.** Start headings at `##` — `#` is reserved for the title:

```markdown
Opening paragraph, which is usually what the description paraphrases.

## A section heading

Some prose with _emphasis_, **strong**, and a [link](https://example.com).

- a list
- another item
```

**4. Preview it.**

```bash
npm run dev          # http://localhost:4321, live reload
```

**5. Publish.** Commit and push to `main`. GitHub Actions builds, runs the audit,
and deploys. Usually live in under a minute.

```bash
git add src/content/posts/my-new-post.md
git commit -m "Post: My New Post"
git push
```

---

## Images

Put them in `src/assets/posts/<slug>/` and reference them **relative to the Markdown file**:

```markdown
![Descriptive alt text](../../assets/posts/my-new-post/photo.jpg)
```

Astro converts them to WebP at build time and generates a 7-width `srcset`, plus
`width`/`height` (so the page doesn't shift) and `loading="lazy"`. You don't need to
resize anything first — drop in the original and let the build handle it.

### Captions

A third argument in quotes becomes a real `<figcaption>`:

```markdown
![Alt text](../../assets/posts/my-new-post/photo.jpg "The caption. _Photo: Someone_")
```

Captions support `_emphasis_`, `**strong**`, and `[links](https://example.com)`.

### Animated GIFs — the one exception

Astro's image pipeline flattens animated GIFs to a single frame. Put them in
`public/images/` instead and use an absolute path:

```markdown
![Alt text](/images/my-animation.gif "Caption")
```

The build reads their dimensions from the file, so they still get `width`/`height`
and lazy loading. Everything else should go in `src/assets/`.

---

## Linking to your own posts

Use site-relative paths, never the full domain:

```markdown
[as I wrote before](/posts/some-other-post)     ← correct
[as I wrote before](https://prashanth.net/…)    ← audit will reject this
```

Absolute self-links are rejected because they bypass the link checker — which is
how a batch of dead links survived the Medium migration unnoticed.

---

## Checks

```bash
npm run build       # static build into dist/
npm run audit       # 37 static assertions over dist/
npm run preview     # serve the built site
```

`npm run audit` gates the deploy in CI. It fails on: any JavaScript reaching the
browser, a broken internal link or missing image, an image without dimensions or
lazy loading, a canonical URL that disagrees with the sitemap, a filename that
doesn't match its slug, a skipped heading level, or a missing feed entry.

Browser checks need a running preview server:

```bash
npm run preview &
node tools/audit/browser-checks.mjs
```

These assert no horizontal scrolling at 360/390/768px, tap targets of at least
44px, WCAG AA contrast in light and dark, that every image decodes, and that no
page makes a script or third-party request. Screenshots land in
`tools/audit/screenshots/`.

---

## Things the design deliberately doesn't do

Worth knowing before reaching for them, since the audit enforces most of it:

- **No client-side JavaScript.** No embeds, no analytics, no comment widgets, no
  view transitions. A YouTube `<iframe>` would breach this — link out instead.
- **No third-party requests.** Fonts and images are self-hosted. Don't hotlink.
- **No cards, boxes, or icons.** Single centred column, generous spacing.
- **One accent colour**, used only on link underlines and nowhere else.
- **Dark mode follows the OS** via `prefers-color-scheme`. There's no toggle,
  because a toggle needs JavaScript.

Colours, type scale and spacing are custom properties at the top of
`src/styles/global.css`. Both themes are contrast-checked, so after changing a
colour, run the browser checks.

---

## Layout

```
src/
  content/posts/       the posts — plain Markdown, one file per slug
  assets/posts/<slug>/ images, optimised at build time
  pages/               index, about, 404, rss.xml, posts/[...slug]
  layouts/ components/ shared shell, head, footer, date
  styles/global.css    the entire stylesheet
public/                CNAME, fonts, favicon, animated GIFs
tools/audit/           the checks described above
tools/import-medium/   one-off Medium archive import (see its README)
```

The 15 posts here came from a Medium export covering 2010–2023. That was a
one-time migration; `tools/import-medium/` documents it and is kept for
reference, but writing new posts doesn't involve it.
