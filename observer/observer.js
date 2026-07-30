'use strict';
/**
 * Observer — Tony's sense loop.
 *
 * Runs the Swift AX helper on a tick, normalizes the tree, decides whether
 * anything MEANINGFUL changed, and emits events. This layer contains no model
 * calls at all: the latency harness showed that even the fastest model in the
 * catalog costs 500ms+ at p50 with a multi-second tail, so nothing inferential
 * can live on a per-tick path. The tick is deterministic code; the brain is
 * woken only on change.
 */
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const HELPER = path.join(__dirname, 'ax-dump');

/** Screen identity from window title + tree shape. Drives bridge selection and
 *  precompute targeting, so it must be cheap and stable — no model involved. */
function identifyScreen({ frontmost_app, window_title, document_url, a11y_tree }) {
  const title = (window_title || '').toLowerCase();
  const url = (document_url || '').toLowerCase();
  const blob = a11y_tree.map((n) => `${n.label} ${n.value}`).join(' ').toLowerCase();

  const isBrowser = /chrome|safari|firefox|arc|edge/i.test(frontmost_app || '');

  // URL is the reliable signal. Title sniffing was the original approach and it
  // failed on the real console: "Console Home" contains neither "AWS" nor a
  // service name, so Tony sat DORMANT on the console's own landing page.
  // Titles vary per service and per page; the hostname does not.
  const isConsoleUrl = /(^|\/\/)([a-z0-9-]+\.)?console\.aws\.amazon\.com/.test(url);

  const SERVICE_TOKEN = /\b(ec2|s3|iam|vpc|rds|lambda|cloudfront|route\s?53|cloudwatch|dynamodb|eks|ecs)\b/;
  const REGION = /\b(us|eu|ap|sa|ca|me|af)-(east|west|north|south|central|northeast|southeast|northwest|southwest)-\d\b/;

  // Title fallback for browsers that do not expose AXDocument/AXURL. Kept
  // deliberately narrow so a docs tab like "Terraform Registry - aws_instance"
  // does not trip it.
  const titleLooksLikeConsole =
    /aws management console|console home/.test(title) ||
    (SERVICE_TOKEN.test(title) && REGION.test(`${title} ${blob}`));

  const isAws = isBrowser && (isConsoleUrl || (!url && titleLooksLikeConsole));

  if (!isAws) {
    return { app: frontmost_app, aws: false, service: null, page: null, key: `off:${frontmost_app}` };
  }

  // Service comes from the URL path when available: console.aws.amazon.com/ec2/…
  const urlService = url.match(/console\.aws\.amazon\.com\/([a-z0-9-]+)/)?.[1];
  const service =
    urlService && urlService !== 'console' ? urlService.replace(/^route53$/, 'route53') :
    /\bec2\b/.test(title) || /launch an instance/.test(title) ? 'ec2' :
    /\bs3\b/.test(title) ? 's3' :
    /\biam\b/.test(title) ? 'iam' :
    /vpc/.test(title) ? 'vpc' :
    /cloudfront/.test(title) ? 'cloudfront' :
    /route\s?53/.test(title) ? 'route53' :
    /console home/.test(title) || /\/console\/home/.test(url) ? 'home' : 'unknown';

  const page =
    /launch an instance/.test(title) || /#launchinstance/i.test(url) ? 'launch_wizard' :
    /security group/.test(blob) || /#securitygroup/i.test(url) ? 'security_groups' :
    /create bucket/.test(title) ? 'create_bucket' :
    /policy/.test(blob) && service === 'iam' ? 'policy_editor' :
    service === 'home' ? 'home' : 'listing';

  return { app: frontmost_app, aws: true, service, page, key: `${service}:${page}` };
}

/** Facts worth reacting to, extracted deterministically. These are the trigger
 *  conditions from the persona spec — no model needed to spot 0.0.0.0/0.
 *
 *  CRITICAL DISTINCTION: state signals must be read from INTERACTIVE FIELD
 *  VALUES, never from static text. AWS's own warning banner contains the
 *  literal string "0.0.0.0/0" ("Rules with source of 0.0.0.0/0 allow all IP
 *  addresses..."), so scanning all text keeps the signal lit even after the
 *  learner fixes the field — and Tony nags about a solved problem forever.
 *  Measured in test/session-sim.js before this split existed. */
