'use strict';
/**
 * DesignArtifact — the "design mode" hand-off.
 *
 * This is the INTENT twin of TerraformArtifact's REALITY. Where the lesson's
 * main.tf imports resources Tony actually created in the console one at a time,
 * a design is authored WHOLE by the model from a spoken use-case description and
 * never touched the account — greenfield IaC a cloud engineer can review and
 * `apply`/`deploy` themselves. The two must not mix: a design lives in its own
 * design-<slug>/ subfolder with its own README, so the console-reality main.tf
 * at the session root is never confused with a template that provisions fresh.
 *
 * The model hands over one object: { format, title, summary, template, diagram,
 * notes }. This class validates it, gates Terraform through the same HCL parser
 * the lesson uses (CloudFormation gets a lighter structural check — CFN's !Ref /
 * !GetAtt short tags choke a plain YAML parser, and deploy is the engineer's job
 * anyway since we generate only, never apply), and writes four files:
 *   - main.tf | template.yaml | template.json   the deployable template
 *   - architecture.mmd                          raw Mermaid source
 *   - architecture.html                         self-contained, opens in a browser
 *   - README.md                                 what it provisions + deploy steps
 */
const fs = require('fs');
const path = require('path');

const FORMATS = new Set(['terraform', 'cloudformation']);

/** A filesystem- and Terraform-safe slug. Never empty. */
function slugify(s, fallback = 'design') {
  const out = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return out || fallback;
}

/** Keep Mermaid source intact but strip anything that could break out of the
 *  <pre> it's embedded in. Mermaid's grammar has no legitimate "<", so dropping
 *  angle brackets can't corrupt a valid diagram and closes the injection seam. */
function sanitizeMermaid(s) {
  return String(s || '').replace(/[<>]/g, '').trim();
}

class DesignArtifact {
  /**
   * @param {string} dir            session artifacts dir (design lands in a subfolder)
   * @param {string} region         default AWS region, surfaced in the README
   * @param {function|null} parseHcl async (name, hcl) => obj; throws on bad HCL
   */
  constructor({ dir, region, parseHcl = null, log = console }) {
    this.dir = dir;
    this.region = region;
    this.parseHcl = parseHcl;
    this.log = log;
    this.last = null;   // { dir, format, title, label, diagramPath, files }
  }

  /** Validate + write a design object. Returns { ok, error?, ...info }. */
  async write(design) {
    const d = design || {};
    const format = String(d.format || '').toLowerCase();
    if (!FORMATS.has(format)) {
      return { ok: false, error: `design.format must be "terraform" or "cloudformation", got ${JSON.stringify(d.format)}` };
    }
    const template = String(d.template || '').trim();
    if (!template) return { ok: false, error: 'design.template is empty' };
    if (!this.dir) return { ok: false, error: 'no artifacts dir — cannot write design' };

    const title = slugify(d.title || d.summary, format === 'terraform' ? 'terraform-design' : 'cfn-design');
    const summary = String(d.summary || '').trim();

    // Gate Terraform through the same parser the lesson uses. CloudFormation
    // gets a structural check only (see class header). A gate failure is a
    // warning, not a hard stop — an engineer reviewing a template would rather
    // see a flagged draft than nothing (generate-only; we never apply it).
    let warning = null;
    if (format === 'terraform' && this.parseHcl) {
      try { await this.parseHcl('main.tf', template); }
      catch (e) { warning = `Terraform did not parse: ${String(e.message || e).split('\n')[0].slice(0, 200)}`; }
    } else if (format === 'cloudformation') {
      const looksJson = template.startsWith('{');
      if (looksJson) {
        try { JSON.parse(template); } catch (e) { warning = `CloudFormation JSON did not parse: ${e.message.slice(0, 160)}`; }
      } else if (!/^\s*Resources\s*:/m.test(template)) {
        warning = 'CloudFormation template has no top-level "Resources:" section';
      }
    }
    if (warning) this.log.warn?.(`[design] ${warning}`);

    const subdir = path.join(this.dir, `design-${title}`);
    try { fs.mkdirSync(subdir, { recursive: true }); }
    catch (e) { return { ok: false, error: `cannot create ${subdir}: ${e.message}` }; }

    const templateName = format === 'terraform'
      ? 'main.tf'
      : (template.startsWith('{') ? 'template.json' : 'template.yaml');
    const diagram = sanitizeMermaid(d.diagram);
    const files = [];
    const put = (name, body) => { fs.writeFileSync(path.join(subdir, name), body); files.push(name); };

    try {
      put(templateName, template.endsWith('\n') ? template : `${template}\n`);
      if (diagram) {
        put('architecture.mmd', `${diagram}\n`);
        put('architecture.html', this.renderDiagramHtml(title, summary, diagram));
      }
      put('README.md', this.renderReadme({ format, templateName, title, summary, diagram, notes: d.notes, warning }));
    } catch (e) {
      return { ok: false, error: `write failed: ${e.message}` };
    }

    const label = `${format === 'terraform' ? 'Terraform' : 'CloudFormation'} template · ${title}`;
    const diagramPath = diagram ? path.join(subdir, 'architecture.html') : null;
    this.last = { dir: subdir, format, title, label, diagramPath, files };
    return { ok: true, ...this.last, warning };
  }

