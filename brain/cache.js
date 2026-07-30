'use strict';
/**
 * Precompute cache — the reason Tony feels instant.
 *
 * MEASURED CONTEXT (see LATENCY-FINDINGS.md):
 *   naive: question -> kimi-k3-fast -> speak        3571ms   BROKEN
 *   fast model on the critical path                  883ms   BROKEN (5390ms tail)
 *   cache hit -> anamClient.talk()                   270ms   OK
 *
 * Anam's own threshold: >800ms feels broken. No cold inference path clears it.
 * So the slow brain runs on OBSERVATION, not on the question — by the time the
 * learner asks, the answer is already sitting here.
 *
 * Tony seeming fast is not a speed optimization. It is a consequence of him
 * having been paying attention.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Intents we precompute for any AWS screen. Keep this list SHORT — every
 *  entry costs a slow-brain call on screen change, and k3-fast runs 5-21s. */
const PRECOMPUTE_INTENTS = [
  'what_is_this_screen',   // by far the most common hotkey question
  'primary_concern',       // the one thing worth flagging here, if anything
  'next_step',             // what the learner should do next
];

class PrecomputeCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = 200 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.store = new Map();      // key -> { text, action, at, stateHash }
    this.inflight = new Map();   // key -> Promise (dedupe concurrent precomputes)
    this.stats = { hits: 0, misses: 0, stale: 0, precomputed: 0, warmFailed: 0 };
    this.lastWarmError = null;
  }

  static key(screenKey, intent, stateHash) {
    return `${screenKey}::${intent}::${stateHash}`;
  }

  /**
   * Critical-path read. Must be synchronous and allocation-cheap: any await
   * here reintroduces latency we just spent a whole harness removing.
   */
  get(screenKey, intent, stateHash) {
    const k = PrecomputeCache.key(screenKey, intent, stateHash);
    const hit = this.store.get(k);
    if (!hit) {
      this.stats.misses += 1;
      return null;
    }
    if (Date.now() - hit.at > this.ttlMs) {
      this.store.delete(k);
      this.stats.stale += 1;
      this.stats.misses += 1;
      return null;
    }
    this.stats.hits += 1;
    return hit;
  }

  set(screenKey, intent, stateHash, payload) {
    if (this.store.size >= this.maxEntries) {
      // oldest-first eviction; screens the learner left are the least valuable
      const oldest = [...this.store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.store.delete(oldest[0]);
    }
    this.store.set(PrecomputeCache.key(screenKey, intent, stateHash), {
      ...payload, at: Date.now(), stateHash,
    });
    this.stats.precomputed += 1;
  }

  /**
   * Fire-and-forget warming, called on screen-changed / state-changed.
   * Deduped so a flurry of tree updates doesn't launch parallel slow calls.
   *
   * @param {(intent: string) => Promise<{text: string, action?: object}>} generate
   */
  warm(screenKey, stateHash, generate, intents = PRECOMPUTE_INTENTS) {
    for (const intent of intents) {
      const k = PrecomputeCache.key(screenKey, intent, stateHash);
      if (this.store.has(k) || this.inflight.has(k)) continue;

      const p = Promise.resolve()
        .then(() => generate(intent))
        .then((result) => {
          if (result && result.text) this.set(screenKey, intent, stateHash, result);
        })
        .catch((err) => {
          // The miss path still works, so this is never fatal — but silent
          // failures cost us a precompute slot and skew hit rate downward
          // with no explanation. Count them.
          this.stats.warmFailed = (this.stats.warmFailed ?? 0) + 1;
          this.lastWarmError = `${intent}: ${err.message}`;
        })
        .finally(() => this.inflight.delete(k));

      this.inflight.set(k, p);
    }
  }

  /** Hit rate is THE open question for the whole architecture. At 100% Tony
   *  feels human; at 40% most interactions take the bridge path. Log it. */
  hitRate() {
    const total = this.stats.hits + this.stats.misses;
    return total === 0 ? null : this.stats.hits / total;
  }

  report() {
    const r = this.hitRate();
    return {
      ...this.stats,
      hitRate: r === null ? 'no data' : `${(r * 100).toFixed(1)}%`,
      entries: this.store.size,
      inflight: this.inflight.size,
      lastWarmError: this.lastWarmError ?? 'none',
    };
  }
}

module.exports = { PrecomputeCache, PRECOMPUTE_INTENTS };
