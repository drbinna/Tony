'use strict';
/**
 * Runtime configuration — the one seam between a dev checkout and a
 * distributed build.
 *
 * Credentials resolve in this order:
 *   1. proxy mode — an ACCESS CODE, from userData/config.json (written by the
 *      first-run setup window) or TONY_ACCESS_CODE in the env. All three
 *      upstreams (Fireworks brain + vision, Anam avatar) route through the
 *      hosted key proxy; a distributed build holds no real keys.
 *   2. local mode — raw API keys in .env: the dev workflow, unchanged.
 *
 * Avatar identity is configuration, not secret: the defaults are baked so a
 * packaged app works with nothing but an access code.
 */

const fs = require('fs');
const path = require('path');

// The deployed tony-proxy URL. TONY_PROXY_URL overrides for staging/dev.
const DEFAULT_PROXY_URL = 'https://tony-proxy.vercel.app';

// Baked-in shared beta code so the app is download-and-run: no setup screen,
// no per-user codes. This is a SOFT gate, not a secret — it ships inside every
// copy and is extractable. Its only job is to keep the proxy from being a
// wide-open LLM/avatar endpoint that abuse bots find and get our upstream
// accounts banned over. The real API keys never leave the Vercel proxy. To
// rotate: change ACCESS_CODES on the proxy, change this constant, ship an
// update. To hand someone their own revocable code instead, set
// TONY_ACCESS_CODE or drop one in config.json — those take precedence.
const PUBLIC_ACCESS_CODE = 'tony-beta-637acc5d2296';

const AVATAR_DEFAULTS = {
  name: 'Tony',
  avatarId: '6cc28442-cccd-42a8-b6e4-24b7210a09c5',
  avatarModel: 'cara-4',
  voiceId: '91b4ce0f-4fc0-11f1-84b0-52bacf74fa75',
};

function configFile(userDataPath) {
  return path.join(userDataPath, 'config.json');
}

function readUserConfig(userDataPath) {
  try {
    return JSON.parse(fs.readFileSync(configFile(userDataPath), 'utf8'));
  } catch {
    return {};
  }
}

function writeUserConfig(userDataPath, patch) {
  const merged = { ...readUserConfig(userDataPath), ...patch };
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(configFile(userDataPath), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return merged;
}

function proxyUrl(userConfig = {}) {
  return (process.env.TONY_PROXY_URL || userConfig.proxyUrl || DEFAULT_PROXY_URL).replace(/\/+$/, '');
}

/**
 * @returns {{
 *   mode: 'proxy'|'local'|'none', configured: boolean,
 *   fireworksUrl?: string, fireworksBearer?: string,
 *   anamTokenUrl?: string, anamBearer?: string,
 *   vision?: { baseURL: string, apiKey: string, provider: string } | null,
 * }}
 */
function resolveCreds(userDataPath) {
  const user = userDataPath ? readUserConfig(userDataPath) : {};

  // 1. An explicit code (env or a config.json a user was handed) wins — the
  //    revocable, per-person path.
  const explicit = process.env.TONY_ACCESS_CODE || user.accessCode || null;
  if (explicit) return proxyCreds(explicit, user);

  // 2. A dev checkout with real keys in .env stays in local mode, untouched.
  if (process.env.FIREWORKS_API_KEY && process.env.ANAM_API_KEY) {
    return {
      mode: 'local',
      configured: true,
      fireworksUrl: null,     // Brain falls back to the real endpoints
      fireworksBearer: process.env.FIREWORKS_API_KEY,
      anamTokenUrl: null,
      anamBearer: process.env.ANAM_API_KEY,
    };
  }

  // 3. Everyone else — a plain download with no config — rides the baked-in
  //    shared code. No setup screen; the app just works.
  return proxyCreds(PUBLIC_ACCESS_CODE, user);
}

function proxyCreds(accessCode, user) {
  const base = proxyUrl(user);
  return {
    mode: 'proxy',
    configured: true,
    fireworksUrl: `${base}/api/chat`,
    fireworksBearer: accessCode,
    anamTokenUrl: `${base}/api/anam-token`,
    anamBearer: accessCode,
  };
}

/** Ask the proxy whether an access code is valid (no tokens spent). */
async function validateAccessCode(code, userConfig = {}) {
  const res = await fetch(`${proxyUrl(userConfig)}/api/validate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${code}` },
  });
  return res.ok;
}

/** Writable data locations. A packaged app must not write inside its own
 *  bundle (read-only asar); a dev checkout keeps the familiar repo folders. */
function dataDirs({ isPackaged, userDataPath }) {
  if (!isPackaged) return { transcripts: null, artifacts: null };   // module defaults
  return {
    transcripts: path.join(userDataPath, 'transcripts'),
    artifacts: path.join(userDataPath, 'lesson-artifacts',
      new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')),
  };
}

module.exports = { AVATAR_DEFAULTS, resolveCreds, validateAccessCode, readUserConfig, writeUserConfig, dataDirs };
