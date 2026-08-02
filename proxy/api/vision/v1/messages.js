'use strict';
/** Anthropic-Messages-compatible passthrough to OpenRouter, for vision
 *  grounding. The app points the Anthropic SDK at <proxy>/api/vision as its
 *  baseURL with the access code as the "api key"; the SDK then POSTs here
 *  (baseURL + /v1/messages) and we swap in the real OpenRouter credential. */
const { gate } = require('../../../_lib/auth');
const { pipe } = require('../../../_lib/pipe');

const UPSTREAM = 'https://openrouter.ai/api/v1/messages';

module.exports = async (req, res) => {
  if (!gate(req, res)) return;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
  };
  // The SDK versions its wire format; forward that faithfully.
  if (req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version'];
  const up = await fetch(UPSTREAM, {
    method: 'POST',
    headers,
    body: JSON.stringify(req.body),
  });
  await pipe(up, res);
};
