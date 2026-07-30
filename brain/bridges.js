'use strict';
/**
 * Bridge lines — spoken instantly on a cache miss while the slow brain works.
 *
 * WHY THESE ARE HARDCODED:
 * The latency harness measured an LLM-generated bridge line at ~750ms TTFW
 * (480ms model + 270ms Anam). A hardcoded line goes out via anamClient.talk()
 * at the 270ms floor — the same speed as a cache hit. We were paying 480ms of
 * inference to say something we already knew we were going to say.
 *
 * Rules for adding lines:
 *  - 8 words maximum. Longer bridges outlive the wait they cover.
 *  - Must reference something visible, or it reads as empty filler.
 *  - No "Great question", no apologies, no "let me think about that".
 *  - Rotate: repetition is what kills a character (measured — v1 of the prompt
 *    told the same anecdote 4/4 times and it was instantly grating).
 */

const POOL = {
  'ec2:launch_wizard': [
    'Reading your launch config.',
    'Checking what this wizard has so far.',
    'Looking at your instance settings.',
  ],
  'ec2:security_groups': [
    'Reading your security group rules.',
    'Checking who can reach this box.',
    'Looking at those inbound rules.',
  ],
  's3:create_bucket': [
    'Reading your bucket settings.',
    'Checking the access config.',
  ],
  'iam:policy_editor': [
    'Parsing that policy document.',
    'Reading what this policy actually grants.',
  ],
  'vpc:listing': ['Looking at your network layout.'],
  'route53:listing': ['Checking your DNS records.'],
  'cloudfront:listing': ['Reading your distribution settings.'],
};

const GENERIC = [
  'Reading the screen.',
  'Checking what you have here.',
  'One second, looking.',
];

/** Per-session rotation state so the same bridge never lands twice in a row. */
const cursors = new Map();

/**
 * @param {string} sessionId
 * @param {string} screenKey  e.g. "ec2:launch_wizard"
 * @returns {string} a bridge line, 8 words or fewer
 */
function pickBridge(sessionId, screenKey) {
  const pool = POOL[screenKey] || GENERIC;
  const k = `${sessionId}:${screenKey}`;
  const i = (cursors.get(k) ?? -1) + 1;
  cursors.set(k, i);
  return pool[i % pool.length];
}

function clearSession(sessionId) {
  for (const k of cursors.keys()) {
    if (k.startsWith(`${sessionId}:`)) cursors.delete(k);
  }
}

module.exports = { pickBridge, clearSession, POOL, GENERIC };
