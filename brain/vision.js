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
 * Coordinate math: screencapture writes physical (Retina) pixels; we resample
 * to the LOGICAL display resolution before sending, so the coordinates Claude
 * returns are usable CGEvent screen coordinates with no scale factor.
 *
 * Requires ANTHROPIC_API_KEY (or an Anthropic auth profile) and macOS Screen
 * Recording permission for the app. Latency is a Claude round trip (~1-4s) —
 * off the critical path, covered by the bridge like every other model call.
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
  constructor({ width, height, log = console } = {}) {
    this.width = width;
    this.height = height;
    this.log = log;
    this.shotPath = path.join(os.tmpdir(), 'tony-ground.png');
    // The SDK constructor THROWS with no key — guard so a keyless launch
    // boots with vision disabled instead of dead.
    this.client = process.env.ANTHROPIC_API_KEY
      ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      : null;
  }

  enabled() {
    return !!process.env.ANTHROPIC_API_KEY;
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
    const res = await this.client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 500,
      output_config: {
        effort: 'low',   // perception task; latency matters more than depth
        format: { type: 'json_schema', schema: GROUND_SCHEMA },
      },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
          {
            type: 'text',
            text: `This is a ${this.width}x${this.height} screenshot of a computer screen. `
              + `Locate this UI element: "${target}". `
              + `Return the CENTER pixel coordinates of the exact clickable element and its approximate size. `
              + `If it is not visible on screen, return found=false.`,
          },
        ],
      }],
    });
    const text = res.content.find((b) => b.type === 'text')?.text ?? '{}';
    const out = JSON.parse(text);
    out.usage = { in: res.usage.input_tokens, out: res.usage.output_tokens };
    return out;
  }
}

module.exports = { Grounder };
