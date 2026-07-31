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
   * Flash a highlight outline on an element so the learner's eye lands on it.
   * In-page (scrolls with content) — replaces the OS-level pointer ring.
   */
  async highlight(target, ms = 6000) {
    const loc = this.locate(target);
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
    await loc.evaluate((el, dur) => {
      const prev = el.style.cssText;
      el.style.outline = '3px solid #FF8A3D';
      el.style.outlineOffset = '2px';
      el.style.borderRadius = '4px';
      setTimeout(() => { el.style.cssText = prev; }, dur);
    }, ms);
  }

  async click(target) {
    const loc = this.locate(target);
    await loc.click({ timeout: 8000 });
  }

  async type(target, text) {
    const loc = this.locate(target);
    await loc.click({ timeout: 8000 });
    await loc.fill(String(text).slice(0, 500), { timeout: 8000 });
  }

  async press(key) {
    await this.page.keyboard.press(key);
  }

  async goto(url) {
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
