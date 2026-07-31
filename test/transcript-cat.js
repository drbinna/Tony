#!/usr/bin/env node
'use strict';
/**
 * Render a session transcript as a readable conversation.
 *
 *   npm run transcript                 # newest session in transcripts/
 *   npm run transcript -- <file>       # a specific .jsonl
 *
 * The JSONL is the source of truth; this is just eyes on it. Timings shown are
 * the ones that matter when debugging: dispatch (should sit at the ~270ms
 * floor), follow-up (the real wait behind a bridge), precompute (5-21s slow
 * brain, off the critical path).
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.TONY_TRANSCRIPT_DIR || path.join(__dirname, '..', 'transcripts');

function newestTranscript() {
  if (!fs.existsSync(DIR)) return null;
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort();
  return files.length ? path.join(DIR, files[files.length - 1]) : null;
}

const file = process.argv[2] || newestTranscript();
if (!file || !fs.existsSync(file)) {
  console.error('No transcript found. Run the app first, or pass a .jsonl path.');
  process.exit(1);
}

const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
console.log(`# ${path.basename(file)}  (${lines.length} events)\n`);

let lastCache = null;
for (const line of lines) {
  let e;
  try { e = JSON.parse(line); } catch { console.log(`   [unparseable] ${line.slice(0, 80)}`); continue; }
  const at = clock(e.ms);

  switch (e.type) {
    case 'session-start':
      console.log(`${at}  SESSION ${e.session}  mode=${e.mode} account=${e.accountKind} ax=${e.accessibility}`);
      break;
    case 'screen':
      console.log(`${at}  ── screen: ${e.aws ? `${e.service}/${e.page}` : 'off-console'}  (${e.nodes} nodes)`);
      break;
    case 'left-console':
      console.log(`${at}  ── left console`);
      break;
    case 'ask':
      console.log(`${at}  YOU  (${e.source})  ${e.question}`);
      break;
    case 'answer':
      lastCache = e.cache;
      console.log(`${at}  TONY (${e.via}, ${e.dispatchMs}ms)  ${e.text}`);
      break;
    case 'followup':
      if (e.failed) console.log(`${at}       ↳ follow-up FAILED after ${e.tookMs}ms (bridge was the whole answer)`);
      else console.log(`${at}       ↳ +${e.tookMs}ms  ${e.text}`);
      break;
    case 'speak':
      // 'answer' already printed the text for asks; only proactive speech
      // (interventions) has no matching answer line context of its own.
      if (e.proactive) console.log(`${at}  TONY (proactive)  ${e.text}`);
      break;
    case 'precompute':
      console.log(`${at}       · warm ${e.intent} on ${e.screen}: ${e.ok ? 'ok' : `FAILED${e.error ? ` (${e.error})` : ' (unparseable output)'}`} in ${e.tookMs}ms`);
      break;
    case 'parse-failed':
      console.log(`${at}       · PARSE FAILED in ${e.where}: ${e.raw?.slice(0, 120)}...`);
      break;
    case 'pointer':
      console.log(`${at}       · ${e.ring ? `ring on ${e.element} "${e.label}"` : `NO RING — ${e.element} not in tree (${e.treeNodes} nodes)`}`);
      break;
    case 'heard-dropped':
      console.log(`${at}  YOU  (voice, DROPPED — ${e.reason})  ${e.question}`);
      break;
    case 'deadman-abort':
      console.log(`${at}  ── deadman abort (${e.reason})`);
      break;
    case 'anam':
      console.log(`${at}  ── anam: ${e.event}`);
      break;
    case 'session-end':
      lastCache = e.cache ?? lastCache;
      console.log(`${at}  SESSION END`);
      break;
    default:
      console.log(`${at}  [${e.type}] ${JSON.stringify(e).slice(0, 100)}`);
  }
}

if (lastCache) {
  console.log(`\ncache: ${lastCache.hitRate} hit rate — ${lastCache.hits} hits / ${lastCache.misses} misses`
    + ` (${lastCache.stale} stale, ${lastCache.precomputed} precomputed, ${lastCache.warmFailed} warm failures)`);
  if (lastCache.lastWarmError && lastCache.lastWarmError !== 'none') {
    console.log(`last warm error: ${lastCache.lastWarmError}`);
  }
}
