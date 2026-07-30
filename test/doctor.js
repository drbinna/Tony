'use strict';
/**
 * tony doctor — diagnose a failing launch without opening DevTools.
 *   npm run doctor
 */
require('dotenv').config();
const { execFileSync } = require('child_process');
const path = require('path');
const { identifyScreen, extractSignals } = require('../observer/observer');

const ok = (m) => console.log(`  \x1b[32mok\x1b[0m    ${m}`);
const bad = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const warn = (m) => console.log(`  \x1b[33mwarn\x1b[0m  ${m}`);

// Doctor reads the FRONTMOST window. Run from Terminal and Terminal is always
// frontmost, which makes section 3 useless. Count down so the operator can
// focus the browser first.
const WAIT = process.argv.includes('--now') ? 0
  : Number((process.argv.find((a) => a.startsWith('--wait=')) || '--wait=6').split('=')[1]);

console.log('\nTONY DOCTOR\n' + '='.repeat(60));

async function countdown(sec) {
  if (!sec) return;
  console.log(`\nSwitch to Chrome with the AWS console open. Reading in ${sec}s...`);
  for (let i = sec; i > 0; i -= 1) {
    process.stdout.write(`\r  ${i}... `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.stdout.write('\r  reading now.   \n');
}

async function main() {
// 1. env
console.log('\n1. environment');
const fw = process.env.FIREWORKS_API_KEY || '';
const an = process.env.ANAM_API_KEY || '';
fw.startsWith('fw_') ? ok(`FIREWORKS_API_KEY present (${fw.length} chars)`)
  : bad('FIREWORKS_API_KEY missing or malformed — .env not loaded?');
an.length > 20 ? ok(`ANAM_API_KEY present (${an.length} chars)`)
  : bad('ANAM_API_KEY missing — avatar will stay black');
process.env.ANAM_AVATAR_ID ? ok(`avatar ${process.env.ANAM_AVATAR_ID}`) : warn('ANAM_AVATAR_ID unset');
process.env.ANAM_VOICE_ID ? ok(`voice  ${process.env.ANAM_VOICE_ID}`) : warn('ANAM_VOICE_ID unset');

await countdown(WAIT);

// 2. observer
console.log('\n2. observer (ax-dump)');
let payload = null;
try {
  const out = execFileSync(path.join(__dirname, '..', 'observer', 'ax-dump'),
    { timeout: 6000, maxBuffer: 8e6 }).toString();
  payload = JSON.parse(out);
  if (payload.error) {
    bad(`helper returned: ${payload.error}`);
    if (String(payload.error).includes('permission')) {
      console.log('        -> System Settings > Privacy & Security > Accessibility');
      console.log('        -> enable Electron/Tony, then QUIT and relaunch the app');
    }
  } else {
    ok(`frontmost: ${payload.frontmost_app}`);
    ok(`title:     ${payload.window_title || '(none)'}`);
    payload.document_url
      ? ok(`url:       ${payload.document_url.slice(0, 90)}`)
      : warn('url: (none) — browser did not expose AXDocument/AXURL; title fallback in use');
    payload.a11y_tree.length
      ? ok(`tree:      ${payload.a11y_tree.length} elements${payload.truncated ? ' (TRUNCATED)' : ''}`)
      : bad('tree: 0 elements — Chromium may not have populated its AX tree yet');
  }
} catch (e) {
  bad(e.code === 'ENOENT'
    ? 'ax-dump not built — run: bash observer/build.sh'
    : `helper failed: ${e.message.slice(0, 160)}`);
}

// 3. detection
if (payload && !payload.error) {
  console.log('\n3. screen detection');
  const screen = identifyScreen(payload);
  const signals = extractSignals(payload.a11y_tree);
  screen.aws ? ok(`DETECTED as AWS -> ${screen.key}`)
    : bad(`NOT detected as AWS -> ${screen.key}  (Tony stays DORMANT)`);
  console.log(`        signals: ${signals.join(', ') || '(none)'}`);
}

// 4. anam
console.log('\n4. anam');
  if (!an) { bad('skipped — no key'); return finish(); }
  try {
    const r = await fetch('https://api.anam.ai/v1/auth/session-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${an}` },
      body: JSON.stringify({
        personaConfig: {
          name: 'Tony',
          avatarId: process.env.ANAM_AVATAR_ID,
          avatarModel: process.env.ANAM_AVATAR_MODEL || 'cara-4',
          voiceId: process.env.ANAM_VOICE_ID,
          llmId: 'CUSTOMER_CLIENT_V1',
        },
      }),
    });
    const body = await r.text();
    r.ok ? ok(`session token minted (${r.status})`)
         : bad(`token mint failed ${r.status}: ${body.slice(0, 240)}`);
  } catch (e) {
    bad(`network: ${e.message}`);
  }
  finish();
}

main().catch((e) => console.error(e));

function finish() {
  console.log('\n' + '='.repeat(60));
  console.log('Any FAIL above explains the symptom.');
  console.log('Use --now to skip the countdown, --wait=N to change it.\n');
}
