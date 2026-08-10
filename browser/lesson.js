'use strict';
/**
 * Lesson — the pilot-mode conversation loop.
 *
 * One learner utterance -> one model turn -> at most ONE browser action ->
 * one automatic confirm turn (speech only) with the fresh snapshot. This is
 * the narrate/highlight/yield/act/confirm loop from the pilot prompt, kept
 * honest in code: the confirm turn may highlight or look, never act, so the
 * model cannot chain state changes inside a single learner turn.
 *
 * Every session also writes a handoff artifact folder as it goes: main.tf
 * accumulates the Terraform twin of each resource-shaping step (the model's
 * "iac" field), and README.md logs every step in plain language. Written
 * incrementally, so even an abandoned session leaves a reproducible record
 * the learner can send to their developer team.
 */
const fs = require('fs');
const path = require('path');
const { buildPilotSystem } = require('../brain/pilot-prompt');
const { TerraformArtifact } = require('./terraform');

const MAX_HISTORY = 16;              // messages (8 exchanges) before trimming
const ACT_TOOLS = ['click', 'type', 'press', 'goto'];
const LOOK_TOOLS = ['highlight', 'snapshot', 'screenshot'];

/** The bundled HCL syntax gate. Loaded defensively: if the parser can't be
 *  required in this build, gating degrades to a warn-only no-op inside
 *  TerraformArtifact rather than disabling hand-off files entirely. */
function loadHclParse(log) {
  try { return require('@cdktf/hcl2json').parse; }
  catch (e) { log?.warn?.(`[lesson] HCL parser unavailable, syntax gate off: ${e.message}`); return null; }
}

/** Tolerate the model sending a single object where an array is expected. */
function asArray(x) { return Array.isArray(x) ? x : (x ? [x] : []); }

