// Point the landing page's download links + redirects at STABLE filenames so a
// version bump never needs a manual site edit. Idempotent: the DMG release
// workflow runs this after uploading to Blob; the first run flips the live
// versioned links (e.g. Tony-0.1.0-arm64.dmg) to stable ones (Tony-arm64.dmg),
// and every run after that is a no-op. Because the flip and the Blob upload
// happen in the same workflow run, there is no window where a link 404s.
import { readFileSync, writeFileSync } from 'node:fs';

let changed = false;
for (const f of ['site/index.html', 'site/vercel.json']) {
  const before = readFileSync(f, 'utf8');
  const after = before
    // index.html hrefs + vercel.json redirect sources/destinations
    .replace(/Tony-\d+\.\d+\.\d+-arm64\.dmg/g, 'Tony-arm64.dmg')
    .replace(/Tony-\d+\.\d+\.\d+-x64\.dmg/g, 'Tony-x64.dmg')
    .replace(/tony-extension-[\d.]+\.zip/g, 'tony-extension.zip');
  if (after !== before) { writeFileSync(f, after); changed = true; console.log('normalized', f); }
}
if (!changed) console.log('site links already stable — no changes');
