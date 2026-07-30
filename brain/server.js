'use strict';
/**
 * Tony's brain. Runs in the Electron MAIN process (and ports to Fly unchanged —
 * it is a plain HTTP/IPC service with no Electron dependencies in the logic).
 *
 * SECURITY: ANAM_API_KEY and FIREWORKS_API_KEY live here and ONLY here. The
 * Anam quickstart puts the API key in client-side JS; in Electron the renderer
 * is trivially inspectable and an Anam key mints sessions on your account, so
 * the renderer receives short-lived SESSION TOKENS and never the key itself.
 */
const { PrecomputeCache } = require('./cache');
const { pickBridge } = require('./bridges');
const { FAST_SYS, SLOW_SYS, buildSuffix } = require('./prompts');

const FIREWORKS = 'https://api.fireworks.ai/inference/v1/chat/completions';
const ANAM_TOKEN_URL = 'https://api.anam.ai/v1/auth/session-token';

// Measured on this catalog. See LATENCY-FINDINGS.md.
//  - k3-fast is the only model that scored 6/6 on the persona suite AND 5/5 on
//    grounding, but runs 5-21s. It never touches the critical path.
//  - deepseek-v4-flash is the ONLY model accepting reasoning_effort:"none".
const SLOW_MODEL = 'accounts/fireworks/routers/kimi-k3-fast';
const FAST_MODEL = 'accounts/fireworks/models/deepseek-v4-flash';

class Brain {
  constructor({ fireworksKey, anamKey, personaConfig, log = console }) {
    this.fireworksKey = fireworksKey;
    this.anamKey = anamKey;
    this.personaConfig = personaConfig;
    this.log = log;
    this.cache = new PrecomputeCache();
    this.session = {
      id: `s_${Date.now()}`,
      mode: 'walk_through',
      accountKind: 'sandbox',
      triggersFired: [],       // anti-nag: a concern raised is a concern settled
      scarsUsed: [],           // anti-repeat: v1 told one anecdote 4/4 times
      acronymsExplained: [],
      interventionsRemaining: 3,
    };
  }

  // ---------------------------------------------------------------- Anam

  /**
   * Mint a short-lived session token. llmId CUSTOMER_CLIENT_V1 disables Anam's
   * built-in brain so every word Tony speaks comes from here.
   */
  async mintSessionToken() {
    const res = await fetch(ANAM_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.anamKey}` },
      body: JSON.stringify({
        personaConfig: { ...this.personaConfig, llmId: 'CUSTOMER_CLIENT_V1' },
      }),
    });
    if (!res.ok) throw new Error(`Anam session token failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.sessionToken;
  }

  // ---------------------------------------------------------------- models

  async callModel({ model, system, user, maxTokens, extra = {}, stream = false }) {
    const res = await fetch(FIREWORKS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.fireworksKey}` },
      body: JSON.stringify({
        model, stream, max_tokens: maxTokens, temperature: 0.3,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        ...extra,
      }),
    });
    if (!res.ok) throw new Error(`${model}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    // Reasoning models put thinking in reasoning_content. Only `content` is
    // speakable — a consumer reading the wrong field sees an empty response.
    return msg.content?.trim() || '';
  }

  /** Parse the LAST balanced JSON object: reasoning models emit prose first. */
  static parseJson(text) {
    const out = [];
    let depth = 0, start = -1;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '{') { if (depth === 0) start = i; depth += 1; }
      else if (text[i] === '}' && depth) { depth -= 1; if (depth === 0) out.push(text.slice(start, i + 1)); }
    }
    for (let i = out.length - 1; i >= 0; i -= 1) {
      try {
        const o = JSON.parse(out[i]);
        if (o && typeof o === 'object' && 'say' in o) return o;
      } catch { /* keep looking */ }
    }
    return null;
  }

  // ------------------------------------------------------------ slow path

  /** Deliberate reasoning. Runs on OBSERVATION, never on the question. */
  async think(frame, intent) {
    const user = buildSuffix({
      session: this.session,
      event: { kind: 'precompute', payload: intent },
      screen: frame,
    });
    const raw = await this.callModel({
      model: SLOW_MODEL, system: SLOW_SYS, user, maxTokens: 8000,
    });
    const obj = Brain.parseJson(raw);
    if (!obj || !obj.say) return null;
    return { text: obj.say, action: obj.action ?? { type: 'none' }, meta: obj };
  }

  /** Warm the cache. Called on screen-changed / state-changed, never awaited. */
  warm(frame) {
    const stateHash = frame.stateHash ?? 'live';
    this.cache.warm(frame.screen.key, stateHash, (intent) => this.think(frame, intent));
  }

  // ------------------------------------------------------------ fast path

  /** Only used when the cache misses AND the bridge has already been spoken. */
  async speakFast(frame, question) {
    const user = buildSuffix({
      session: this.session,
      event: { kind: 'hotkey_question', payload: question },
      screen: frame,
    });
    return this.callModel({
      model: FAST_MODEL, system: FAST_SYS, user, maxTokens: 200,
      extra: { reasoning_effort: 'none' },   // 400s on every other model here
    });
  }

  // ------------------------------------------------------------- dispatch

  /**
   * THE critical path. Returns instructions for the renderer, never audio.
   *
   *   hit  -> { via:'cache',  speak }            ~270ms  talk()
   *   miss -> { via:'bridge', speak, followUp }  ~270ms  talk(), then stream
   */
  async ask({ frame, question, intent = 'what_is_this_screen' }) {
    const stateHash = frame.stateHash ?? 'live';
    const hit = this.cache.get(frame.screen.key, intent, stateHash);

    if (hit) {
      return { via: 'cache', speak: hit.text, action: hit.action, latencyClass: 'floor' };
    }

    // Miss. Speak a deterministic bridge NOW; resolve substance behind it.
    const bridge = pickBridge(this.session.id, frame.screen.key);
    const followUp = this.speakFast(frame, question)
      .catch((err) => {
        this.log.warn?.('fast path failed:', err.message);
        return null;   // bridge already spoke; silence beats an apology
      });

    return { via: 'bridge', speak: bridge, followUp, latencyClass: 'floor' };
  }

  // --------------------------------------------------------- session state

  /** A concern raised is a concern settled. Nagging is how you get uninstalled. */
  markTriggerFired(trigger) {
    if (!this.session.triggersFired.includes(trigger)) this.session.triggersFired.push(trigger);
  }

  markScarUsed(scar) {
    if (!this.session.scarsUsed.includes(scar)) this.session.scarsUsed.push(scar);
  }

  /** Safety gate enforced SERVER-SIDE. The prompt rule is defense in depth. */
  permitsDriving() {
    return this.session.accountKind === 'sandbox';
  }

  sanitizeAction(action) {
    if (!action) return { type: 'none' };
    const mutating = ['click', 'type', 'scroll', 'hotkey'];
    if (mutating.includes(action.type) && !this.permitsDriving()) {
      return { type: 'point', element_id: action.element_id, needs_confirmation: true };
    }
    return action;
  }
}

module.exports = { Brain, SLOW_MODEL, FAST_MODEL };
