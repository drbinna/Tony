'use strict';
/** Forward an upstream fetch Response to the Vercel res, streaming the body
 *  so SSE/streamed completions pass through without buffering. */
const { Readable } = require('stream');

async function pipe(up, res) {
  res.status(up.status);
  const ct = up.headers.get('content-type');
  if (ct) res.setHeader('content-type', ct);
  if (!up.body) return res.end();
  Readable.fromWeb(up.body).pipe(res);
}

module.exports = { pipe };
