'use strict';
/** Fireworks chat-completions passthrough. The app sends the exact Fireworks
 *  payload (model, messages, stream, ...); only the credential is swapped. */
const { gate } = require('../_lib/auth');
const { pipe } = require('../_lib/pipe');

const UPSTREAM = 'https://api.fireworks.ai/inference/v1/chat/completions';

module.exports = async (req, res) => {
  if (!gate(req, res)) return;
  const up = await fetch(UPSTREAM, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}`,
    },
    body: JSON.stringify(req.body),
  });
  await pipe(up, res);
};
