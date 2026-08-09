// Upload a built artifact to Vercel Blob under a STABLE key, overwriting the
// previous release. The landing page's /downloads redirects point at these
// stable keys, so "latest" always resolves without editing the site per bump.
//
//   node build/upload-blob.mjs <file> <blobKey>
//
// Needs BLOB_READ_WRITE_TOKEN in the environment (a GitHub Actions secret).
import { put } from '@vercel/blob';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const [file, key] = process.argv.slice(2);
if (!file || !key) {
  console.error('usage: node build/upload-blob.mjs <file> <blobKey>');
  process.exit(1);
}
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!token) {
  console.error('BLOB_READ_WRITE_TOKEN is not set');
  process.exit(1);
}

const contentType = key.endsWith('.dmg')
  ? 'application/x-apple-diskimage'
  : key.endsWith('.zip') ? 'application/zip' : 'application/octet-stream';

const { url } = await put(key, readFileSync(file), {
  access: 'public',
  token,
  addRandomSuffix: false,   // stable pathname → stable URL
  allowOverwrite: true,     // each release overwrites "latest"
  contentType,
});
console.log(`uploaded ${basename(file)} -> ${url}`);
