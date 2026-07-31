'use strict';
/**
 * Lesson — the pilot-mode conversation loop.
 *
 * One learner utterance -> one model turn -> at most ONE browser action ->
 * one automatic confirm turn (speech only) with the fresh snapshot. This is
 * the narrate/highlight/yield/act/confirm loop from the pilot prompt, kept
 * honest in code: the confirm turn may highlight or look, never act, so the
 * model cannot chain state changes inside a single learner turn.
 */
const { buildPilotSystem } = require('../brain/pilot-prompt');

const MAX_HISTORY = 16;              // messages (8 exchanges) before trimming
const ACT_TOOLS = ['click', 'type', 'press', 'goto'];
const LOOK_TOOLS = ['highlight', 'snapshot', 'screenshot'];

class Lesson {
  constructor({ brain, pilot, transcript, speak, config, log = console }) {
    this.brain = brain;
    this.pilot = pilot;
    this.transcript = transcript;
    this.speak = speak;             // (text) => void — hands speech to Anam
    this.log = log;
    this.system = buildPilotSystem(config);
    this.history = [];
    this.resources = [];            // "type: identifier" lines, teardown list
    this.busy = false;
  }

  /** Compact per-turn user payload: learner words + fresh page state. */
  async userPayload(learnerText, event) {
    let snap;
    try {
      snap = await this.pilot.snapshot();
    } catch (e) {
      snap = { url: this.pilot.url(), title: '', tree: `(snapshot failed: ${e.message})`, truncated: false };
    }
    return JSON.stringify({
      event,
      learner: learnerText ?? null,
      resources_created: this.resources,
      page: snap,
    });
  }

  push(role, content) {
    this.history.push({ role, content });
    if (this.history.length > MAX_HISTORY) this.history.splice(0, 2);
  }

  async model() {
    const raw = await this.brain.pilotTurn(this.system, this.history);
    const obj = this.brain.constructor.parseJson(raw);
    if (!obj) {
      this.transcript?.log('parse-failed', { where: 'pilotTurn', raw: raw.slice(0, 400) });
      return { say: null, tool: null, note: null };
    }
    return obj;
  }

  async execute(tool) {
    const t0 = Date.now();
    try {
      switch (tool.name) {
        case 'highlight':
          await this.pilot.highlight({ role: tool.role, name: tool.targetName, nth: tool.nth ?? 0 });
          break;
        case 'click':
          await this.pilot.click({ role: tool.role, name: tool.targetName, nth: tool.nth ?? 0 });
          break;
        case 'type':
          await this.pilot.type({ role: tool.role, name: tool.targetName, nth: tool.nth ?? 0 }, tool.text ?? '');
          break;
        case 'press':
          await this.pilot.press(tool.key || 'Enter');
          break;
        case 'goto': {
          const url = String(tool.url || '');
          // The physical scope wall: this browser goes to the AWS console and
          // sign-in, nowhere else — whatever the model asks.
          if (!/^https:\/\/([a-z0-9-]+\.)*(console\.aws\.amazon\.com|signin\.aws\.amazon\.com|aws\.amazon\.com)\//.test(url)) {
            throw new Error(`goto refused: ${url.slice(0, 80)} is outside the AWS console`);
          }
          await this.pilot.goto(url);
          break;
        }
        case 'snapshot':
        case 'screenshot':
          break;   // both are satisfied by the payload of the next turn
        default:
          throw new Error(`unknown tool ${tool.name}`);
      }
      this.transcript?.log('pilot-act', { tool: tool.name, role: tool.role, target: tool.targetName, ok: true, tookMs: Date.now() - t0 });
      return { ok: true };
    } catch (e) {
      this.transcript?.log('pilot-act', { tool: tool.name, role: tool.role, target: tool.targetName, ok: false, error: e.message.slice(0, 200), tookMs: Date.now() - t0 });
      return { ok: false, error: e.message.slice(0, 200) };
    }
  }

  /** One learner turn, end to end. */
  async turn(learnerText) {
    if (this.busy) { this.transcript?.log('pilot-turn', { dropped: learnerText, reason: 'busy' }); return; }
    this.busy = true;
    const t0 = Date.now();
    try {
      this.push('user', await this.userPayload(learnerText, 'learner_message'));
      const out = await this.model();
      this.push('assistant', JSON.stringify(out));
      if (out.note) this.resources.push(out.note);
      if (out.say) this.speak(out.say);
      this.transcript?.log('pilot-turn', { learner: learnerText, say: out.say, tool: out.tool?.name ?? null, tookMs: Date.now() - t0 });

      if (!out.tool || out.tool.name === 'snapshot') return;

      const res = await this.execute(out.tool);

      // Confirm turn: fresh snapshot, speech + look-only tools. This is where
      // "say plainly what changed; if nothing changed, say so" happens.
      if (ACT_TOOLS.includes(out.tool.name) || !res.ok) {
        this.push('user', await this.userPayload(null,
          res.ok ? `action_executed: ${out.tool.name}` : `action_failed: ${out.tool.name} — ${res.error}`));
        const confirm = await this.model();
        this.push('assistant', JSON.stringify(confirm));
        if (confirm.note) this.resources.push(confirm.note);
        if (confirm.say) this.speak(confirm.say);
        if (confirm.tool && LOOK_TOOLS.includes(confirm.tool.name)) await this.execute(confirm.tool);
        else if (confirm.tool) this.transcript?.log('pilot-act', { tool: confirm.tool.name, ok: false, error: 'deferred: acting tools are not allowed on the confirm turn' });
        this.transcript?.log('pilot-turn', { confirm: true, say: confirm.say, tool: confirm.tool?.name ?? null, tookMs: Date.now() - t0 });
      }
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { Lesson };
