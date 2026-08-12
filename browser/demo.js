'use strict';
/**
 * DemoRail — a scripted lesson that runs deterministically, bypassing the model.
 *
 * Each step is pre-authored narration + at most one action against a role/name
 * target, so the only per-step cost is the DOM action + a short settle — no
 * model latency, no model variance. Consent is preserved exactly like the
 * product: Tony highlights the target and asks, and only acts when the learner
 * says go. A step may carry `resource` (Terraform), committed into the same
 * hand-off map the model path uses, so the files box still works in a demo.
 *
 * Off-script utterances fall through to the model for that one turn (input()
 * returns 'passthrough'); "stop" ends the rail.
 */
const AFFIRM = /\b(yes|yeah|yep|yup|sure|ok|okay|go|do it|please|continue|next|proceed|launch it|click it|sounds good)\b/i;
const STOP = /\b(stop|cancel|exit|quit|end demo|never ?mind)\b/i;

class DemoRail {
  constructor({ script, pilot, speak, tf = null, writeArtifacts = null, transcript = null, log = console, settleMs } = {}) {
    this.script = script;
    this.pilot = pilot;
    this.speak = speak;
    this.tf = tf;                          // TerraformArtifact | null
    this.writeArtifacts = writeArtifacts;  // () => Promise | null (surfaces files box)
    this.transcript = transcript;
    this.log = log;
    this.settleMs = settleMs ?? (Number.parseInt(process.env.TONY_SETTLE_MS ?? '', 10) || 900);
    this.i = -1;
    this.active = false;
  }

  async start() {
    this.active = true;
    this.transcript?.log('demo-start', { name: this.script.name, steps: this.script.steps.length });
    if (this.script.intro) this.speak(this.script.intro);
    await this._present();
  }

  /** Highlight the pending step's target, then speak its narration (which asks
   *  for the go-ahead) — so "see the glowing box" is already true, like the
   *  product. A step with no action is pure narration. */
  async _present() {
    this.i += 1;
    if (this.i >= this.script.steps.length) return this._finish();
    const s = this.script.steps[this.i];
    const a = s.act;
    if (a && a.role && a.targetName && a.tool !== 'goto') {
      try {
        await this.pilot.highlight({ role: a.role, name: a.targetName, nth: a.nth ?? 0 });
      } catch (e) {
        this.log.warn?.(`[demo] step ${this.i} highlight failed: ${e.message}`);
      }
    }
    if (s.say) this.speak(s.say);
    this.transcript?.log('demo-present', { step: this.i, say: s.say, needsConsent: !!a });
  }

  /** Learner said go: run the presented step's action, commit any Terraform,
   *  settle, present the next step. */
  async _advance() {
    const s = this.script.steps[this.i];
    if (!s) return this._finish();
    const a = s.act;
    if (a) {
      try {
        if (a.tool === 'click') await this.pilot.click({ role: a.role, name: a.targetName, nth: a.nth ?? 0 });
        else if (a.tool === 'type') {
          await this.pilot.type({ role: a.role, name: a.targetName, nth: a.nth ?? 0 }, a.text ?? '');
          if (a.submit) await this.pilot.press('Enter');
        } else if (a.tool === 'goto') await this.pilot.goto(a.url);
        else if (a.tool === 'press') await this.pilot.press(a.key ?? 'Enter');
        this.transcript?.log('demo-act', { step: this.i, tool: a.tool, target: a.targetName ?? a.url, ok: true });
      } catch (e) {
        this.transcript?.log('demo-act', { step: this.i, tool: a.tool, ok: false, error: e.message });
        this.speak('Hmm, that control moved on me — let me re-point it, then say go again.');
        this.i -= 1;                 // re-present (re-highlight) the same step
        return this._present();
      }
      await new Promise((r) => setTimeout(r, s.settleMs ?? this.settleMs));
    }
    // Pre-authored Terraform for this step → same hand-off map as the model
    // path (data/variables/outputs alongside the resource, for portable HCL).
    if (this.tf) {
      try {
        for (const v of (s.variables || [])) await this.tf.applyVariable(v);
        for (const d of (s.data || [])) await this.tf.applyData(d);
        for (const o of (s.outputs || [])) await this.tf.applyOutput(o);
        if (s.resource) {
          await this.tf.applyResource(s.resource);
          this.transcript?.log('pilot-iac', {
            address: `${s.resource.type}.${s.resource.name}`, op: s.resource.op || 'create',
            resources: this.tf.resourceCount, demo: true,
          });
        }
      } catch (e) {
        this.log.warn?.(`[demo] iac commit failed: ${e.message}`);
      }
    }
    await this._present();
  }

  async _finish() {
    this.active = false;
    this.transcript?.log('demo-finish', { name: this.script.name, resources: this.tf?.resourceCount ?? 0 });
    if (this.script.outro) this.speak(this.script.outro);
  }

  /** Route a learner utterance while the rail is active.
   *    'handled'     — consumed (advanced or stopped)
   *    'passthrough' — off-script; the caller should answer via the model
   *    'inactive'    — the rail isn't running */
  async input(text) {
    if (!this.active) return 'inactive';
    const t = (text || '').trim();
    if (STOP.test(t)) { this.speak('Okay, stopping the demo here.'); this.active = false; return 'handled'; }
    if (!t || AFFIRM.test(t)) { await this._advance(); return 'handled'; }
    return 'passthrough';   // a real question mid-demo — let the model take it
  }
}

module.exports = { DemoRail };