class Lesson {
  constructor({ brain, pilot, transcript, speak, config, artifactsDir, onArtifact = null, log = console }) {
    this.brain = brain;
    this.pilot = pilot;
    this.transcript = transcript;
    this.speak = speak;             // (text) => void — hands speech to Anam
    this.onArtifact = onArtifact;   // (info) => void — tells the UI files are ready
    this.log = log;
    this.system = buildPilotSystem(config);
    this.history = [];
    this.resources = [];            // "type: identifier" lines, teardown list
    this.busy = false;

    // Handoff artifacts: one folder per session.
    this.config = config;
    this.dir = artifactsDir || path.join(__dirname, '..', 'lesson-artifacts',
      new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'));
    this.steps = [];
    // The Terraform hand-off is rendered from a resource map, never appended:
    // the model reports one confirmed resource at a time and this owns the file.
    this.tf = new TerraformArtifact({
      region: config.region,
      accountAlias: config.accountAlias,
      sessionId: path.basename(this.dir || 'session'),
      parse: loadHclParse(this.log),
      log: this.log,
    });
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch (e) { this.log.warn?.(`[lesson] artifacts disabled: ${e.message}`); this.dir = null; }
  }

  /** Render main.tf + README from the resource map and write them, gated. */
  async writeArtifacts() {
    if (!this.dir) return;
    try {
      const built = await this.tf.build({ lessonGoal: this.config.lessonGoal, steps: this.steps });
      if (!built.ok) {
        // B3 belt: a whole-file parse failure means an app-render bug slipped
        // past the commit-time gate — keep the last-good files, don't hand off
        // malformed HCL. The error names the seam to fix.
        this.log.warn?.(`[lesson] main.tf failed the HCL gate; keeping previous file: ${built.error}`);
        this.transcript?.log('tf-gate', { ok: false, error: built.error });
      } else {
        if (this.tf.hasResources) fs.writeFileSync(path.join(this.dir, 'main.tf'), built.mainTf);
        fs.writeFileSync(path.join(this.dir, 'README.md'), built.readme);
      }
    } catch (e) {
      this.log.warn?.(`[lesson] artifact write failed: ${e.message}`);
    } finally {
      // The overlay's files box keys off tf: true — fire it even if the build
      // gate hiccuped, so a present resource map always surfaces the download
      // (the last-good main.tf stays on disk).
      this.onArtifact?.({ dir: this.dir, tf: this.tf.hasResources, resources: this.tf.resourceCount });
    }
  }

  /** Fold a confirm turn's Terraform report into the resource map. Every apply
   *  is gated (H1 body parse, H2 import-id format, H4 collisions) inside the
   *  artifact; here we just surface warnings/rejections to the transcript. */
  async commitTf(out) {
    let touched = false;
    const note = (r, label, id) => {
      if (r?.warning) this.log.warn?.(`[lesson] tf ${label} ${id}: ${r.warning}`);
      if (r && !r.ok) { this.log.warn?.(`[lesson] tf ${label} ${id} rejected: ${r.error}`); this.transcript?.log('tf-reject', { label, id, error: r.error }); }
      return r?.ok;
    };
    for (const v of asArray(out.variables)) { if (note(await this.tf.applyVariable(v), 'variable', v?.name)) touched = true; }
    for (const d of asArray(out.data)) { if (note(await this.tf.applyData(d), 'data', d?.name)) touched = true; }
    if (out.resource) {
      const addr = `${out.resource.type}.${out.resource.name}`;
      const r = await this.tf.applyResource(out.resource);
      if (note(r, 'resource', addr)) {
        touched = true;
        this.transcript?.log('pilot-iac', { address: addr, op: out.resource.op || 'create', resources: this.tf.resourceCount, ...(r.warning ? { warning: r.warning } : {}) });
      }
    }
    for (const o of asArray(out.outputs)) { if (note(await this.tf.applyOutput(o), 'output', o?.name)) touched = true; }
    if (out.failure) { this.tf.addFailure(out.failure); touched = true; this.transcript?.log('tf-failure', out.failure); }
    return touched;
  }

  /** Log the step and, on confirm turns only (A1: reality, not intent), commit
   *  any Terraform the model reported. Re-renders the artifact when anything
   *  substantive changed. */
  async record(out, confirmed = false) {
    if (out.note) this.resources.push(out.note);
    // The map and step log accumulate on every confirmed step. The files box
    // surfaces as soon as there is ANY confirmed Terraform (see below) — it must
    // never hinge on the model emitting a clean handoff turn.
    const touchedTf = confirmed ? await this.commitTf(out) : false;
    // The README's numbered log keeps substantive steps — state changes and
    // resource configs — not navigation, pointing, or recovery chatter.
    const substantive = touchedTf || out.note || (out.tool && ACT_TOOLS.includes(out.tool.name));
    if (out.say && substantive) {
      const act = out.tool ? ` _(action: ${out.tool.name}${out.tool.targetName ? ` → ${out.tool.targetName}` : ''})_` : '';
      this.steps.push(`${out.say}${act}`);
    }
    // Surface (and refresh) the download the instant there is confirmed
    // Terraform — the moment a resource is committed, and again whenever the
    // learner explicitly asks. This is deliberately DECOUPLED from out.handoff:
    // the model can spill its reasoning as prose (JSON parse fails, handoff
    // field is dropped) yet still tell the learner "your files are ready", and
    // writeArtifacts() can throw after tf-handoff is already logged. Keying the
    // files box off the real resource map instead means IaC always appears once
    // it exists. Writing per confirmed step keeps the folder current; the chip
    // is passive (it just appears in the box), so this doesn't nag the learner.
    if (out.handoff) this.transcript?.log('tf-handoff', { resources: this.tf.resourceCount });
    if ((touchedTf || out.handoff) && this.tf.hasResources) {
      await this.writeArtifacts();
    }
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

  async model({ fast = false } = {}) {
    const raw = await this.brain.pilotTurn(this.system, this.history, { fast });
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
        case 'highlight': {
          const proof = await this.pilot.highlight({ role: tool.role, name: tool.targetName, nth: tool.nth ?? 0 });
          // No rect = a pre-0.5 content script answered (its highlight dies
          // after 6s). The tab must be refreshed after an extension reload —
          // this happened silently once; never again.
          if (!proof?.rect) this.log.warn?.('[lesson] highlight returned NO PROOF — the console tab is running an old content script. Reload the extension AND refresh the tab.');
          this.transcript?.log('pilot-act', { tool: 'highlight', role: tool.role, target: tool.targetName, ok: true, rect: proof?.rect, ...(proof?.rect ? {} : { staleContentScript: true }), tookMs: Date.now() - t0 });
          return { ok: true };
        }
        case 'click':
          await this.pilot.click({ role: tool.role, name: tool.targetName, nth: tool.nth ?? 0 });
          break;
        case 'type':
          await this.pilot.type({ role: tool.role, name: tool.targetName, nth: tool.nth ?? 0 }, tool.text ?? '');
          // A search box is one gesture: type, then submit. Folding Enter into
          // the same act keeps it within one-action-per-turn — otherwise the
          // follow-up press lands on the look-only confirm turn and is deferred,
          // and Tony loops asking the learner to submit for him (observed live).
          if (tool.submit) await this.pilot.press('Enter');
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

      // Highlight runs BEFORE the narration: "I've outlined it" must already
      // be true when the learner hears it (it's ~15ms through the bridge, so
      // speech isn't delayed). If it fails, the claim is never spoken — the
      // confirm turn below reports the failure and speaks the correction.
      let res = null;
      let say = out.say;
      if (out.tool?.name === 'highlight') {
        res = await this.execute(out.tool);
        if (!res.ok) say = null;
      }
      // Main turn is intent, not confirmed reality — never commits Terraform.
      await this.record({ ...out, say }, false);
      if (say) this.speak(say);
      this.transcript?.log('pilot-turn', { learner: learnerText, say, tool: out.tool?.name ?? null, ...(say !== out.say ? { unspoken: out.say } : {}), tookMs: Date.now() - t0 });

      if (!out.tool) return;

      if (!res) res = await this.execute(out.tool);

      // The console SPA needs a beat to render after an action — confirming
      // instantly reads the OLD page and Tony reports "nothing changed" on
      // clicks that worked (observed live twice). Typing counts too: the
      // unified-search autocomplete debounces, so a confirm snapshot taken the
      // instant a query is typed shows an empty dropdown and Tony wrongly reads
      // the type as a no-op, then reaches for Enter on the look-only confirm
      // turn (observed live). Let it settle first.
      if (res.ok && ['click', 'goto', 'press', 'type'].includes(out.tool.name)) {
        await new Promise((r) => setTimeout(r, 1800));
      }

      // Confirm turn: fresh snapshot, speech + look-only tools. This is where
      // "say plainly what changed; if nothing changed, say so" happens.
      // snapshot/screenshot requests get one too — "let me take a fresh look"
      // must be followed by the report, not by silence (observed live).
      // Highlight skips it: the narration already accompanied the outline.
      if (ACT_TOOLS.includes(out.tool.name) || ['snapshot', 'screenshot'].includes(out.tool.name) || !res.ok) {
        // The report loop. The first pass confirms the learner-visible action
        // on the slow brain (it may carry teaching and iac). But if a report
        // turn ITSELF asks for a fresh look ("page is still loading, let me
        // check"), loop again: settle, snapshot, and report — on the fast
        // model, because "let me take a look" followed by 17s of silence is
        // the exact thing it promised not to do (observed live). Capped so a
        // look-happy model can't spin forever.
        let event = res.ok ? `action_executed: ${out.tool.name}` : `action_failed: ${out.tool.name} — ${res.error}`;
        let fast = res.ok && ['snapshot', 'screenshot'].includes(out.tool.name);
        let hlRetried = false;
        for (let pass = 0; pass < 3; pass++) {
          this.push('user', await this.userPayload(null, event));
          const confirm = await this.model({ fast });
          this.push('assistant', JSON.stringify(confirm));
          let csay = confirm.say;
          let cres = null;
          if (confirm.tool && LOOK_TOOLS.includes(confirm.tool.name)) {
            // Same truth rule as the main turn: outline first, narrate after.
            cres = await this.execute(confirm.tool);
            if (confirm.tool.name === 'highlight' && !cres.ok) csay = null;
          } else if (confirm.tool) {
            this.transcript?.log('pilot-act', { tool: confirm.tool.name, ok: false, error: 'deferred: acting tools are not allowed on the confirm turn' });
            // Tell the model the action did NOT happen, or its narration and
            // reality diverge ("I'll navigate there now" + nothing moves —
            // observed live). Lands in context for the next learner turn.
            this.push('user', JSON.stringify({
              event: `action_deferred: your ${confirm.tool.name} was NOT executed — one action per learner turn. The page is unchanged; re-issue it on your next turn or ask the learner.`,
            }));
          }
          // Confirm turn saw the fresh snapshot — this is where Terraform is
          // allowed to commit (A1).
          await this.record({ ...confirm, say: csay }, true);
          if (csay) this.speak(csay);
          this.transcript?.log('pilot-turn', { confirm: true, pass, fast, say: csay, tool: confirm.tool?.name ?? null, ...(csay !== confirm.say ? { unspoken: confirm.say } : {}), tookMs: Date.now() - t0 });
          // A confirm-turn outline that failed would have left the learner in
          // silence after their action — run ONE corrected report turn instead.
          if (confirm.tool?.name === 'highlight' && cres && !cres.ok && !hlRetried) {
            hlRetried = true;
            event = `action_failed: highlight — ${cres.error}`;
            fast = true;
            continue;
          }
          // "Let me take a fresh look" was just spoken — the look happens now
          // and the NEXT pass speaks the report. Without this, the request
          // dead-ended and Tony went silent until the learner spoke again.
          if (['snapshot', 'screenshot'].includes(confirm.tool?.name)) {
            await new Promise((r) => setTimeout(r, 1800));   // let the SPA settle
            event = `action_executed: ${confirm.tool.name} — the fresh page state is attached; report to the learner what you see now`;
            fast = true;
            continue;
          }
          break;
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { Lesson };
