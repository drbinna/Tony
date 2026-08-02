'use strict';
/** Unauthenticated liveness probe (never reveals configuration). */
module.exports = (_req, res) => {
  res.status(200).json({ ok: true, service: 'tony-proxy' });
};
