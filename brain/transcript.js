'use strict';
/**
 * Session transcript — append-only JSONL, one file per app run.
 *
 * This is a debugging instrument, not a product feature: every conversational
 * event (utterance, ask, cache hit/bridge, follow-up, pointer, abort) lands
 * here with timings, so a broken session can be replayed from the file instead
 * of from memory. It also snapshots cache stats per exchange, which is the
 * hit-rate measurement the README calls THE open question.
 *
 * Writes are synchronous on purpose: events arrive seconds apart, and an
 * append that survives the very crash you're debugging is worth more than
 * saved microseconds. Read a session with `npm run transcript`.
 */
const fs = require('fs');
const path = require('path');

class Transcript {
  constructor({ dir } = {}) {
    this.dir = dir || process.env.TONY_TRANSCRIPT_DIR
      || path.join(__dirname, '..', 'transcripts');
    this.t0 = Date.now();
    const stamp = new Date(this.t0).toISOString().replace(/[:.]/g, '-');
    this.file = path.join(this.dir, `${stamp}.jsonl`);
    this.broken = false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      this.broken = true;
      console.warn(`[transcript] disabled — cannot create ${this.dir}: ${err.message}`);
    }
  }

  /** Append one event. Never throws — a logging failure must not take down
   *  the conversation it is logging. */
  log(type, data = {}) {
    if (this.broken) return null;
    // Reserved fields last so event data can never clobber the timeline.
    const entry = { ...data, t: new Date().toISOString(), ms: Date.now() - this.t0, type };
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      this.broken = true;
      console.warn(`[transcript] write failed, disabled: ${err.message}`);
    }
    return entry;
  }
}

module.exports = { Transcript };
