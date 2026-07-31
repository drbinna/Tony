'use strict';
/**
 * Tony bridge — content script.
 *
 * Runs in the learner's OWN Chrome on AWS console pages (their login, their
 * session — nothing to re-authenticate). The background service worker owns
 * the WebSocket to the Tony app (the console page's CSP forbids sockets from
 * here) and relays commands via chrome.runtime messaging:
 *   snapshot   -> role/name list of visible, interactive page structure
 *   highlight  -> orange outline + "Tony" chip on an element (guided pointing)
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

function collect() {
  const sel = 'a,button,input,select,textarea,[role],h1,h2,h3,h4';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= 400) break;
    if (!visible(el)) continue;
    const role = roleOf(el);
    if (!role || role === 'presentation' || role === 'none') continue;
    const name = nameOf(el);
    if (!name && !['textbox', 'searchbox', 'combobox'].includes(role)) continue;
    out.push({ el, role, name });
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
  const hit = matches[nth];
  if (!hit) throw new Error(`no visible ${role} matching "${name}" (found ${matches.length})`);
  return hit.el;
}

let chip = null;
function highlight(target, ms = 6000) {
  const el = locate(target);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const prev = el.style.cssText;
  el.style.outline = '3px solid #FF8A3D';
  el.style.outlineOffset = '2px';
  el.style.borderRadius = '4px';
  chip?.remove();
  chip = document.createElement('div');
  chip.textContent = 'Tony';
  chip.style.cssText = 'position:fixed;z-index:2147483647;background:#FF8A3D;color:#1A0D00;'
    + 'font:700 11px -apple-system,sans-serif;padding:2px 8px;border-radius:999px;pointer-events:none;';
  const r = el.getBoundingClientRect();
  chip.style.left = `${Math.max(4, r.left)}px`;
  chip.style.top = `${Math.max(4, r.top - 22)}px`;
  document.documentElement.appendChild(chip);
  setTimeout(() => { el.style.cssText = prev; chip?.remove(); chip = null; }, ms);
}

function click(target) {
  const el = locate(target);
  el.scrollIntoView({ block: 'center' });
  el.click();
}

function type(target, text) {
  const el = locate(target);
  el.scrollIntoView({ block: 'center' });
  el.focus();
  // React swallows plain .value writes; go through the native setter then
  // fire input so controlled components see the change.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, String(text).slice(0, 500));
  else el.value = String(text).slice(0, 500);
  el.dispatchEvent(new Event('input', { bubbles: true }));
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
    if (cmd === 'snapshot') data = snapshot();
    else if (cmd === 'highlight') highlight(args);
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
