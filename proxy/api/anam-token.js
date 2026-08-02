'use strict';
/** Mint a short-lived Anam session token. The client sends its personaConfig;
 *  llmId is FORCED to CUSTOMER_CLIENT_V1 server-side so a modified client can
 *  never turn on Anam's built-in brain against our account. */
const { gate } = require('../_lib/auth');

const UPSTREAM = 'https://api.anam.ai/v1/auth/session-token';

module.exports = async (req, res) => {
  if (!gate(req, res)) return;
  const personaConfig = { ...(req.body?.personaConfig || {}), llmId: 'CUSTOMER_CLIENT_V1' };
  const up = await fetch(UPSTREAM, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.ANAM_API_KEY}`,
    },
    body: JSON.stringify({ personaConfig }),
  });
  const text = await up.text();
  res.status(up.status);
  res.setHeader('content-type', up.headers.get('content-type') || 'application/json');
  res.send(text);
};