  /** Self-contained diagram page. Opens in the user's default browser at full
   *  size — the 220px bubble is far too small to read an architecture on. */
  renderDiagramHtml(title, summary, diagram) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — architecture</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; background: #0B0F0E; color: #E8EDEA;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
  p.sub { color: #7A8B85; font-size: 13px; margin: 0 0 24px; }
  .mermaid { display: flex; justify-content: center; }
  footer { margin-top: 32px; color: #46524d; font-size: 11px; }
</style>
</head>
<body>
  <h1>${title}</h1>
  ${summary ? `<p class="sub">${summary.replace(/[<>]/g, '')}</p>` : ''}
  <pre class="mermaid">
${diagram}
  </pre>
  <footer>Generated by Tony — greenfield design, review before deploying.</footer>
  <script type="module">
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
    mermaid.initialize({ startOnLoad: true, theme: 'dark' });
  </script>
</body>
</html>
`;
  }

  renderReadme({ format, templateName, title, summary, diagram, notes, warning }) {
    const isTf = format === 'terraform';
    const lines = [
      `# Design: ${title}`,
      '',
      summary || '_A greenfield infrastructure design generated by Tony from a spoken description._',
      '',
      `**This is intent, not reality.** Nothing here was created in your account — it is a template to review and deploy yourself. Region defaults to \`${this.region}\`.`,
      '',
      `## Files`,
      `- \`${templateName}\` — the ${isTf ? 'Terraform' : 'CloudFormation'} template.`,
    ];
    if (diagram) {
      lines.push(
        '- `architecture.html` — the architecture diagram; open it in a browser.',
        '- `architecture.mmd` — the same diagram as Mermaid source.',
      );
    }
    lines.push('', '## Deploy', '');
    if (isTf) {
      lines.push(
        '```sh',
        'terraform init',
        'terraform plan     # review every resource before applying',
        'terraform apply',
        '```',
      );
    } else {
      lines.push(
        '```sh',
        `aws cloudformation deploy \\`,
        `  --template-file ${templateName} \\`,
        `  --stack-name ${title} \\`,
        `  --region ${this.region} \\`,
        '  --capabilities CAPABILITY_NAMED_IAM',
        '```',
      );
    }
    lines.push('', '> Review costs and IAM before deploying — this template can create billable resources.');
    if (notes) lines.push('', '## Notes', '', String(notes).trim());
    if (warning) lines.push('', `> ⚠️ Draft flag: ${warning} — review this template carefully before use.`);
    return `${lines.join('\n')}\n`;
  }
}

module.exports = { DesignArtifact, slugify, sanitizeMermaid };
