// Un-draft the GitHub Release electron-builder created for this tag so the
// auto-update feed (latest-mac.yml + the .zip) is actually public — drafts are
// invisible to electron-updater. electron-builder's github publish defaults to
// a DRAFT and its multi-arch build can race into TWO draft objects for one tag;
// keep the one carrying latest-mac.yml, delete the strays, publish it, mark it
// latest. Idempotent. Runs only on tag pushes.
const token = process.env.GH_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;   // "drbinna/Tony"
const tag = process.env.RELEASE_TAG;          // "v0.1.3"
if (!token || !repo || !tag) throw new Error('GH_TOKEN, GITHUB_REPOSITORY, RELEASE_TAG required');

const api = `https://api.github.com/repos/${repo}`;
const h = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };

const releases = await (await fetch(`${api}/releases?per_page=30`, { headers: h })).json();
const mine = releases.filter((r) => r.tag_name === tag);
if (!mine.length) throw new Error(`no release found for tag ${tag}`);

// The complete one has the update manifest; prefer it, else the first.
const complete = mine.find((r) => r.assets?.some((a) => a.name === 'latest-mac.yml')) || mine[0];

for (const r of mine) {
  if (r.id === complete.id) continue;
  await fetch(`${api}/releases/${r.id}`, { method: 'DELETE', headers: h });
  console.log(`deleted stray draft ${r.id}`);
}

const out = await (await fetch(`${api}/releases/${complete.id}`, {
  method: 'PATCH',
  headers: { ...h, 'Content-Type': 'application/json' },
  body: JSON.stringify({ draft: false, make_latest: 'true' }),
})).json();

console.log(`published ${out.tag_name} draft=${out.draft} -> ${out.html_url}`);
if (out.draft !== false) throw new Error('release did not publish');
