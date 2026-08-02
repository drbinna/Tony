'use strict';
/** Access-code check for the first-run setup window. Auth-gated, costs
 *  nothing upstream: 200 means the code works, 401 means it doesn't. */
const { gate } = require('../_lib/auth');

module.exports = (req, res) => {
  if (!gate(req, res)) return;
  res.status(200).json({ ok: true });
};
