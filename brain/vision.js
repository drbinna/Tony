'use strict';
/**
 * Vision grounding — Tony's eyes for pointing.
 *
 * The AX tree gives exact bounds but only for elements that expose themselves
 * (unlabeled picker rows and canvas regions measured blind tonight). This
 * module grounds a natural-language target description on a LIVE SCREENSHOT
 * via Claude and returns screen coordinates. It is the PRIMARY targeting path
 * when configured; the AX lookup remains only for when no key is present.
 *
 * SCOPE: this drives the OBSERVER path only (screenshot -> coordinates ->
 * CGEvent cursor). In extension mode the browser highlights/clicks DOM elements
 * directly, so ground() is never called and no Screen Recording permission is
 * needed there — the Grounder is constructed but dormant.
 *
 * Coordinate math: screencapture writes physical (Retina) pixels; we resample
 * to the LOGICAL display resolution before sending, so the coordinates Claude
 * returns are usable CGEvent screen coordinates with no scale factor.
 *
 * Credentials, in priority order (constructor picks the first available):
 *   1. vision option    — the hosted key proxy (apiKey is the user's access
 *      code); how distributed builds ground with no real key on disk.
 *   2. OPENROUTER_API_KEY — OpenRouter's Anthropic-compatible endpoint.
 *   3. ANTHROPIC_API_KEY  — the direct API, with strict structured outputs.
 * With none of these set, the Grounder boots disabled rather than throwing.
 * When it runs it also needs macOS Screen Recording permission. Latency is a
 * Claude round trip (~1-4s) — off the critical path, covered by the bridge
 * like every other model call.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

const GROUND_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    x: { type: 'integer', description: 'center x of the element, in image pixels' },
    y: { type: 'integer', description: 'center y of the element, in image pixels' },
    width: { type: 'integer', description: 'approximate element width in pixels' },
    height: { type: 'integer', description: 'approximate element height in pixels' },
    label: { type: 'string', description: 'the visible text or a short name of what was located' },
  },
  required: ['found', 'x', 'y', 'width', 'height', 'label'],
  additionalProperties: false,
};

class Grounder {
  /**
   * @param {{width:number, height:number}} logicalSize primary display logical resolution
   */
  constructor({ width, height, log = console, vision = null } = {}) {
    this.width = width;
    this.height = height;
    this.log = log;
    this.shotPath = path.join(os.tmpdir(), 'tony-ground.png');
    // Three ways in, proxy first (distributed builds hold no real keys):
    //  - vision option        -> the hosted key proxy's Anthropic-compatible
    //    endpoint; apiKey is the user's access code.
    //  - OPENROUTER_API_KEY -> OpenRouter's Anthropic-Messages-compatible
    //    endpoint (base https://openrouter.ai/api, tilde model ids). Their
    //    router may not pass output_config through, so this path enforces
    //    the JSON contract by prompt and parses defensively.
    //  - ANTHROPIC_API_KEY  -> direct API with strict structured outputs.
    // The SDK constructor THROWS with no key — guard so a keyless launch
    // boots with vision disabled instead of dead.
    if (vision?.apiKey) {
      this.provider = vision.provider || 'proxy';
      this.model = vision.model || process.env.TONY_VISION_MODEL || '~anthropic/claude-opus-latest';
      this.client = new Anthropic({ apiKey: vision.apiKey, baseURL: vision.baseURL });
    } else if (process.env.OPENROUTER_API_KEY) {
      this.provider = 'openrouter';
      this.model = process.env.TONY_VISION_MODEL || '~anthropic/claude-opus-latest';
      this.client = new Anthropic({
        apiKey: process.env.OPENROUTER_API_KEY,
        baseURL: 'https://openrouter.ai/api',
      });
    } else if (process.env.ANTHROPIC_API_KEY) {
      this.provider = 'anthropic';
      this.model = process.env.TONY_VISION_MODEL || 'claude-opus-4-8';
      this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } else {
      this.provider = null;
      this.model = null;
      this.client = null;
    }
  }

  enabled() {
    return this.client !== null;
  }

  /** Screenshot at logical resolution, base64 PNG. */
  capture() {
    execFileSync('/usr/sbin/screencapture', ['-x', this.shotPath], { timeout: 8000 });
    if (this.width && this.height) {
      // -z resamples to exactly logical HxW: Claude's pixel coords become
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
      `This is a ${this.width}x${this.height} screenshot of a computer screen. `
      + `Locate this UI element: "${target}". `
      + `Return the CENTER pixel coordinates of the exact clickable element and its approximate size. `
      + `If it is not visible on screen, return found=false.`;

    const req = {
      model: this.model,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
          { type: 'text', text: instructions },
        ],
      }],
    };

    if (this.provider === 'anthropic') {
      // Direct API: strict structured outputs guarantee the shape.
      req.output_config = {
        effort: 'low',   // perception task; latency matters more than depth
        format: { type: 'json_schema', schema: GROUND_SCHEMA },
      };
    } else {
      // OpenRouter compat path: enforce by prompt, parse defensively below.
      req.messages[0].content[1].text += ' Respond with ONLY a JSON object: '
        + '{"found": boolean, "x": int, "y": int, "width": int, "height": int, "label": string}. '
        + 'No prose, no markdown fences.';
    }

    const res = await this.client.messages.create(req);
    const text = res.content.find((b) => b.type === 'text')?.text ?? '{}';
    const out = Grounder.parseJson(text);
    if (!out) throw new Error(`grounding returned unparseable output: ${text.slice(0, 120)}`);
    out.usage = { in: res.usage?.input_tokens, out: res.usage?.output_tokens };
    return out;
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
