# Tony landing site

The marketing landing page for Tony — a single self-contained static `index.html`
(inline CSS, no framework), a demo video, and a `downloads/` folder.

Deployed to the Vercel project **`tony-site`** (aliases: `tony-site-ten.vercel.app`,
`tony-site-obis-projects-1a457e7e.vercel.app`).

## Layout

```
site/
  index.html                        the whole page (inline <style>)
  demo.mp4                           hero demo video (served static)
  vercel.json                       redirects the Mac DMGs to Vercel Blob
  downloads/
    tony-extension-<ver>.zip         the Chrome extension (served static)
```

The **Mac DMGs are NOT in the repo** — they're large, so they live in Vercel Blob
storage and `vercel.json` 307-redirects `/downloads/Tony-<ver>-<arch>.dmg` to them.
The **extension zip is a static file** here, checked in alongside the site.

## Updating the extension download (the common change)

When `extension/manifest.json` bumps the version and CI builds a new
`dist/tony-extension-<new>.zip`:

1. `cp ../dist/tony-extension-<new>.zip downloads/` (and delete the old one)
2. Update the two `href="downloads/tony-extension-<new>.zip"` in `index.html`
3. Deploy (below)

## Deploy

```
cd site
vercel deploy --yes           # preview — verify links, then:
vercel deploy --prod --yes    # production
```

Verify before promoting: root `200`, `downloads/tony-extension-<ver>.zip` `200`,
`demo.mp4` `200`, and both `downloads/Tony-*.dmg` `307` → blob.

> The Vercel project link (`.vercel/`) is git-ignored — it's per-machine. On a
> fresh checkout, `vercel link` to the `tony-site` project once before deploying,
> or connect this repo to the project in the Vercel dashboard so pushes deploy it.
