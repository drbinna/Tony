'use strict';
/**
 * Headless session simulator.
 *
 * The Electron shell needs macOS, a display, and Accessibility permission.
 * Everything BEHIND the avatar does not — so this drives the real Brain
 * against real Fireworks calls, using the mock console tree as a stand-in for
 * what ax-dump would emit.
 *
 * It answers the open question from the README: CACHE HIT RATE. Every other
 * number in this project is measured; this one has only ever been assumed.
 *
 *   FIREWORKS_API_KEY=fw_... node test/session-sim.js
 */
const path = require('path');
const { Brain } = require('../brain/server');
const { identifyScreen, extractSignals } = require('../observer/observer');
const crypto = require('crypto');

const TREE = require('/home/claude/tony-harness/tree.json');

function hashState(screen, signals, tree) {
  const salient = tree
    .filter((n) => ['button', 'textfield', 'popupbutton', 'checkbox', 'combobox'].includes(n.role))
    .map((n) => `${n.role}:${n.label}:${n.value}`).join('|');
  return crypto.createHash('sha1').update(`${screen.key}||${signals.join(',')}||${salient}`)
    .digest('hex').slice(0, 16);
}

function makeFrame(tree, windowTitle, app = 'Google Chrome') {
  const payload = { frontmost_app: app, window_title: windowTitle, a11y_tree: tree };
  const screen = identifyScreen(payload);
  const signals = extractSignals(tree);
  return { screen, signals, tree, windowTitle, stateHash: hashState(screen, signals, tree) };
}

/** Mutate the tree the way a learner would: change the SG source to My IP. */
function applyFix(tree) {
  return tree.map((n) =>
    n.value === '0.0.0.0/0' ? { ...n, value: '203.0.113.42/32' }
      : n.value === 'Anywhere' ? { ...n, value: 'My IP' } : n);
}

const brain = new Brain({
  fireworksKey: process.env.FIREWORKS_API_KEY,
  anamKey: null,                                  // avatar layer not exercised
  personaConfig: {},
  log: { warn: () => {} },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWarm(label, timeoutMs = 90000) {
  const t0 = Date.now();
  while (brain.cache.inflight.size > 0 && Date.now() - t0 < timeoutMs) await sleep(250);
  const took = Date.now() - t0;
  console.log(`   warm(${label}) settled in ${(took / 1000).toFixed(1)}s — `
    + `${brain.cache.store.size} entries cached`);
}

async function ask(frame, question, intent) {
  const t0 = process.hrtime.bigint();
  const res = await brain.ask({ frame, question, intent });
  const dispatchMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // Anam overhead from LATENCY-FINDINGS.md: 150ms cara-4 + ~120ms TTS.
  const ANAM = 270;
  const ttfw = dispatchMs + ANAM;
  const verdict = ttfw < 250 ? 'HUMAN' : ttfw < 800 ? 'OK' : 'BROKEN';

  console.log(`\n   Q: "${question}"  [intent=${intent}]`);
  console.log(`   via=${res.via}  dispatch=${dispatchMs.toFixed(1)}ms  `
    + `TTFW=${ttfw.toFixed(0)}ms  [${verdict}]`);
  console.log(`   speaks: ${res.speak}`);

  if (res.followUp) {
    const t1 = Date.now();
    const sub = await res.followUp;
    console.log(`   substance (+${Date.now() - t1}ms): ${sub ? sub.slice(0, 120) : '(none)'}`);
  }
  return res;
}

(async () => {
  if (!process.env.FIREWORKS_API_KEY) {
    console.error('export FIREWORKS_API_KEY=fw_... first');
    process.exit(1);
  }

  console.log('='.repeat(76));
  console.log('TONY SESSION SIMULATION — real brain, real Fireworks, mock AX tree');
  console.log('='.repeat(76));

  // ---- 1. learner lands on the EC2 launch wizard -------------------------
  const f1 = makeFrame(TREE, 'Launch an instance | EC2 | us-west-2');
  console.log(`\n1. LANDS ON SCREEN  ${f1.screen.key}`);
  console.log(`   signals: ${f1.signals.join(', ') || '(none)'}`);
  console.log(`   state:   ${f1.stateHash}`);
  console.log('   -> screen-changed fires, brain.warm() starts precomputing');
  brain.warm(f1);
  await waitForWarm('screen 1');

  // ---- 2. learner asks the most common question --------------------------
  console.log('\n2. LEARNER HITS THE HOTKEY (after browsing a moment)');
  await ask(f1, 'what am I even looking at', 'what_is_this_screen');

  // ---- 3. a second, different question ------------------------------------
  console.log('\n3. LEARNER ASKS A FOLLOW-UP');
  await ask(f1, 'is this safe to launch?', 'primary_concern');

  // ---- 4. an intent we never precompute (honest miss) ---------------------
  console.log('\n4. OFF-SCRIPT QUESTION (intent not in PRECOMPUTE_INTENTS)');
  await ask(f1, 'how much will this cost me per year', 'cost_projection');

  // ---- 5. learner fixes the SG -> state changes -> cache invalidates ------
  const f2 = makeFrame(applyFix(TREE), 'Launch an instance | EC2 | us-west-2');
  console.log(`\n5. LEARNER CHANGES SOURCE TO MY IP`);
  console.log(`   signals now: ${f2.signals.join(', ') || '(none)'}`);
  console.log(`   state:       ${f2.stateHash}  (was ${f1.stateHash})`);
  console.log('   -> state-changed fires; old cache entries no longer match');
  brain.warm(f2);
  await waitForWarm('screen 2');
  await ask(f2, 'what am I even looking at', 'what_is_this_screen');

  // ---- 6. safety gate ------------------------------------------------------
  console.log('\n6. SAFETY GATE (server-side, independent of the prompt)');
  brain.session.accountKind = 'own_account';
  const drive = { type: 'click', element_id: 'e12' };
  console.log(`   own_account + ${JSON.stringify(drive)}`);
  console.log(`   -> sanitized: ${JSON.stringify(brain.sanitizeAction(drive))}`);
  brain.session.accountKind = 'sandbox';
  console.log(`   sandbox    + ${JSON.stringify(drive)}`);
  console.log(`   -> sanitized: ${JSON.stringify(brain.sanitizeAction(drive))}`);

  // ---- report --------------------------------------------------------------
  console.log('\n' + '='.repeat(76));
  console.log('CACHE REPORT — the open question, finally measured');
  console.log('='.repeat(76));
  const r = brain.cache.report();
  for (const [k, v] of Object.entries(r)) console.log(`  ${k.padEnd(14)} ${v}`);
  console.log('='.repeat(76));
})();
