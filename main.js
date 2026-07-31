'use strict';
require('dotenv').config();

const { app, BrowserWindow, ipcMain, screen, globalShortcut, systemPreferences, shell } = require('electron');
const path = require('path');
const { Observer } = require('./observer/observer');
const { Brain, SLOW_MODEL, FAST_MODEL } = require('./brain/server');
const { Pointer } = require('./pointer/pointer');
const { Driver } = require('./pointer/driver');
const { Transcript } = require('./brain/transcript');
const { Grounder } = require('./brain/vision');

const WIDTH = 220;
const HEIGHT = 340;

let win = null;
let observer = null;
let brain = null;
let pointer = null;
let driver = null;
let grounder = null;
let transcript = null;

// ---------------------------------------------------------------- window

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: workArea.x + workArea.width - WIDTH - 24,
    y: workArea.y + 24,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // Shown via showInactive() below: a normally-shown window takes focus at
    // launch, Electron becomes the frontmost app, and the observer's
    // self-focus skip leaves Tony blind (latest=null) until the learner
    // clicks elsewhere — measured as 42-78s of blindness in live sessions.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Unfocused renderers get throttled; this one runs WebRTC permanently.
      backgroundThrottling: false,
    },
  });

  // float above fullscreen apps — the learner will be fullscreen in the console
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // NOT ready-to-show: it can never fire for transparent windows (observed
  // live — the window stayed hidden and the Anam session never established).
  // did-finish-load is reliable; the timer is the fallback if load itself
  // wedges, because an invisible overlay is worse than a briefly blank one.
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
    .then(() => { if (!win.isDestroyed() && !win.isVisible()) win.showInactive(); })
    .catch(() => {});
  setTimeout(() => {
    if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
  }, 2000);

  // A renderer that fails to load is invisible from the outside: the card shows
  // its hardcoded HTML defaults, buttons are dead, and nothing logs. Surface it.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    // srtp/RTCP unprotect failures are benign WebRTC decrypt retries; at volume
    // they bury real errors. Count them, surface only a periodic summary.
    if (/srtp_transport|Failed to unprotect|hv_vmm_present/.test(message)) {
      rtpNoise += 1;
      if (rtpNoise % 100 === 0) console.warn(`[webrtc] ${rtpNoise} packet-decrypt retries (network congestion)`);
      return;
    }
    if (level >= 2) console.error(`[renderer] ${source}:${line} ${message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[renderer] failed to load: ${desc} (${code})`);
  });
  win.webContents.on('preload-error', (_e, p2, err) => {
    console.error(`[preload] ${p2}: ${err.message}`);
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ------------------------------------------------------------ permissions

async function checkPermissions() {
  if (process.platform !== 'darwin') {
    return { accessibility: false, note: 'macOS only for now — AX tree is the primary sense' };
  }
  // prompts once, then reflects the System Settings toggle
  const accessibility = systemPreferences.isTrustedAccessibilityClient(true);
  return { accessibility };
}

// ----------------------------------------------------------------- deadman

/**
 * Any learner input while Tony is driving aborts immediately. This is the
 * safety mechanism AND a character beat — the persona has a scripted line for
 * it ("You moved, I stopped. House rules.") so the scariest moment in the
 * product becomes a trust-building one.
 */
let driving = false;
let rtpNoise = 0;

function abortDriving(reason) {
  pointer?.clear();                  // learner acted: drop the ring immediately
  driver?.abort();                   // kill any in-flight gesture NOW
  if (!driving) return;
  driving = false;
  transcript?.log('deadman-abort', { reason });
  send('state', { state: 'observing' });
  send('deadman-abort', { reason });
}

/**
 * brain.ask with the transcript wrapped around it: the question going in, the
 * dispatch decision (cache vs bridge) and latency coming out, plus a running
 * cache-stats snapshot — so every session doubles as a hit-rate measurement.
 */
async function askLogged(source, params) {
  transcript?.log('ask', {
    source,
    question: params.question,
    intent: params.intent ?? 'what_is_this_screen',
    screen: params.frame.screen.key,
  });
  const t0 = Date.now();
  const res = await brain.ask(params);
  transcript?.log('answer', {
    source,
    via: res.via,
    dispatchMs: Date.now() - t0,
    text: res.speak,
    cache: brain.cache.report(),
  });
  return res;
}

// -------------------------------------------------------------------- boot

app.whenReady().then(async () => {
  // Accessory activation: no dock icon and — critically — launching Tony does
  // not make Electron the active app. The observer skips ticks where Tony is
  // frontmost (so he can't blind himself), which meant a normal launch left
  // observer.latest null until the learner clicked another app; measured live
  // as 78s of blindness in the 00:32 session transcript. focusable:false on
  // the window was tried first and does NOT fix this (the app still activates)
  // while it also broke the Anam renderer connection.
  if (process.platform === 'darwin') {
    app.setActivationPolicy('accessory');
    app.dock?.hide();
  }
  createWindow();

  const perms = await checkPermissions();
  send('permissions', perms);

  transcript = new Transcript();

  brain = new Brain({
    fireworksKey: process.env.FIREWORKS_API_KEY,
    anamKey: process.env.ANAM_API_KEY,
    transcript,
    personaConfig: {
      name: 'Tony',
      avatarId: process.env.ANAM_AVATAR_ID,
      avatarModel: process.env.ANAM_AVATAR_MODEL || 'cara-4',
      voiceId: process.env.ANAM_VOICE_ID,
    },
  });

  transcript.log('session-start', {
    session: brain.session.id,
    mode: brain.session.mode,
    accountKind: brain.session.accountKind,
    slowModel: SLOW_MODEL,
    fastModel: FAST_MODEL,
    accessibility: perms.accessibility,
  });
  console.log(`[transcript] ${transcript.file}`);

  pointer = new Pointer();
  driver = new Driver();
  grounder = new Grounder(screen.getPrimaryDisplay().size);
  console.log(`[vision] grounding ${grounder.enabled() ? 'ENABLED (claude-opus-4-8)' : 'disabled — set ANTHROPIC_API_KEY in .env'}`);
  observer = new Observer({ intervalMs: Number(process.env.TICK_MS) || 1500 });

  // Screen change is the strongest precompute signal: the learner just landed
  // somewhere new and has not asked anything yet. That gap is our budget.
  observer.on('screen-changed', (frame) => {
    transcript.log('screen', {
      key: frame.screen.key,
      service: frame.screen.service,
      page: frame.screen.page,
      aws: frame.screen.aws,
      nodes: frame.tree ? frame.tree.length : 0,
      // Distinguishes "ax-dump hit a budget" from "the page genuinely does not
      // expose this subtree" — e.g. the SG table gave 147 untruncated nodes
      // with zero table rows because MAX_DEPTH clipped it (measured live).
      truncated: !!frame.truncated,
      depthClipped: !!frame.depthClipped,
    });
    send('screen', frame.screen);
    send('state', { state: 'observing' });
    pointer.clear();                 // new screen: any prior ring is stale
    brain.warm(frame);
  });

  observer.on('state-changed', (frame) => {
    brain.warm(frame);
  });

  // Idle on one screen matches the persona's stuck-detection window.
  observer.on('idle', async (frame) => {
    if (brain.session.interventionsRemaining <= 0) return;
    const concern = frame.signals.find((s) => !brain.session.triggersFired.includes(s));
    if (!concern) return;

    const res = await askLogged('intervention', { frame, question: 'learner appears stuck', intent: 'primary_concern' });
    brain.markTriggerFired(concern);
    brain.session.interventionsRemaining -= 1;
    dispatchSpeech(res, { proactive: true, frame });
  });

  // Off-console: Tony goes quiet. Persona rule, and it halves the capture surface.
  observer.on('left-console', () => {
    transcript.log('left-console');
    // 'paused' not 'idle': the session is alive, Tony just followed you off
    // the console. 'Dormant' next to a streaming avatar read as broken.
    send('state', { state: 'paused' });
  });

  observer.on('web-content-missing', () => {
    // The AXManualAccessibility wake did not take — usually Chrome's own a11y
    // was turned off. This is the documented manual fallback.
    send('notice', {
      text: "I can see the browser but not the page. Open chrome://accessibility, "
        + "tick 'Web accessibility', reload the console, and I'll see it.",
    });
  });

  observer.on('observer-error', (e) => {
    transcript.log('observer-error', { message: e.message, fatal: !!e.fatal, consecutive: e.consecutive });
    send('observer-error', e);
  });
  observer.start();

  // Push-to-talk. Always-on mic while someone works for hours is both a privacy
  // problem and a cost one, so the hotkey is the primary input.
  // ⌘⇧Space collides with Spotlight; ^⌥Space is unclaimed on default macOS.
  // registerOk reports whether the OS actually granted the shortcut so a future
  // collision surfaces instead of failing silently.
  const ASK_HOTKEY = process.env.TONY_ASK_HOTKEY || 'Control+Alt+Space';
  const askOk = globalShortcut.register(ASK_HOTKEY, async () => {
    const frame = observer.latest;
    if (!frame || !frame.screen.aws) return;
    send('state', { state: 'thinking' });
    const res = await askLogged('hotkey', { frame, question: 'what am I looking at' });
    dispatchSpeech(res, { frame });
  });
  if (!askOk) console.error(`[hotkey] failed to register ${ASK_HOTKEY} — already taken?`);
  send('hotkey', { ask: ASK_HOTKEY });
});

/**
 * Hands speech to the renderer, which owns the Anam client.
 *   via 'cache'  -> talk() the complete string          (~270ms)
 *   via 'bridge' -> talk() the bridge, then stream      (~270ms, then substance)
 */
function dispatchSpeech(res, opts = {}) {
  transcript?.log('speak', { text: res.speak, via: res.via, proactive: !!opts.proactive });
  send('speak', { text: res.speak, via: res.via, proactive: !!opts.proactive });

  // A point action rides alongside speech: Tony says "click this" and the ring
  // appears on the element he means. Cache hits carry the action immediately;
  // bridge answers carry it on the follow-up (the slow brain's JSON).
  const askFrame = opts.frame ?? observer.latest;
  if (res.action) ringFromAction(res.action, askFrame);

  if (res.followUp) {
    const t0 = Date.now();
    res.followUp.then((fu) => {
      // The follow-up is the substance behind the bridge; its latency is the
      // real wait the learner experienced, so it belongs in the transcript.
      transcript?.log('followup', { tookMs: Date.now() - t0, text: fu?.text ?? null, failed: fu === null });
      if (fu?.text) send('speak-followup', { text: fu.text });
      else send('state', { state: 'observing' });
      if (fu?.action) ringFromAction(fu.action, askFrame);
    });
  }
}

/**
 * Sanitize, resolve, and draw a point action. Anything mutating was already
 * demoted to a point by sanitizeAction on non-sandbox accounts, so the overlay
 * is the only actuation that ever reaches the screen in scope A.
 *
 * Element ids are per-capture, so resolution runs against the frame the brain
 * actually saw; if the tree has re-ticked since (follow-ups arrive 5-20s after
 * the ask), fall back to the live frame before declaring NO RING.
 */
function ringFromAction(rawAction, askFrame) {
  // AWS-only, enforced in code: Tony's ring and hands exist for the console
  // and nothing else. The prompt says the same thing; that is the seatbelt,
  // this is the wall. (Measured live: pre-gate Tony scrolled an X feed on
  // request.)
  const scopeFrame = askFrame ?? observer.latest;
  if (!scopeFrame?.screen?.aws) {
    transcript?.log('scope-refused', { action: rawAction?.type, screen: scopeFrame?.screen?.key ?? 'none' });
    console.log(`[scope] refused ${rawAction?.type} on non-AWS screen ${scopeFrame?.screen?.key ?? 'none'}`);
    // Feed the refusal into the drive-feedback loop, or Tony narrates an
    // action the wall silently blocked (measured live: "clicking it now"
    // over a scope-refused). Next turn he explains instead of gaslighting.
    brain.session.lastDrive = {
      type: rawAction?.type ?? 'unknown', label: '', ok: false, deadman: false,
      error: 'blocked: not the AWS console — Tony only acts on AWS',
      screenKey: scopeFrame?.screen?.key ?? 'none',
      treeNodes: (scopeFrame?.tree || []).length, at: Date.now(),
    };
    return;
  }
  const action = brain.sanitizeAction(rawAction);
  // PRIMARY targeting path: Claude vision grounds the action's natural-language
  // target on a live screenshot. The AX-tree lookup below only runs when no
  // Anthropic key is configured or the brain omitted a target description.
  if (grounder?.enabled() && action.target && ['point', 'click', 'type', 'scroll'].includes(action.type)) {
    visionActuate(action).catch((e) => {
      console.error(`[vision] ${e.message}`);
      transcript?.log('vision-ground', { target: action.target, ok: false, error: e.message.slice(0, 200) });
      brain.session.lastDrive = {
        type: action.type, label: action.target, ok: false, deadman: false,
        error: `vision grounding failed: ${e.message.slice(0, 120)}`,
        screenKey: observer.latest?.screen?.key ?? 'none',
        treeNodes: (observer.latest?.tree || []).length, at: Date.now(),
      };
      send('state', { state: 'observing' });
    });
    return;
  }
  // Mutating actions survive sanitizeAction ONLY on sandbox accounts — on
  // own_account they arrive here already demoted to a point. This is scope B:
  // Tony actually takes the wheel.
  if (['click', 'type', 'scroll'].includes(action.type)) {
    driveAction(action, askFrame ?? observer.latest)
      .catch((e) => console.error(`[drive] ${e.message}`));
    return;
  }
  if (action.type !== 'point') {
    if (action.type !== 'none') console.log(`[pointer] action was ${action.type}, not point — no ring`);
    return;
  }
  const frame = askFrame ?? observer.latest;
  if (!frame) return;
  const p = brain.resolvePoint(action, frame)
    || (observer.latest && observer.latest !== frame ? brain.resolvePoint(action, observer.latest) : null);
  if (p) {
    console.log(`[pointer] ring -> ${action.element_id} @ [${p.bounds}] "${p.label}"`);
    transcript?.log('pointer', { ring: true, element: action.element_id, label: p.label });
    brain.session.lastPointed = { element_id: action.element_id, label: p.label };
    pointer.point(p);
  } else {
    // The brain named an element that is not in the tree. This is the most
    // likely real-console failure mode. Log it loudly.
    const ids = (frame.tree || []).map((n) => n.id).slice(0, 8).join(',');
    console.warn(`[pointer] NO RING: element ${action.element_id} not in tree `
      + `(${frame.tree ? frame.tree.length : 0} nodes: ${ids}...)`);
    transcript?.log('pointer', { ring: false, element: action.element_id, treeNodes: frame.tree ? frame.tree.length : 0 });
  }
}

/**
 * SCOPE B — Tony drives. Runs one gesture against the element the brain chose:
 * ring the target (intent made visible), take the wheel (orange chrome), then
 * synthesize the input. The deadman is layered: the helper's own event tap
 * kills the gesture on any real human input (exit 2), and abortDriving()
 * SIGKILLs it from this side for inputs the tap can't attribute.
 */
async function driveAction(action, frame) {
  if (!frame) return;
  if (driver.busy) {
    transcript?.log('drive', { type: action.type, element: action.element_id, ok: false, error: 'gesture already in flight' });
    return;
  }
  const el = (frame.tree || []).find((n) => n.id === action.element_id);
  if (!el || !Array.isArray(el.bounds) || el.bounds.length !== 4) {
    // Same failure mode as NO RING: per-capture element ids went stale.
    console.warn(`[drive] no target: ${action.element_id} not in tree`);
    transcript?.log('drive', { type: action.type, element: action.element_id, ok: false, error: 'element not in tree' });
    return;
  }

  // Re-resolve against the LIVE tree before touching anything. The ask-time
  // frame can be 5-20s old by the time the slow brain answers; menus close and
  // layouts shift, and a click at stale coordinates lands on whatever moved in
  // underneath (measured live: a menu-item click hit dead space after the menu
  // closed). Ids renumber per capture, so match by role+label.
  let target = el;
  const live = observer.latest;
  if (live && live !== frame) {
    const label = el.label || '';
    const center = (n) => [n.bounds[0] + n.bounds[2] / 2, n.bounds[1] + n.bounds[3] / 2];
    const [ex, ey] = center(el);
    const cands = (live.tree || [])
      .filter((n) => n.role === el.role && (n.label || '') === label
        && Array.isArray(n.bounds) && n.bounds.length === 4)
      .map((n) => { const [nx, ny] = center(n); return { n, d: Math.hypot(nx - ex, ny - ey) }; })
      .sort((a, b) => a.d - b.d);

    if (label && cands.length) {
      target = cands[0].n;   // labeled: trust the label; nearest match wins ties
    } else if (label) {
      // The element Tony promised to click no longer exists on screen. A blind
      // click at old coordinates can hit the wrong control — skip instead.
      console.warn(`[drive] STALE TARGET: "${label}" (${el.role}) gone from live tree — skipping`);
      transcript?.log('drive', { type: action.type, element: action.element_id, label, ok: false, error: 'target gone from live tree' });
      send('state', { state: 'observing' });
      return;
    } else if (cands.length && cands[0].d <= 60) {
      // Anonymous node: a label match is meaningless — every unlabeled sibling
      // "matches" (measured live: two different picker rows both re-resolved to
      // the same wrong node and Tony clicked dead space three times). Accept
      // only a same-role node in nearly the same place; otherwise keep the
      // ask-time bounds, which are where the brain actually saw the thing.
      target = cands[0].n;
    }
  }
  const [x, y, w, h] = target.bounds;
  const cx = x + w / 2;
  const cy = y + h / 2;

  driving = true;
  send('state', { state: 'driving' });
  pointer.point({ bounds: target.bounds, label: (target.label || '').slice(0, 40) || action.type });
  brain.session.lastPointed = { element_id: action.element_id, label: target.label || '' };
  transcript?.log('drive', {
    type: action.type, element: action.element_id, label: target.label,
    x: cx, y: cy, reresolved: target !== el,
    ...(action.text ? { text: String(action.text).slice(0, 120) } : {}),
    ...(action.direction ? { direction: action.direction } : {}),
  });
  console.log(`[drive] ${action.type} -> ${action.element_id} @ ${cx},${cy} "${target.label || ''}"`);

  let res;
  if (action.type === 'scroll') {
    res = await driver.drive({ kind: 'scroll', x: cx, y: cy, direction: action.direction || 'down' });
  } else {
    // 'type' targets a field: click it first so the keystrokes land in it.
    res = await driver.drive({ kind: 'click', x: cx, y: cy });
    if (res.ok && action.type === 'type' && action.text) {
      res = await driver.drive({ kind: 'type', text: String(action.text).slice(0, 500) });
    }
  }

  transcript?.log('drive-done', { type: action.type, ok: res.ok, deadman: !!res.deadman, ...(res.error ? { error: res.error } : {}) });

  // Feed the result back to the brain: what was attempted, whether the gesture
  // completed, and the tree size at drive time — buildSuffix compares against
  // the current tree so the model can tell "click took" from "nothing changed"
  // instead of narrating the same click three times (measured live).
  brain.session.lastDrive = {
    type: action.type,
    label: target.label || '',
    ok: res.ok,
    deadman: !!res.deadman,
    error: res.error || null,
    screenKey: frame.screen.key,
    treeNodes: (frame.tree || []).length,
    at: Date.now(),
  };

  if (res.deadman) {
    abortDriving('learner input');   // scripted beat: "You moved, I stopped."
  } else {
    driving = false;
    pointer.clear();
    send('state', { state: 'observing' });
    if (res.error) console.error(`[drive] failed: ${res.error}`);
  }
}

/**
 * Vision-grounded actuation — the computer-use path. Claude locates the
 * target on a live screenshot (coordinates come back in logical screen
 * pixels, 1:1 with CGEvent coords); the ring shows what was found; drive.swift
 * performs the gesture with the deadman armed. Every step transcript-logged.
 */
async function visionActuate(action) {
  if (driver.busy) {
    transcript?.log('drive', { type: action.type, label: action.target, ok: false, error: 'gesture already in flight' });
    return;
  }
  const t0 = Date.now();
  const g = await grounder.ground(action.target);
  transcript?.log('vision-ground', {
    target: action.target, found: g.found, label: g.label,
    x: g.x, y: g.y, w: g.width, h: g.height,
    tookMs: Date.now() - t0, tokens: g.usage,
  });

  if (!g.found) {
    console.warn(`[vision] not found on screen: "${action.target}"`);
    brain.session.lastDrive = {
      type: action.type, label: action.target, ok: false, deadman: false,
      error: 'vision: target not visible on the current screen',
      screenKey: observer.latest?.screen?.key ?? 'none',
      treeNodes: (observer.latest?.tree || []).length, at: Date.now(),
    };
    send('state', { state: 'observing' });
    return;
  }

  const bounds = [g.x - g.width / 2, g.y - g.height / 2, g.width, g.height];
  pointer.point({ bounds, label: (g.label || action.target).slice(0, 40) });
  brain.session.lastPointed = { element_id: action.element_id ?? null, label: g.label || action.target };
  console.log(`[vision] ${action.type} -> "${action.target}" @ ${g.x},${g.y} (${Date.now() - t0}ms)`);

  if (action.type === 'point') return;   // ring only; the learner clicks

  driving = true;
  send('state', { state: 'driving' });
  transcript?.log('drive', {
    type: action.type, label: g.label || action.target, x: g.x, y: g.y, via: 'vision',
    ...(action.text ? { text: String(action.text).slice(0, 120) } : {}),
    ...(action.direction ? { direction: action.direction } : {}),
  });

  let res;
  if (action.type === 'scroll') {
    res = await driver.drive({ kind: 'scroll', x: g.x, y: g.y, direction: action.direction || 'down' });
  } else {
    res = await driver.drive({ kind: 'click', x: g.x, y: g.y });
    if (res.ok && action.type === 'type' && action.text) {
      res = await driver.drive({ kind: 'type', text: String(action.text).slice(0, 500) });
    }
  }

  transcript?.log('drive-done', { type: action.type, via: 'vision', ok: res.ok, deadman: !!res.deadman, ...(res.error ? { error: res.error } : {}) });
  brain.session.lastDrive = {
    type: action.type, label: g.label || action.target, ok: res.ok, deadman: !!res.deadman,
    error: res.error || null,
    screenKey: observer.latest?.screen?.key ?? 'none',
    treeNodes: (observer.latest?.tree || []).length, at: Date.now(),
  };

  if (res.deadman) {
    abortDriving('learner input');
  } else {
    driving = false;
    pointer.clear();
    send('state', { state: 'observing' });
    if (res.error) console.error(`[vision-drive] failed: ${res.error}`);
  }
}

// --------------------------------------------------------------------- IPC

ipcMain.handle('session-token', async () => {
  // The renderer never sees ANAM_API_KEY — only a short-lived session token.
  // Logged both ways: a session with no token-mint event means the renderer
  // never even asked (bundle/preload dead), which looks identical to an Anam
  // outage from the outside.
  try {
    const token = await brain.mintSessionToken();
    transcript?.log('token-mint', { ok: true });
    return { ok: true, token };
  } catch (err) {
    transcript?.log('token-mint', { ok: false, error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('set-mode', (_e, mode) => {
  if (['just_fix_it', 'walk_through', 'earn_it'].includes(mode)) brain.session.mode = mode;
  return brain.session.mode;
});

ipcMain.handle('set-account-kind', (_e, kind) => {
  if (['sandbox', 'own_account'].includes(kind)) brain.session.accountKind = kind;
  return brain.session.accountKind;
});

ipcMain.handle('cache-report', () => brain.cache.report());

ipcMain.on('learner-input', () => abortDriving('learner input'));

// The learner spoke. Answer as Tony, with whatever console screen is current.
// This is the spoken counterpart of the hotkey path: same brain, same context,
// input arrives as transcribed voice instead of a keypress.
ipcMain.on('heard', async (_e, text) => {
  // No frame yet (just launched, or only Tony's own window has been frontmost)
  // must not mean the learner gets ignored: answer against an explicit
  // no-screen frame instead. The ask event logs screen 'off:unknown' so blind
  // answers stay visible in the transcript.
  const frame = observer.latest ?? {
    screen: { app: 'unknown', aws: false, service: null, page: null, key: 'off:unknown' },
    signals: [], tree: [], windowTitle: '', documentUrl: '', at: Date.now(),
  };
  // Off-console questions still deserve an answer; the brain handles the
  // 'not AWS' case by talking generally rather than teaching a screen.
  const res = await askLogged('voice', {
    frame,
    question: text,
    intent: 'learner_question',
  });
  dispatchSpeech(res, { frame });
});

// Renderer-side Anam lifecycle events, forwarded so the transcript shows
// connection context around a dead exchange (e.g. token expiry mid-question).
const ANAM_NOTES = ['session-ready', 'connection-closed', 'reconnecting', 'talk-interrupted', 'audio-started', 'connect-timeout'];
ipcMain.on('transcript-note', (_e, event) => {
  if (ANAM_NOTES.includes(event)) transcript?.log('anam', { event });
});

ipcMain.on('open-accessibility-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

app.on('will-quit', () => {
  transcript?.log('session-end', { cache: brain ? brain.cache.report() : null });
  globalShortcut.unregisterAll();
});
app.on('window-all-closed', () => app.quit());
