'use strict';
/**
 * TerraformArtifact — the resource-map renderer behind Tony's lesson hand-off.
 *
 * The model never authors the whole file. It sends one CONFIRMED resource at a
 * time (op + body + import id, only after a console snapshot proves the step
 * worked); this class owns the map and re-renders the entire main.tf from
 * templates on every change. That makes the deterministic parts — the pinned
 * skeleton, block ordering, import blocks, and the README projection — the
 * app's job, and keeps the unbounded part (arbitrary resource bodies) on the
 * model, where a bundled HCL parser gates it at two points:
 *   1. commit time — each body is wrapped in its real block shell and parsed
 *      BEFORE it enters the map, so a malformed turn is rejected while the
 *      model is still in context, not surfaced ten steps later.
 *   2. render time — the whole assembled file is parsed before it is handed
 *      back for saving; a failure keeps the last-good file.
 *
 * Model-authored content flows through the parser; app-generated structure
 * (skeleton, imports) is deterministic and trusted.
 */

// Opaque, hallucination-prone import IDs get a format check (H2). A model that
// invents "sg-0123456789abcdef0" parses fine as HCL and only fails on the
// developer's machine — the exact trust-killer A3 exists to prevent. On a
// mismatch we drop the ID and fall back to the REPLACE_ME + TODO path, turning
// "the model got creative" into the designed degraded mode. Types absent from
// the table (composite IDs, name-addressed sub-resources we can't cheaply
// bound) pass through — the table is a safety net for the common opaque forms,
// not a whitelist.
const HEX = '[0-9a-f]{8,17}';
const S3_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IMPORT_ID_PATTERNS = {
  aws_security_group: new RegExp(`^sg-${HEX}$`),
  aws_vpc_security_group_ingress_rule: new RegExp(`^sgr-${HEX}$`),
  aws_vpc_security_group_egress_rule: new RegExp(`^sgr-${HEX}$`),
  aws_instance: new RegExp(`^i-${HEX}$`),
  aws_ebs_volume: new RegExp(`^vol-${HEX}$`),
  aws_subnet: new RegExp(`^subnet-${HEX}$`),
  aws_vpc: new RegExp(`^vpc-${HEX}$`),
  aws_key_pair: /^[\w .+=@/-]{1,255}$/,
  // S3 sub-resources import by bucket name.
  aws_s3_bucket: S3_NAME,
  aws_s3_bucket_public_access_block: S3_NAME,
  aws_s3_bucket_server_side_encryption_configuration: S3_NAME,
  aws_s3_bucket_versioning: S3_NAME,
  aws_s3_bucket_ownership_controls: S3_NAME,
};

/** Indent every non-blank line by n spaces, preserving relative nesting. */
function indent(text, n = 2) {
  const pad = ' '.repeat(n);
  return String(text ?? '')
    .replace(/\s+$/, '')
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : pad + l))
    .join('\n');
}

/** Strip a redundant self-wrapper the model sometimes includes: if the body IS
 *  exactly the `<kind> "labels" { … }` block it's meant to fill, unwrap it once.
 *  This class of error passes the HCL syntax gate — `variable { variable {} }`
 *  is legal HCL, just broken Terraform — so it must be normalized structurally,
 *  not caught by parsing. The match requires the SAME kind and labels, so a
 *  legitimate inner body (or a nested block of a different kind) is untouched. */
function stripWrapper(kind, labels, body) {
  const t = String(body ?? '').trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = [kind, ...labels.map((l) => JSON.stringify(l))].map(esc).join('\\s+');
  const m = t.match(new RegExp(`^${head}\\s*\\{([\\s\\S]*)\\}\\s*$`));
  return m ? m[1].trim() : t;
}

/** A labelled HCL block: block('resource', ['aws_s3_bucket','x'], body). The
 *  exact string this returns is what gets parsed AND what gets rendered, so the
 *  commit-time gate validates precisely what will land in the file. */
function block(kind, labels, body) {
  const head = [kind, ...labels.map((l) => JSON.stringify(l))].join(' ');
  const inner = stripWrapper(kind, labels, body);
  return inner ? `${head} {\n${indent(inner)}\n}` : `${head} {}`;
}

class TerraformArtifact {
  /** parse: async (filename, hcl) => object; throws on malformed HCL. When it
   *  can't be loaded, gating degrades to a warn-only no-op rather than bricking
   *  the whole hand-off feature. */
  constructor({ region, accountAlias, sessionId, parse = null, log = console }) {
    this.region = region;
    this.accountAlias = accountAlias;
    this.sessionId = sessionId;
    this.parse = parse;
    this.log = log;

    this.resources = new Map();   // address -> { type, name, step, body, importId, importTodo }
    this.order = [];              // resource addresses in first-seen order
    this.variables = new Map();   // name -> body
    this.dataSources = new Map(); // address -> { type, name, body }
    this.outputs = new Map();     // name -> body
    this.failures = [];           // { step, error, remediation }
  }

