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
 * WHY THEY ARE NO LONGER SCREEN-FLAVORED:
 * v1 keyed lines to the screen ("Looking at those inbound rules") to sound
 * grounded. Live sessions proved the opposite: the line fires BEFORE any
 * reading happens, so it claims an observation that hasn't occurred — and
 * when the screen key misidentifies, it narrates the wrong page entirely.
 * Fake specificity reads as robotic; an honest beat in Tony's voice does not.
 *
 * Rules for adding lines:
 *  - 5 words maximum. The bridge covers 5-20s of thinking; it is a beat,
 *    not a sentence.
 *  - Claim NOTHING: no "reading", no "checking", nothing that asserts an
 *    action is underway on a specific thing.
 *  - No "Great question", no apologies, no "let me think about that".
 *  - Rotate: repetition is what kills a character.
 */

const POOL = [
  'Working.',
  'Sec.',
  'Gimme a beat.',
  'Hold on.',
  'Lemme look.',
  'Hmm.',
];

/** Per-session rotation state so the same bridge never lands twice in a row. */
const cursors = new Map();

/**
 * @param {string} sessionId
 * @param {string} screenKey  kept in the signature for rotation keying
 * @returns {string} a bridge line, 5 words or fewer
 */
function pickBridge(sessionId, screenKey) {
  const k = `${sessionId}:${screenKey}`;
  const i = (cursors.get(k) ?? -1) + 1;
  cursors.set(k, i);
  return POOL[i % POOL.length];
}

function clearSession(sessionId) {
  for (const k of cursors.keys()) {
    if (k.startsWith(`${sessionId}:`)) cursors.delete(k);
  }
}

module.exports = { pickBridge, clearSession, POOL };