const FIELD_ROLES = ['textfield', 'textarea', 'combobox', 'popupbutton', 'checkbox', 'radiobutton'];

function extractSignals(tree) {
  const signals = [];

  // what the learner has actually SET
  const fieldText = tree
    .filter((n) => FIELD_ROLES.includes(n.role))
    .map((n) => `${n.label} ${n.value}`).join(' | ');

  // what the page merely SAYS (banners, headings, summaries)
  const allText = tree.map((n) => `${n.label} ${n.value}`).join(' | ');

  if (/0\.0\.0\.0\/0/.test(fieldText)) signals.push('open_to_world');
  if (/\bport\s*22\b|(^|\W)ssh(\W|$)/i.test(fieldText) && /0\.0\.0\.0\/0/.test(fieldText)) {
    signals.push('ssh_open_to_world');
  }
  if (/\ball traffic\b|\banywhere\b/i.test(fieldText) && !/my ip/i.test(fieldText)) {
    signals.push('broad_source');
  }
  if (/public|publicly accessible/i.test(fieldText)) signals.push('possibly_public');
  if (/"?Action"?\s*:\s*"?\*"?|Resource.*\*/.test(fieldText)) signals.push('wildcard_iam');

  // status indicators legitimately live in static chrome
  if (/root user|logged in as root/i.test(allText)) signals.push('root_usage');

  const m = allText.match(/\b([a-z]\d[a-z]?\.(nano|micro|small|medium|large|\d*xlarge))\b/i);
  if (m) signals.push(`instance_type:${m[1]}`);

  return signals;
}

/** Hash only what we care about, so cosmetic repaints don't wake the brain. */
function stateHash(screen, signals, tree) {
  const salient = tree
    .filter((n) => ['button', 'textfield', 'popupbutton', 'checkbox', 'combobox'].includes(n.role))
    .map((n) => `${n.role}:${n.label}:${n.value}`)
    .join('|');
  return crypto.createHash('sha1')
    .update(`${screen.key}||${signals.join(',')}||${salient}`)
    .digest('hex')
    .slice(0, 16);
}

class Observer extends EventEmitter {
  constructor({ intervalMs = 1500 } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.timer = null;
    this.lastHash = null;
    this.lastScreenKey = null;
    this.consecutiveFailures = 0;
    this.idleSince = Date.now();
    this.latest = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    execFile(HELPER, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures === 1 || this.consecutiveFailures % 20 === 0) {
          this.emit('observer-error', {
            message: err.code === 'ENOENT'
              ? 'ax-dump helper not built — run observer/build.sh'
              : err.message,
            consecutive: this.consecutiveFailures,
          });
        }
        return;
      }

      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch {
        return;
      }

      if (payload.error) {
        this.emit('observer-error', { message: payload.error, fatal: payload.error.includes('permission') });
        return;
      }

      this.consecutiveFailures = 0;
      const screen = identifyScreen(payload);
      const signals = extractSignals(payload.a11y_tree);
      const hash = stateHash(screen, signals, payload.a11y_tree);

      const frame = {
        screen,
        signals,
        tree: payload.a11y_tree,
        windowTitle: payload.window_title,
        documentUrl: payload.document_url || '',
        truncated: payload.truncated,
        at: Date.now(),
      };
      this.latest = frame;

      // Off-console: Tony goes quiet. Persona rule — if the learner is not in
      // the console and has not asked anything, say nothing at all.
      if (!screen.aws) {
        if (this.lastScreenKey !== screen.key) {
          this.lastScreenKey = screen.key;
          this.emit('left-console', frame);
        }
        return;
      }

      if (hash === this.lastHash) {
        const idleMs = Date.now() - this.idleSince;
        // Idle threshold matches the persona spec's stuck-detection window.
        if (idleMs > 45000 && idleMs < 46500) this.emit('idle', { ...frame, idleMs });
        return;
      }

      this.lastHash = hash;
      this.idleSince = Date.now();

      if (this.lastScreenKey !== screen.key) {
        this.lastScreenKey = screen.key;
        this.emit('screen-changed', frame);   // strongest precompute trigger
      } else {
        this.emit('state-changed', frame);
      }
    });
  }
}

module.exports = { Observer, identifyScreen, extractSignals };
