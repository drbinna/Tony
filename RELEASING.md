# Releasing Tony

Two artifacts reach users from the landing page, published by CI:

- **Chrome extension** — `site/downloads/tony-extension.zip`, served straight
  from the git-connected `site/` folder.
- **macOS app** — `Tony-arm64.dmg` / `Tony-x64.dmg` in Vercel Blob, which the
  `site/vercel.json` `/downloads` redirects resolve to.

Both use **stable filenames**, so a version bump never edits the site by hand.

## Extension — automatic, no secrets

`.github/workflows/publish-extension.yml` runs on any push to `main` that
touches `extension/**`. It rebuilds `site/downloads/tony-extension.zip` and
commits it back; Vercel redeploys. Nothing to configure.

> Unpacked extensions do **not** auto-update. Existing users must re-download
> the zip and reload it at `chrome://extensions`. Bump `version` in
> `extension/manifest.json` when you want that visible.

## macOS DMG — on a version tag

`.github/workflows/release-dmg.yml` runs on tags matching `v*` (or via the
Actions "Run workflow" button). It builds + signs + notarizes both arch DMGs,
staples them, uploads to Blob under the stable keys, and points the site links
at those keys (idempotent — a no-op after the first release).

### One-time: add these repository secrets

Settings → Secrets and variables → Actions:

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | base64 of the Developer ID Application `.p12` (see below) |
| `CSC_KEY_PASSWORD` | password for that `.p12` |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | `8938U82HGG` |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob read-write token (Vercel → Storage → your Blob store → Tokens) |

Export the signing certificate to `CSC_LINK`:

```sh
# Keychain Access → My Certificates → "Developer ID Application: …" →
# right-click → Export → save as cert.p12 (set a password = CSC_KEY_PASSWORD).
base64 -i cert.p12 | pbcopy       # paste as the CSC_LINK secret
```

### Cutting a release

```sh
npm version patch      # bumps package.json (0.1.0 → 0.1.1) and tags v0.1.1
git push && git push --tags
```

The tag push triggers the workflow. When it finishes, the landing page's
download buttons serve the new build (stable URLs, no site edit needed). The
first release also rewrites the live `Tony-0.1.0-*.dmg` links to the stable
`Tony-*.dmg` names in the same run, so there is never a broken-download window.

### Local fallback

The old local path still works if you'd rather not use CI:
`npm run dist` → `bash build/notarize.sh` (needs `build/notarize.env`) → upload
the DMGs to Blob yourself.
