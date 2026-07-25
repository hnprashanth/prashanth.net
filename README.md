# prashanth.net

Personal blog. Static [Astro](https://astro.build) site, deployed to GitHub Pages.

- 22 posts imported from a Medium export (2010–2023)
- **Zero client-side JavaScript** on every page, no analytics, no third-party requests
- Self-hosted fonts, self-hosted images
- Light and dark themes via `prefers-color-scheme`, both WCAG AA

## Development

```bash
npm install
npm run dev        # local dev server
npm run build      # static build into dist/
npm run preview    # serve the built site
npm run audit      # static assertions over dist/
```

## Verification

`npm run audit` runs static checks (zero JS, resolvable assets, image dimensions,
feed integrity, per-page metadata, heading order) and gates the deploy in CI.

Browser checks need a running preview server:

```bash
npm run preview &
node tools/audit/browser-checks.mjs
```

They assert no horizontal overflow at 360/390/768px, ≥44px tap targets, WCAG AA
contrast in both colour schemes, that every image decodes, and that no page makes
a script or third-party request. Screenshots land in `tools/audit/screenshots/`.

## Content

Posts are plain Markdown in `src/content/posts/`, one file per slug, validated by
a zod schema in `src/content.config.ts`. Images live in `src/assets/posts/<slug>/`
and are optimised at build time.

See [`tools/import-medium/README.md`](tools/import-medium/README.md) for the
Medium conversion and the export quirks it handles.
