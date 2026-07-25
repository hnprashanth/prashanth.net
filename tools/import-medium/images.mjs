/** Image collection, download and local naming. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';

const UA = 'prashanth.net-import/1.0';

/**
 * Medium still serves the legacy CDN, but only at the width baked into the URL.
 * Rewriting the size segment to /max/2000/ returns the largest stored variant.
 * Verified 200 for every URL in this export.
 */
export function upscaleUrl(url) {
  return url.replace(/\/(?:max|fit)\/(?:c\/)?\d+(?:\/\d+)?\//, '/max/2000/');
}

/** Magic-byte sniffing. Content-Type is a fallback; the URL extension is a last resort. */
function sniffExt(buf, contentType, url) {
  if (buf.length >= 12) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
    if (buf.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
    if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP')
      return 'webp';
  }
  const byType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
  if (contentType && byType[contentType.split(';')[0].trim()]) return byType[contentType.split(';')[0].trim()];
  const m = url.match(/\.(jpe?g|png|gif|webp)(?:$|\?)/i);
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  return null;
}

function kebab(s, max = 48) {
  const k = (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return k.slice(0, max).replace(/-$/, '') || 'image';
}

async function fetchWithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return { buf, contentType: res.headers.get('content-type') };
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 500 * 3 ** i));
    }
  }
  throw lastErr;
}

const exists = (p) =>
  access(p).then(
    () => true,
    () => false,
  );

/**
 * Downloader with an on-disk manifest so re-runs are idempotent.
 * `raw` images (animated GIFs) go to public/ to bypass sharp, which would
 * flatten them to a single frame.
 */
export class ImageStore {
  constructor({ assetsDir, publicDir, manifestPath, concurrency = 6 }) {
    this.assetsDir = assetsDir;
    this.publicDir = publicDir;
    this.manifestPath = manifestPath;
    this.concurrency = concurrency;
    this.manifest = {};
    this.queue = [];
    this.seen = new Map();
  }

  async load() {
    try {
      this.manifest = JSON.parse(await readFile(this.manifestPath, 'utf8'));
    } catch {
      this.manifest = {};
    }
  }

  /**
   * Register an image. Returns the path the Markdown should reference.
   * `mediumId` is case-sensitive base62 and is hashed rather than lowercased,
   * because APFS is case-insensitive and two ids could otherwise collide.
   */
  register({ url, mediumId, slug, index, label, raw = false }) {
    const key = mediumId || url;
    if (this.seen.has(key)) return this.seen.get(key);

    const hash = createHash('sha256').update(key).digest('hex').slice(0, 8);
    const nn = String(index).padStart(2, '0');
    const base = `${nn}-${kebab(label)}-${hash}`;

    const entry = { url: raw ? url : upscaleUrl(url), mediumId, slug, base, raw };
    this.queue.push(entry);

    // Markdown reference: relative import for assets, absolute URL for public/.
    const ref = raw ? `/images/${base}` : `../../assets/posts/${slug}/${base}`;
    this.seen.set(key, { ref, entry });
    return this.seen.get(key);
  }

  async downloadAll(log = () => {}) {
    const results = [];
    let cursor = 0;

    const worker = async () => {
      while (cursor < this.queue.length) {
        const entry = this.queue[cursor++];
        const cached = this.manifest[entry.mediumId];
        if (cached && (await exists(path.join(process.cwd(), cached.localPath)))) {
          entry.ext = cached.ext;
          entry.localPath = cached.localPath;
          log(`  cached  ${cached.localPath}`);
          results.push(entry);
          continue;
        }

        const { buf, contentType } = await fetchWithRetry(entry.url);
        const ext = sniffExt(buf, contentType, entry.url);
        if (!ext) throw new Error(`Cannot determine image type for ${entry.url} (${contentType})`);

        const dir = entry.raw ? this.publicDir : path.join(this.assetsDir, entry.slug);
        await mkdir(dir, { recursive: true });
        const file = path.join(dir, `${entry.base}.${ext}`);
        await writeFile(file, buf);

        entry.ext = ext;
        entry.localPath = path.relative(process.cwd(), file);
        this.manifest[entry.mediumId] = {
          url: entry.url,
          localPath: entry.localPath,
          bytes: buf.length,
          ext,
          sha256: createHash('sha256').update(buf).digest('hex'),
          contentType,
        };
        log(`  saved   ${entry.localPath} (${(buf.length / 1024).toFixed(0)} KB)`);
        results.push(entry);
      }
    };

    await Promise.all(Array.from({ length: this.concurrency }, worker));
    await mkdir(path.dirname(this.manifestPath), { recursive: true });
    await writeFile(this.manifestPath, JSON.stringify(this.manifest, null, 2) + '\n');
    return results;
  }

  /** Resolve the final extension into the Markdown references, post-download. */
  finalise() {
    const map = new Map();
    for (const [key, { ref, entry }] of this.seen) {
      map.set(key, `${ref}.${entry.ext}`);
    }
    return map;
  }
}
