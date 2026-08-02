'use strict';
/**
 * Pilot — Tony's browser. Playwright (via the installed Google Chrome) owns a
 * dedicated lesson window; Tony perceives it through ARIA snapshots
 * (role/name/state, no images) and acts on elements by role + accessible
 * name. No OS input synthesis, no coordinates, no screen recording: clicks go
 * through CDP into the page, which retires the entire CGEvent/TCC failure
 * class measured on 2026-07-30.
 *
 * The profile persists under userDataDir so the learner's AWS console login
 * survives restarts. The scope wall is physical here: this browser is the
 * lesson surface; Tony never drives any other window.
 */
const path = require('path');
const { chromium } = require('playwright-core');

class Pilot {
  constructor({ userDataDir, headless = false, log = console } = {}) {
    this.userDataDir = userDataDir || path.join(__dirname, '..', '.lesson-profile');
    this.headless = headless;
    this.log = log;
    this.context = null;
    this.page = null;
  }

  async launch(startUrl = 'https://console.aws.amazon.com/') {
    this.context = await chromium.launchPersistentContext(this.userDataDir, {
      channel: 'chrome',
      headless: this.headless,
      viewport: null,
      args: ['--window-size=1280,860', '--window-position=40,40'],
    });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch((e) => this.log.warn?.(`[pilot] initial goto: ${e.message}`));
    // Track the active tab if the console opens new ones.
    this.context.on('page', (p) => { this.page = p; });
    return this;
  }

  alive() {
    return !!(this.page && !this.page.isClosed());
  }

  url() {
    return this.alive() ? this.page.url() : null;
  }

  /** Role/name/state snapshot of the live page. Capped: the console's DOM is
   *  huge and the model needs the shape, not every last node. */
  async snapshot({ maxChars = 14000 } = {}) {
    const snap = await this.page.locator('body').ariaSnapshot({ timeout: 8000 });
    const truncated = snap.length > maxChars;
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ''),
      tree: truncated ? `${snap.slice(0, maxChars)}\n… (truncated)` : snap,
      truncated,
    };
  }

  /** Resolve a target by role + accessible name. `nth` disambiguates dupes. */
  locate({ role, name, nth = 0 }) {
    let loc = this.page.getByRole(role, { name, exact: false });
    return loc.nth(nth);
  }

  /**
   * Persistent highlight on an element so the learner's eye lands on it —
   * and stays landed. Overlay box (survives the console rewriting element
   * styles), rAF-tracked through scrolling, no removal timer: it clears when
   * the next action moves the lesson forward. Returns the element's rect as
   * proof the outline actually landed.
   */
  async highlight(target) {
    const loc = this.locate(target);
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
    return await loc.evaluate((el) => {
      const doc = el.ownerDocument;
      window.__tonyHlClear?.();
      if (!doc.getElementById('tony-hl-style')) {
        const st = doc.createElement('style');
        st.id = 'tony-hl-style';
        st.textContent = '@keyframes tony-hl-pulse {'
          + '0%,100% { box-shadow: 0 0 0 4px rgba(255,138,61,.30), 0 0 22px 6px rgba(255,138,61,.55); }'
          + '50% { box-shadow: 0 0 0 7px rgba(255,138,61,.16), 0 0 30px 10px rgba(255,138,61,.75); }'
          + '}';
        doc.documentElement.appendChild(st);
      }
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
      let live = true;
      window.__tonyHlClear = () => { live = false; box.remove(); };
      const tick = () => {
        if (!live) return;
        if (el.isConnected) {
          const r = el.getBoundingClientRect();
          box.style.display = 'block';
          box.style.left = `${r.left - 5}px`;
          box.style.top = `${r.top - 5}px`;
          box.style.width = `${r.width + 4}px`;
          box.style.height = `${r.height + 4}px`;
        } else {
          box.style.display = 'none';
        }
        requestAnimationFrame(tick);
      };
      tick();
      const r = el.getBoundingClientRect();
      return { rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
    });
  }

  /** Best effort — the overlay also dies with navigation. */
  async clearHighlight() {
    await this.page.evaluate(() => window.__tonyHlClear?.()).catch(() => {});
  }

  async click(target) {
    await this.clearHighlight();
    const loc = this.locate(target);
    await loc.click({ timeout: 8000 });
  }

  async type(target, text) {
    await this.clearHighlight();
    const loc = this.locate(target);
    await loc.click({ timeout: 8000 });
    await loc.fill(String(text).slice(0, 500), { timeout: 8000 });
  }

  async press(key) {
    await this.clearHighlight();
    await this.page.keyboard.press(key);
  }

  async goto(url) {
    await this.clearHighlight();
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  }

  /** Screenshot for canvas widgets ONLY — described aloud, never clicked. */
  async screenshot() {
    return (await this.page.screenshot({ type: 'png' })).toString('base64');
  }

  async close() {
    await this.context?.close().catch(() => {});
    this.context = null;
    this.page = null;
  }
}

module.exports = { Pilot };
