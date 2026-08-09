'use strict';
/**
 * Tony bridge — content script.
 *
 * Runs in the learner's OWN Chrome on AWS console pages (their login, their
 * session — nothing to re-authenticate). The background service worker owns
 * the WebSocket to the Tony app (the console page's CSP forbids sockets from
 * here) and relays commands via chrome.runtime messaging:
 *   snapshot   -> role/name list of visible, interactive page structure
 *   highlight  -> persistent glowing outline + "Tony" chip (guided pointing)
 *   click      -> DOM click on an element (only sent after learner consent)
 *   type       -> focus a field and set its value React-compatibly
 *   press      -> dispatch a keyboard event to the focused element
 *   goto       -> navigate (Tony whitelists to AWS hosts before sending)
 */

// ---------------------------------------------------------------- snapshot

const ROLE_MAP = {
  a: 'link', button: 'button', select: 'combobox', textarea: 'textbox',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading',
  nav: 'navigation', table: 'table', img: 'img', label: 'text',
};

function roleOf(el) {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'submit' || t === 'button') return 'button';
    if (t === 'search') return 'searchbox';
    return 'textbox';
  }
  return ROLE_MAP[tag] || null;
}

function nameOf(el) {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const t = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ').trim();
    if (t) return t;
  }
  const ph = el.getAttribute('placeholder');
  if (ph) return ph.trim();
  const alt = el.getAttribute('alt');
  if (alt) return alt.trim();
  const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ');
  return text.slice(0, 80);
}

