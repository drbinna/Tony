'use strict';
/**
 * Driver — spawns the CGEvent synthesis helper (observer/drive.swift).
 *
 * SCOPE B. Every call that reaches here has already passed sanitizeAction's
 * sandbox gate in the main process; this module only manages the process.
 *
 * The helper carries its own deadman (an event tap that exits 2 on any real
 * human input), so aborting from here is belt-and-braces for the cases the
 * tap can't see — a renderer click on Tony's own chrome, or a main-process
 * decision to stop.
 */
const { execFile } = require('child_process');
const path = require('path');

const HELPER = path.join(__dirname, '..', 'observer', 'drive');

class Driver {
  constructor() {
    this.proc = null;
  }

  /** True while a gesture is in flight. */
  get busy() {
    return this.proc !== null;
  }

  /**
   * Run one gesture to completion.
   * @param {{kind:'click'|'type'|'scroll', x?:number, y?:number, text?:string, direction?:string}} cmd
   * @returns {Promise<{ok:boolean, deadman?:boolean, error?:string}>}
   */
  drive(cmd) {
    if (this.proc) return Promise.resolve({ ok: false, error: 'gesture already in flight' });
    return new Promise((resolve) => {
      this.proc = execFile(HELPER, [JSON.stringify(cmd)], { timeout: 20000 }, (err) => {
        this.proc = null;
        if (!err) return resolve({ ok: true });
        // exit 2 is the deadman: the learner's own input won the wheel.
        if (err.code === 2) return resolve({ ok: false, deadman: true });
        // exit 3: the helper verified the cursor never arrived — the OS is
        // silently discarding our synthesis. Surface it as a hard failure.
        if (err.code === 3) return resolve({ ok: false, error: 'delivery blocked: cursor did not move (macOS is discarding synthesized input for this process)' });
        resolve({
          ok: false,
          error: err.code === 'ENOENT' ? 'drive helper not built — run observer/build.sh' : err.message,
        });
      });
    });
  }

  /** Kill an in-flight gesture immediately (deadman from our side). */
  abort() {
    if (this.proc) this.proc.kill('SIGKILL');
  }
}

module.exports = { Driver };
