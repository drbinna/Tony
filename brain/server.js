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
  constructor({ fireworksKey, anamKey, fireworksUrl = null, anamTokenUrl = null, personaConfig, log = console, transcript = null }) {
    this.fireworksKey = fireworksKey;
    this.anamKey = anamKey;
    // Proxy mode points these at the hosted key proxy and the "keys" above
    // are access codes; local mode leaves them null and hits the real APIs.
    this.fireworksUrl = fireworksUrl || FIREWORKS;
    this.anamTokenUrl = anamTokenUrl || ANAM_TOKEN_URL;
    this.personaConfig = personaConfig;
    this.log = log;
    this.transcript = transcript;
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
    const res = await fetch(this.anamTokenUrl, {
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
    const res = await fetch(this.fireworksUrl, {
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
    const t0 = Date.now();
    let raw;
    try {
      raw = await this.callModel({
        model: SLOW_MODEL, system: SLOW_SYS, user, maxTokens: 8000,
      });
    } catch (err) {
      this.transcript?.log('precompute', {
        screen: frame.screen.key, intent, tookMs: Date.now() - t0, ok: false, error: err.message,
      });
      throw err;   // cache.warm counts it as warmFailed
    }
    const obj = Brain.parseJson(raw);
    // Three outcomes, not two: parsed-with-content, parsed-but-declined
    // ("say": null — the model chose silence, e.g. no concern worth raising),
    // and genuinely unparseable. Only the last is a failure.
    const declined = !!(obj && 'say' in obj && !obj.say);
    this.transcript?.log('precompute', {
      screen: frame.screen.key, intent, tookMs: Date.now() - t0,
      ok: !!obj, ...(declined ? { declined: true } : {}),
      // On a parse failure the raw output is the whole diagnosis; keep a slice.
      ...(obj ? {} : { raw: raw.slice(0, 400) }),
    });
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

    // A real spoken question deserves the slow brain's reasoning, not just the
    // fast describe-the-screen model. Bridge immediately, answer for real behind
    // it. The bridge buys the 5-20s the slow brain needs.
    const isSpokenQuestion = intent === 'learner_question';
    const bridge = pickBridge(this.session.id, frame.screen.key);
    // followUp resolves to { text, action } | null on BOTH paths. The slow
    // brain's action must survive to dispatch — dropping it here was the bug
    // where Tony said "cursor's pointing at it" and no ring ever appeared.
    const answerer = isSpokenQuestion
      ? this.answerQuestion(frame, question)
      : this.speakFast(frame, question).then((text) => (text ? { text } : null));

    const followUp = answerer.catch((err) => {
      this.log.warn?.('answer path failed:', err.message);
      return null;   // bridge already spoke; silence beats an apology
    });

    return { via: 'bridge', speak: bridge, followUp, latencyClass: 'floor' };
  }

  /** Answer a free-form spoken question as Tony, with console context. Uses the
   *  slow brain (better reasoning); returns { text, action } so a spoken answer
   *  can ring the pointer too. */
  async answerQuestion(frame, question) {
    const user = buildSuffix({
      session: this.session,
      event: { kind: 'learner_message', payload: question },
      screen: frame,
    });
    const raw = await this.callModel({
      model: SLOW_MODEL, system: SLOW_SYS, user, maxTokens: 8000,
    });
    const obj = Brain.parseJson(raw);
    if (!obj?.say) {
      // A silent Tony after a bridge is undebuggable without the raw output.
      this.transcript?.log('parse-failed', { where: 'answerQuestion', raw: raw.slice(0, 400) });
      return null;
    }
    return { text: obj.say, action: obj.action ?? { type: 'none' } };
  }

  // ------------------------------------------------------------ pilot mode

  /** One turn of the Playwright lesson loop: system + running history in,
   *  raw model text out (the Lesson layer parses the JSON action). `fast`
   *  routes report-what-you-see turns to the fast model: a "here's the page
   *  now" sentence doesn't need 16s of slow-brain reasoning, and the learner
   *  is sitting in silence while it generates. */
  async pilotTurn(system, messages, { fast = false } = {}) {
    const res = await fetch(this.fireworksUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.fireworksKey}` },
      body: JSON.stringify({
        model: fast ? FAST_MODEL : SLOW_MODEL, max_tokens: fast ? 700 : 2000, temperature: 0.3,
        ...(fast ? { reasoning_effort: 'none' } : {}),
        messages: [{ role: 'system', content: system }, ...messages],
      }),
    });
    if (!res.ok) throw new Error(`pilot: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
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
    // On a non-sandbox account, any mutating action is DEMOTED to a point:
    // Tony shows you where instead of doing it. This is the safety line, and it
    // is enforced here in code, not left to the prompt.
    if (mutating.includes(action.type) && !this.permitsDriving()) {
      return { type: 'point', element_id: action.element_id, needs_confirmation: true, demoted_from: action.type };
    }
    return action;
  }

  /**
   * Attach screen bounds to a point action by looking the element up in the
   * frame's AX tree. ax-dump already emits per-node bounds in screen coords, so
   * this is a lookup, not a computation — and it means the ring lands exactly
   * on the element the brain chose, with no pixel guessing.
   */
  resolvePoint(action, frame) {
    if (!action || action.type !== 'point' || !action.element_id) return null;
    const el = (frame.tree || []).find((n) => n.id === action.element_id);
    if (!el || !Array.isArray(el.bounds) || el.bounds.length !== 4) return null;
    return {
      bounds: el.bounds,
      label: action.label || (() => {
        const text = (el.label || el.value || '').trim();
        return text ? `click ${text}`.slice(0, 40) : 'here';
      })(),
      element_id: action.element_id,
    };
  }
}

module.exports = { Brain, SLOW_MODEL, FAST_MODEL };
