'use strict';
/**
 * Pointer — guided pointing without touching the mouse.
 *
 * WHY AN OVERLAY, NOT A SYNTHESIZED CURSOR:
 * Scope A (guided pointing) is the highest teaching value at the lowest risk:
 * deixis — "click THIS" made literal — is half of tutoring. Moving the real OS
 * cursor would need a native module (robotjs is pre-1.0, abandoned-ish, and its
 * own tracker is full of macOS cursor no-ops) AND it could land in the wrong
 * place. A highlight drawn at the element's own AX bounds CANNOT misclick,
 * because it never clicks. It also needs no new permission: the AX tree we
 * already read supplies element bounds directly.
 *
 * Full actuation (click/type/scroll) is scope B and stays gated to sandbox
 * accounts. When it is built it will use macOS CGEvent, not robotjs.
 *
 * This window is transparent, click-through, and covers the full display. Tony
 * draws a ring at [x,y,w,h] and the learner's own cursor does the clicking.
 */
const { BrowserWindow, screen } = require('electron');
const path = require('path');

class Pointer {
  constructor() {
    this.win = null;
  }

  ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;

    const { bounds } = screen.getPrimaryDisplay();
    this.win = new BrowserWindow({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,          // never steals focus from the console
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });

    // The overlay must never intercept a click. Everything passes through to the
    // console beneath it; the learner interacts with AWS, not with Tony's ring.
    this.win.setIgnoreMouseEvents(true);
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.loadFile(path.join(__dirname, 'pointer.html'));
    return this.win;
  }

  /**
   * Highlight an element. bounds are the AX [x, y, w, h] in screen coordinates,
   * which is exactly what ax-dump already emits per node — no translation.
   * @param {{bounds:number[], label?:string, mode?:string}} target
   */
  point(target) {
    const w = this.ensure();
    const send = () => w.webContents.send('point', target);
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
    else send();
    w.showInactive();            // visible but never focused
  }

  clear() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('clear');
      this.win.hide();
    }
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { Pointer };
