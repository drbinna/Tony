'use strict';
/**
 * Access-code auth for the Tony key proxy.
 *
 * ACCESS_CODES is a comma-separated list in the Vercel env. Rotating or
 * revoking a code is: edit the env var, redeploy. When Tony grows real
 * accounts this file is the seam where a user table replaces the list.
 *
 * The code arrives either as `Authorization: Bearer <code>` (our own callers)
 * or as `x-api-key: <code>` (the Anthropic SDK's header) — accept both so the
 * app can hand the SDK its access code as if it were an API key.
 */

function codes() {
  return (process.env.ACCESS_CODES || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function tokenOf(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return (req.headers['x-api-key'] || '').trim() || null;
}

function authed(req) {
  const t = tokenOf(req);
  return !!t && codes().includes(t);
}

/** 405/401 boilerplate. Returns true if the request may proceed. */
function gate(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return false;
  }
  if (!authed(req)) {
    res.status(401).json({ error: 'invalid or missing access code' });
    return false;
  }
  return true;
}

module.exports = { gate };