function visible(el) {
  if (!el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

/** The console renders service dashboards inside same-origin iframes (EC2's
 *  body lives in one) — walk them too or Tony sees only the shell. */
function docs() {
  const list = [document];
  const walk = (doc, depth) => {
    if (depth > 2) return;
    for (const f of doc.querySelectorAll('iframe')) {
      try {
        if (f.contentDocument) { list.push(f.contentDocument); walk(f.contentDocument, depth + 1); }
      } catch { /* cross-origin — skip */ }
    }
  };
  walk(document, 0);
  return list;
}

function collect() {
  const sel = 'a,button,input,select,textarea,[role],h1,h2,h3,h4';
  const out = [];
  for (const doc of docs()) {
    for (const el of doc.querySelectorAll(sel)) {
      if (out.length >= 400) return out;
      if (!visible(el)) continue;
      const role = roleOf(el);
      if (!role || role === 'presentation' || role === 'none') continue;
      const name = nameOf(el);
      if (!name && !['textbox', 'searchbox', 'combobox'].includes(role)) continue;
      out.push({ el, role, name });
    }
  }
  return out;
}

function snapshot() {
  const items = collect();
  const lines = items.map(({ el, role, name }) => {
    const extra = [];
    if (el.disabled) extra.push('disabled');
    if (el.checked) extra.push('checked');
    if (role === 'heading') extra.push(`level=${el.tagName[1] ?? ''}`);
    return `- ${role} "${name}"${extra.length ? ` [${extra.join(', ')}]` : ''}`;
  });
  let tree = lines.join('\n');
  const truncated = tree.length > 14000;
  if (truncated) tree = `${tree.slice(0, 14000)}\n… (truncated)`;
  return { url: location.href, title: document.title, tree, truncated };
}

// ------------------------------------------------------------------ acting

function locate({ role, name, nth = 0 }) {
  const want = String(name || '').toLowerCase();
  const matches = collect().filter((c) =>
    c.role === role && (c.name.toLowerCase() === want || c.name.toLowerCase().includes(want)));
  if (!matches.length) throw new Error(`no visible ${role} matching "${name}" (found 0)`);
  // A page can expose several elements whose ACCESSIBLE name matches while only
  // one is the control the learner sees. The S3 "Create bucket" / "Delete
  // bucket" pages each carry a Cloudscape "Info" icon next to the heading; that
  // icon has no visible text of its own but borrows the heading's label via
  // aria-labelledby, so nameOf() reports its name as "Delete bucket" too. Taking
  // the first DOM match grabbed that icon — the click reported ok but only
  // opened the Help panel and never submitted. Rank so the genuine target wins:
  //   ownText  — the element's OWN visible text says the label (the real button)
  //              vs. a name merely borrowed via aria-labelledby (the info icon)
  //   exact    — accessible name equals the query rather than just contains it
  //   notHidden— rendered in positive coordinate space, not scrolled off top/left
  //   area     — a real button beats a tiny icon
  // Then index nth into that best-first order.
  const ranked = matches
    .map((c) => {
      const el = c.el;
      const r = el.getBoundingClientRect();
      const own = (el.innerText || el.value || '').trim().toLowerCase();
      return {
        c,
        ownText: own.includes(want) ? 1 : 0,
        exact: c.name.toLowerCase() === want ? 1 : 0,
        notHidden: r.bottom > 0 && r.right > 0 ? 1 : 0,
        area: Math.max(0, r.width) * Math.max(0, r.height),
      };
    })
    .sort((a, b) =>
      b.ownText - a.ownText || b.exact - a.exact || b.notHidden - a.notHidden || b.area - a.area);
  return (ranked[nth] || ranked[0]).c;
}

// --------------------------------------------------------------- highlight
// Persistent tracked highlight — the pointing is the product, so it is built
// to survive what the console throws at it:
//  - an overlay box, not inline styles on the target: Cloudscape re-renders
//    rewrite element styles mid-lesson and would wipe the outline
//  - rAF tracking keeps the box glued to the element through scrolling and
//    layout shifts, and re-locates by role/name if React replaces the node
//  - NO removal timer: turns take 15-20s and the learner looks up when Tony
//    finishes talking. The outline stays until the next command replaces or
//    clears it. If the element stays gone for 8s (panel closed), it clears
//    rather than float over nothing.
let hl = null;   // { target, el, box, missedAt }

function ensureHlStyle(doc) {
  if (doc.getElementById('tony-hl-style')) return;
  const st = doc.createElement('style');
  st.id = 'tony-hl-style';
  st.textContent = '@keyframes tony-hl-pulse {'
    + '0%,100% { box-shadow: 0 0 0 4px rgba(255,138,61,.30), 0 0 22px 6px rgba(255,138,61,.55); }'
    + '50% { box-shadow: 0 0 0 7px rgba(255,138,61,.16), 0 0 30px 10px rgba(255,138,61,.75); }'
    + '}';
  doc.documentElement.appendChild(st);
}

function clearHighlight() {
  if (!hl) return;
  hl.box.remove();
  hl = null;       // the tracking loop sees the swap and exits
}

function trackHighlight(state) {
  if (hl !== state) return;
  if (!state.el || !state.el.isConnected || !visible(state.el)) {
    try { state.el = locate(state.target).el; } catch { state.el = null; }
  }
  if (state.el) {
    state.missedAt = 0;
    const r = state.el.getBoundingClientRect();
    const s = state.box.style;
    s.display = 'block';
    s.left = `${r.left - 5}px`;
    s.top = `${r.top - 5}px`;
    s.width = `${r.width + 4}px`;
    s.height = `${r.height + 4}px`;
  } else {
    state.missedAt ||= performance.now();
    state.box.style.display = 'none';
    if (performance.now() - state.missedAt > 8000) { clearHighlight(); return; }
    state.el = null;
  }
  requestAnimationFrame(() => trackHighlight(state));
}

function highlight(target) {
  const hit = locate(target);
  clearHighlight();
  // Anchor in the element's OWN document so iframe coordinates stay correct
  // (fixed positioning is per-frame viewport).
  const doc = hit.el.ownerDocument;
  ensureHlStyle(doc);
  hit.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const box = doc.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;'
    + 'border:3px solid #FF8A3D;border-radius:6px;'
    + 'animation:tony-hl-pulse 1.6s ease-in-out infinite;';
  const chip = doc.createElement('div');
  chip.textContent = 'Tony';
  chip.style.cssText = 'position:absolute;top:-24px;left:-3px;background:#FF8A3D;color:#1A0D00;'
    + 'font:700 11px -apple-system,sans-serif;padding:2px 8px;border-radius:999px;';
  box.appendChild(chip);
  doc.documentElement.appendChild(box);
  hl = { target, el: hit.el, box, missedAt: 0 };
  trackHighlight(hl);
  // Proof for the app: what got outlined and where it sits right now.
  const r = hit.el.getBoundingClientRect();
  return { role: hit.role, name: hit.name, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
}

function click(target) {
  const el = locate(target).el;
  el.scrollIntoView({ block: 'center' });
  el.click();
}

/** Write a value through the input/textarea prototype's native setter so
 *  React's value tracker sees the change (a plain el.value= is ignored). */
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
}

function type(target, text) {
  const el = locate(target).el;
  el.scrollIntoView({ block: 'center' });
  // Some AWS console fields (Cloudscape autosuggest, the unified search) mount
  // or arm their input on click/focus, so do both before typing.
  el.click?.();
  el.focus();
  const str = String(text).slice(0, 500);

  // contenteditable widgets ignore value sets — insert text the DOM way.
  if (el.isContentEditable) {
    try { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, str); } catch { el.textContent = str; }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: str }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  // Clear whatever's there first (native setter + input so React resets state).
  setNativeValue(el, '');
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));

  // Type character by character with a full key + InputEvent sequence. A single
  // bare value-set is why AWS's search box stayed empty — Cloudscape/React
  // autosuggest only registers per-keystroke InputEvents, not a plain Event.
  let acc = '';
  for (const ch of str) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
    acc += ch;
    setNativeValue(el, acc);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: false, inputType: 'insertText', data: ch }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
  }
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function press(key) {
  const el = document.activeElement || document.body;
  for (const kind of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(kind, { key, bubbles: true, cancelable: true }));
  }
}

// ------------------------------------------------------------------- wire

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const { cmd, args = {} } = msg || {};
  try {
    let data = null;
    // Acting moves the lesson forward — a stale outline would point at the
    // past. Look-only commands (snapshot/ping) leave it alone.
    if (['click', 'type', 'press', 'goto'].includes(cmd)) clearHighlight();
    if (cmd === 'snapshot') data = snapshot();
    else if (cmd === 'highlight') data = highlight(args);
    else if (cmd === 'clearHighlight') clearHighlight();
    else if (cmd === 'click') click(args);
    else if (cmd === 'type') type(args, args.text);
    else if (cmd === 'press') press(args.key || 'Enter');
    else if (cmd === 'goto') location.assign(args.url);
    else if (cmd === 'ping') data = { url: location.href };
    else throw new Error(`unknown cmd ${cmd}`);
    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
  return false;   // responses above are synchronous
});

// Wake the background worker (it may have been reaped while the Tony app was
// down) so it reconnects the moment a console page loads.
try { chrome.runtime.sendMessage({ event: 'wake' }, () => chrome.runtime.lastError); } catch { /* ignore */ }
