// Background auto-update via electron-updater + the GitHub Releases feed the
// release-dmg workflow publishes (latest-mac.yml + the signed .zip). This is a
// no-op in dev (runs from source, no app-update.yml) and only works in the
// packaged, SIGNED app — macOS/Squirrel refuses an update whose signature it
// can't validate, which is exactly why the Developer ID signing had to land
// first. Fully hands-off: download in the background, install on the next quit.
const { autoUpdater } = require('electron-updater');

function initAutoUpdate({ app, send = () => {}, log = console } = {}) {
  if (!app.isPackaged) return;              // dev has no app-update.yml — skip
  autoUpdater.autoDownload = true;          // fetch the update in the background
  autoUpdater.autoInstallOnAppQuit = true;  // apply on next quit, no interruption

  autoUpdater.on('update-available', (info) => {
    log.log?.(`[update] ${info.version} available — downloading`);
    send('update-status', { state: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => send('update-status', { state: 'current' }));
  autoUpdater.on('download-progress', (p) =>
    send('update-status', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    log.log?.(`[update] ${info.version} downloaded — installs on quit (or call install-update)`);
    send('update-status', { state: 'ready', version: info.version });
  });
  autoUpdater.on('error', (e) => {
    log.warn?.(`[update] ${e?.message || e}`);
    send('update-status', { state: 'error', error: String(e?.message || e) });
  });

  // Let the app settle, then check; re-check every 6h for long-running sessions.
  const check = () =>
    autoUpdater.checkForUpdates().catch((e) => log.warn?.(`[update] check failed: ${e?.message || e}`));
  setTimeout(check, 15_000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

// Force the downloaded update to apply now (for a "Restart to update" button).
// Safe to call even if nothing is downloaded — Squirrel just relaunches.
function installUpdate() {
  autoUpdater.quitAndInstall();
}

module.exports = { initAutoUpdate, installUpdate };
