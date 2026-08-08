'use strict';
/**
 * Vision grounding — Tony's eyes for pointing.
 *
 * The AX tree gives exact bounds but only for elements that expose themselves
 * (unlabeled picker rows and canvas regions measured blind tonight). This
 * module grounds a natural-language target description on a LIVE SCREENSHOT
 * and returns screen coordinates. It is the PRIMARY targeting path when a
 * vision model is configured; the AX lookup remains only for when it is not.
 *
 * Coordinate math: screencapture writes physical (Retina) pixels; we resample
 * to the LOGICAL display resolution before sending, so the pixel coordinates
 * the model returns are usable CGEvent screen coordinates with no scale factor.
 *
 * Model: a Fireworks-hosted VLM on the same OpenAI-compatible chat/completions
 * endpoint (and same FIREWORKS_API_KEY / proxy) as the brain — no separate
 * credential and no Anthropic dependency. Default is qwen3p7-plus, the fastest
 * of the account's vision models that still grounds accurately (~2s/call); the
 * heavier Kimi vision models reason for 15-30s per call, too slow to point
 * with. We run it at reasoning_effort 'low' — enough to actually locate the
 * element, but the thinking lands in reasoning_content so `content` is clean
 * JSON. Override with TONY_VISION_MODEL. We ask for a bounding box — the VLM's
 * native grounding format — and derive the click center from it. With no key
 * the Grounder boots disabled rather than throwing. Latency is one round trip,
 * off the critical path, covered by the bridge like every other model call.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FIREWORKS = 'https://api.fireworks.ai/inference/v1/chat/completions';
const DEFAULT_MODEL = 'accounts/fireworks/models/qwen3p7-plus';

class Grounder {
  /**
   * @param {{width:number, height:number, fireworksKey?:string, fireworksUrl?:string}} opts
   *   primary display logical resolution plus the same Fireworks credential the
   *   brain uses (fireworksUrl is set only in proxy mode; else the direct API).
   */
  constructor({ width, height, log = console, fireworksKey = null, fireworksUrl = null } = {}) {
    this.width = width;
    this.height = height;
    this.log = log;
    this.shotPath = path.join(os.tmpdir(), 'tony-ground.png');
    // Vision rides the brain's Fireworks credential. In proxy mode fireworksUrl
    // is the /api/chat passthrough (the VLM is just another model on the same
    // chat/completions endpoint, so it needs no separate proxy route). With no
    // key the Grounder boots disabled instead of dead.
    this.key = fireworksKey || process.env.FIREWORKS_API_KEY || null;
    this.url = fireworksUrl || FIREWORKS;
    if (this.key) {
      this.provider = 'fireworks';
      this.model = process.env.TONY_VISION_MODEL || DEFAULT_MODEL;
    } else {
      this.provider = null;
      this.model = null;
    }
  }

  enabled() {
    return this.key !== null;
  }

  /** Screenshot at logical resolution, base64 PNG. */
  capture() {
    execFileSync('/usr/sbin/screencapture', ['-x', this.shotPath], { timeout: 8000 });
    if (this.width && this.height) {
      // -z resamples to exactly logical HxW: the model's pixel coords become
      // CGEvent screen coords 1:1, and the image is half the tokens.
      execFileSync('/usr/bin/sips', ['-z', String(this.height), String(this.width), this.shotPath],
        { timeout: 8000, stdio: 'ignore' });
    }
    return fs.readFileSync(this.shotPath).toString('base64');
  }

  /**
   * Locate an element described in natural language on the current screen.
   * @param {string} target e.g. 'the orange Launch instance button'
   * @returns {Promise<{found:boolean, x:number, y:number, width:number, height:number, label:string}>}
   */
  async ground(target) {
    const data = this.capture();
    const instructions =
      `This is a ${this.width}x${this.height} pixel screenshot of a computer screen. `
      + `Locate this UI element: "${target}". `
      + `Return its bounding box in ACTUAL image pixels as [x1, y1, x2, y2] (top-left, bottom-right). `
      + `If it is not visible on screen, set found to false. `
      + 'Respond with ONLY a JSON object, no prose and no markdown fences: '
      + '{"found": boolean, "box": [x1, y1, x2, y2], "label": string} '
      + 'where label is the visible text or a short name of what you located.';

    const body = {
      model: this.model,
      max_tokens: 3072,          // reasoning + JSON; smaller budgets truncate
      temperature: 0,
      reasoning_effort: 'low',   // 'none' fails to locate; 'low' grounds in ~2s.
      // No response_format: forcing json_object makes this model spill its
      // reasoning into `content` (then truncate) instead of reasoning_content;
      // left off, content is clean JSON and we parse the last object defensively.
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
          { type: 'text', text: instructions },
        ],
      }],
    };

    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${this.model}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const msg = json.choices?.[0]?.message ?? {};
    // The JSON usually lands in `content`; this model occasionally spills it
    // into `reasoning_content` instead, so check both before giving up.
    const raw = Grounder.parseJson(msg.content || '') || Grounder.parseJson(msg.reasoning_content || '');
    const usage = { in: json.usage?.prompt_tokens, out: json.usage?.completion_tokens };
    if (!raw) {
      // Unparseable (or truncated mid-reason) -> degrade to a clean miss so Tony
      // re-looks, rather than throwing an error state into the turn.
      this.log.warn?.(`[vision] unparseable grounding for "${target}": ${(msg.content || '').slice(0, 100)}`);
      return { found: false, x: 0, y: 0, width: 0, height: 0, label: '', usage };
    }
    const out = Grounder.fromBox(raw);
    out.usage = usage;
    return out;
  }

  /** Convert the model's {found, box:[x1,y1,x2,y2], label} into center+size. */
  static fromBox(raw) {
    if (!raw.found || !Array.isArray(raw.box) || raw.box.length !== 4) {
      return { found: false, x: 0, y: 0, width: 0, height: 0, label: raw.label || '' };
    }
    const [x1, y1, x2, y2] = raw.box.map(Number);
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    return {
      found: true,
      x: Math.round(left + width / 2),
      y: Math.round(top + height / 2),
      width: Math.round(width),
      height: Math.round(height),
      label: raw.label || '',
    };
  }

  /** Extract the last balanced JSON object — tolerates fences and prose. */
  static parseJson(text) {
    const out = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '{') { if (depth === 0) start = i; depth += 1; }
      else if (text[i] === '}' && depth) { depth -= 1; if (depth === 0) out.push(text.slice(start, i + 1)); }
    }
    for (let i = out.length - 1; i >= 0; i -= 1) {
      try {
        const o = JSON.parse(out[i]);
        if (o && typeof o === 'object' && 'found' in o) return o;
      } catch { /* keep looking */ }
    }
    return null;
  }
}

module.exports = { Grounder };