  get hasResources() { return this.resources.size > 0; }
  get resourceCount() { return this.resources.size; }

  /** Parse an HCL fragment in isolation. Returns { ok, error }. A missing
   *  parser degrades open (ok:true) with a one-time warning — never blocks. */
  async gate(hcl) {
    if (!this.parse) { return { ok: true }; }
    try { await this.parse('snippet.tf', hcl); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e.message || e).split('\n')[0].slice(0, 200) }; }
  }

  /** Commit one confirmed resource. Returns { ok, error?, warning? }.
   *  op: 'create' | 'modify' | 'delete'. body is a FULL replacement of the
   *  resource body on modify, never a patch. */
  async applyResource(r) {
    const { op = 'create', type, name, step = '', body = '' } = r || {};
    if (!type || !name) return { ok: false, error: 'resource needs type and name' };
    const address = `${type}.${name}`;

    if (op === 'delete') {
      if (this.resources.delete(address)) {
        this.order = this.order.filter((a) => a !== address);
        return { ok: true };
      }
      return { ok: true, warning: `delete for unknown ${address} — ignored` };
    }

    // H1: gate the body inside its real block shell before it can enter the map.
    const shell = block('resource', [type, name], body);
    const g = await this.gate(shell);
    if (!g.ok) return { ok: false, error: `malformed body for ${address}: ${g.error}` };

    // H2: validate the import id; drop + fall back on mismatch.
    let importId = r.import_id ?? null;
    let importTodo = r.import_todo ?? null;
    let warning;
    const pattern = IMPORT_ID_PATTERNS[type];
    if (importId != null && pattern && !pattern.test(String(importId))) {
      warning = `import_id ${JSON.stringify(importId)} fails ${type} format — using REPLACE_ME`;
      importTodo = importTodo || `find the real ${type} id in the console`;
      importId = null;
    }

    // H4: create-on-existing self-heals to modify.
    const existed = this.resources.has(address);
    if (op === 'create' && existed) warning = warning || `create for existing ${address} — treated as modify`;
    if (!existed) this.order.push(address);
    this.resources.set(address, { type, name, step, body: String(body).trim(), importId, importTodo });
    return { ok: true, ...(warning ? { warning } : {}) };
  }

  async applyVariable({ name, body }) {
    if (!name) return { ok: false, error: 'variable needs a name' };
    const g = await this.gate(block('variable', [name], body));
    if (!g.ok) return { ok: false, error: `malformed variable ${name}: ${g.error}` };
    this.variables.set(name, String(body).trim());
    return { ok: true };
  }

  async applyData({ type, name, body }) {
    if (!type || !name) return { ok: false, error: 'data source needs type and name' };
    const g = await this.gate(block('data', [type, name], body));
    if (!g.ok) return { ok: false, error: `malformed data ${type}.${name}: ${g.error}` };
    this.dataSources.set(`${type}.${name}`, { type, name, body: String(body).trim() });
    return { ok: true };
  }

  async applyOutput({ name, body }) {
    if (!name) return { ok: false, error: 'output needs a name' };
    const g = await this.gate(block('output', [name], body));
    if (!g.ok) return { ok: false, error: `malformed output ${name}: ${g.error}` };
    this.outputs.set(name, String(body).trim());
    return { ok: true };
  }

  addFailure({ step = '', error = '', remediation = '' }) {
    this.failures.push({ step, error, remediation });
  }

  /** App-rendered import block — canonical multi-line, never a one-liner, with
   *  a REPLACE_ME placeholder + TODO when the real id was never captured. */
  importBlock(address, id, todo) {
    if (id) return `import {\n  to = ${address}\n  id = ${JSON.stringify(id)}\n}`;
    const placeholder = `REPLACE_ME_${address.replace(/[^\w]+/g, '_')}`;
    const todoLine = todo ? `  # TODO(dev): ${todo}\n` : '';
    return `import {\n  to = ${address}\n${todoLine}  id = ${JSON.stringify(placeholder)}\n}`;
  }

  /** The pinned skeleton + hand-off contract header (A6 / Part C). */
  header() {
    return [
      `# Tony — guided AWS console lesson. Session ${this.sessionId} · ${this.region} · ${this.accountAlias}`,
      '# These resources ALREADY EXIST. To adopt them into Terraform:',
      '#   terraform init && terraform plan   → should show the imports below and ZERO changes.',
      '#   If plan wants to add/modify anything, the file drifted — fix the file, not the account.',
      '',
      'terraform {',
      '  required_version = ">= 1.5"',
      '',
      '  required_providers {',
      '    aws = {',
      '      source  = "hashicorp/aws"',
      '      version = "~> 5.0"',
      '    }',
      '  }',
      '}',
      '',
      'provider "aws" {',
      `  region = ${JSON.stringify(this.region)}`,
      '}',
    ].join('\n');
  }

  /** Re-render the entire main.tf from the map. Order: header, variables, data,
   *  resources (each with its step comment), imports, outputs. */
  renderMainTf() {
    const parts = [this.header()];

    for (const name of [...this.variables.keys()].sort()) {
      parts.push(block('variable', [name], this.variables.get(name)));
    }
    for (const address of [...this.dataSources.keys()].sort()) {
      const d = this.dataSources.get(address);
      parts.push(block('data', [d.type, d.name], d.body));
    }
    for (const address of this.order) {
      const res = this.resources.get(address);
      if (!res) continue;
      const comment = res.step ? `# ${res.step}` : `# ${address}`;
      parts.push(`${comment}\n${block('resource', [res.type, res.name], res.body)}`);
    }
    // Import blocks grouped after the resources they adopt.
    const imports = this.order
      .map((a) => this.resources.get(a))
      .filter(Boolean)
      .map((res) => this.importBlock(`${res.type}.${res.name}`, res.importId, res.importTodo));
    if (imports.length) parts.push(imports.join('\n\n'));

    for (const name of [...this.outputs.keys()].sort()) {
      parts.push(block('output', [name], this.outputs.get(name)));
    }
    return `${parts.join('\n\n')}\n`;
  }

  /** The REPLACE_ME import ids the developer still has to resolve (Part C.4). */
  get replaceMeTodos() {
    return this.order
      .map((a) => this.resources.get(a))
      .filter((r) => r && !r.importId)
      .map((r) => ({ address: `${r.type}.${r.name}`, todo: r.importTodo || 'find the real id in the console' }));
  }

  /** README — a pure projection of the same map, so it cannot disagree with
   *  main.tf (B2), plus the developer hand-off contract (Part C). */
  renderReadme({ lessonGoal, steps = [] }) {
    const lines = [
      `# Lesson: ${lessonGoal}`,
      '',
      `Region **${this.region}**, account **${this.accountAlias}**. Generated live by Tony; each step below happened in the AWS console.`,
      '',
    ];
    steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');

    if (this.resources.size) {
      lines.push('## Resources created', '');
      for (const address of this.order) {
        const r = this.resources.get(address);
        if (r) lines.push(`- \`${address}\`${r.step ? ` — ${r.step}` : ''}`);
      }
      lines.push('', '`main.tf` in this folder reproduces them with Terraform.', '');
    } else {
      lines.push('_No resources were created this session._', '');
    }

    if (this.failures.length) {
      lines.push('## Failed / omitted steps', '');
      for (const f of this.failures) {
        lines.push(`- **${f.step || 'step'}** — ${f.error}${f.remediation ? ` _(fix: ${f.remediation})_` : ''}`);
      }
      lines.push('');
    }

    // The hand-off contract only makes sense when there is a main.tf to adopt.
    // With no resources there is nothing to init/plan, so the section is omitted
    // rather than pointing a developer at a file that was never written.
    if (this.resources.size) {
      const todos = this.replaceMeTodos;
      if (todos.length) {
        lines.push('## Import IDs to fill in before applying', '');
        for (const t of todos) lines.push(`- \`${t.address}\` — ${t.todo}`);
        lines.push('');
      }
      lines.push(
        '## Handing this off to a developer',
        '',
        `These resources already exist in account **${this.accountAlias}**, region **${this.region}**.`,
        '',
        '1. `terraform init && terraform plan`',
        '2. **Acceptance test:** the plan should show the `import` blocks and **zero changes**. Any add/modify means this file drifted — fix the file, not the account.',
        todos.length ? '3. Resolve every `REPLACE_ME` import id above before applying.' : null,
        '',
      );
    }
    return `${lines.filter((l) => l !== null).join('\n')}\n`;
  }

  /** Whole-file gate (B3). Returns { ok, error?, mainTf, readme }. */
  async build({ lessonGoal, steps }) {
    const mainTf = this.renderMainTf();
    const readme = this.renderReadme({ lessonGoal, steps });
    if (!this.parse) return { ok: true, mainTf, readme };
    try { await this.parse('main.tf', mainTf); return { ok: true, mainTf, readme }; }
    catch (e) { return { ok: false, error: String(e.message || e).split('\n')[0].slice(0, 200), mainTf, readme }; }
  }
}

module.exports = { TerraformArtifact, IMPORT_ID_PATTERNS, block, indent };
