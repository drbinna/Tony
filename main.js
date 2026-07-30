'use strict';
require('dotenv').config();

const { app, BrowserWindow, ipcMain, screen, globalShortcut, systemPreferences, shell } = require('electron');
const path = require('path');
const { Observer } = require('./observer/observer');
const { Brain } = require('./brain/server');

const WIDTH = 320;
const HEIGHT = 440;

let win = null;
let observer = null;
let brain = null;

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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // float above fullscreen apps — the learner will be fullscreen in the console
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // A renderer that fails to load is invisible from the outside: the card shows
  // its hardcoded HTML defaults, buttons are dead, and nothing logs. Surface it.
  win.webContents.on('console-message', (_e, level, message, line, source) => {
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

function abortDriving(reason) {
  if (!driving) return;
  driving = false;
  send('state', { state: 'observing' });
  send('deadman-abort', { reason });
}

// -------------------------------------------------------------------- boot

app.whenReady().then(async () => {
  createWindow();

  const perms = await checkPermissions();
  send('permissions', perms);

  brain = new Brain({
    fireworksKey: process.env.FIREWORKS_API_KEY,
    anamKey: process.env.ANAM_API_KEY,
    personaConfig: {
      name: 'Tony',
      avatarId: process.env.ANAM_AVATAR_ID,
      avatarModel: process.env.ANAM_AVATAR_MODEL || 'cara-4',
      voiceId: process.env.ANAM_VOICE_ID,
    },
  });

  observer = new Observer({ intervalMs: Number(process.env.TICK_MS) || 1500 });

  // Screen change is the strongest precompute signal: the learner just landed
  // somewhere new and has not asked anything yet. That gap is our budget.
  observer.on('screen-changed', (frame) => {
    send('screen', frame.screen);
    send('state', { state: 'observing' });
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

    const res = await brain.ask({ frame, question: 'learner appears stuck', intent: 'primary_concern' });
    brain.markTriggerFired(concern);
    brain.session.interventionsRemaining -= 1;
    dispatchSpeech(res, { proactive: true });
  });

  // Off-console: Tony goes quiet. Persona rule, and it halves the capture surface.
  observer.on('left-console', () => {
    // 'paused' not 'idle': the session is alive, Tony just followed you off
    // the console. 'Dormant' next to a streaming avatar read as broken.
    send('state', { state: 'paused' });
  });

  observer.on('observer-error', (e) => send('observer-error', e));
  observer.start();

  // Push-to-talk. Always-on mic while someone works for hours is both a privacy
  // problem and a cost one, so the hotkey is the primary input.
  globalShortcut.register('CommandOrControl+Shift+Space', async () => {
    const frame = observer.latest;
    if (!frame || !frame.screen.aws) return;
    send('state', { state: 'thinking' });
    const res = await brain.ask({ frame, question: 'what am I looking at' });
    dispatchSpeech(res);
  });
});

/**
 * Hands speech to the renderer, which owns the Anam client.
 *   via 'cache'  -> talk() the complete string          (~270ms)
 *   via 'bridge' -> talk() the bridge, then stream      (~270ms, then substance)
 */
function dispatchSpeech(res, opts = {}) {
  send('speak', { text: res.speak, via: res.via, proactive: !!opts.proactive });

  if (res.followUp) {
    res.followUp.then((text) => {
      if (text) send('speak-followup', { text });
      else send('state', { state: 'observing' });
    });
  }
}

// --------------------------------------------------------------------- IPC

ipcMain.handle('session-token', async () => {
  // The renderer never sees ANAM_API_KEY — only a short-lived session token.
  try {
    return { ok: true, token: await brain.mintSessionToken() };
  } catch (err) {
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

ipcMain.on('open-accessibility-settings', () => {
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
