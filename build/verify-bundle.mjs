// Static guard against the "Cannot find module './updater'" class of crash:
// every root-level require('./X') in an entry file must be in electron-builder's
// `build.files` allowlist, or it won't be packaged into app.asar and the app
// dies on launch. Root files are whitelisted individually (dir globs don't cover
// them), so this is easy to forget. Runs with no build — cheap CI gate.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const listed = new Set(pkg.build.files.filter((f) => !f.startsWith('!')));

// Entry points electron loads directly (main + preloads). Their root requires
// must all be packaged.
const ENTRIES = ['main.js', 'preload.js', 'setup-preload.js'];
let fail = 0;

for (const entry of ENTRIES) {
  let src;
  try {
    src = readFileSync(new URL(`../${entry}`, import.meta.url), 'utf8');
  } catch {
    continue;
  }
  const re = /require\(\s*['"]\.\/([a-zA-Z0-9_-]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const covered =
      listed.has(`${name}.js`) ||          // e.g. "updater.js"
      listed.has(name) ||                   // exact (unlikely for a root file)
      [...listed].some((p) => p.startsWith(`${name}/`)); // a directory glob like "brain/**/*"
    if (!covered) {
      console.error(`❌ ${entry} requires './${name}' but '${name}.js' is not in package.json build.files`);
      fail = 1;
    }
  }
}

if (fail) {
  console.error('BUNDLE GUARD FAILED — add the missing file(s) to build.files or the packaged app will crash on launch.');
  process.exit(1);
}
console.log('bundle guard passed — every root require is in the packaged allowlist');
