// AnamEvent is exported from the package root. The docs import it from
// '@anam-ai/js-sdk/dist/module/types', which works on esm.sh but throws
// ERR_UNSUPPORTED_DIR_IMPORT under Node/Electron ESM (no exports map, and
// directory imports are unsupported). Verified against @anam-ai/js-sdk 2.5.0.
import { createClient, AnamEvent } from '@anam-ai/js-sdk';

const els = {
  body: document.body,
  label: document.getElementById('label'),
  detail: document.getElementById('detail'),
  speech: document.getElementById('speech'),
  notice: document.getElementById('notice'),
  mic: document.getElementById('mic'),
};

let anam = null;
let activeStream = null;   // in-flight createTalkMessageStream, if any
let reconnectTimer = null;
let connectWatchdog = null;

// Single source of truth for the mic. We create the client with
// disableInputAudio: true, and in that mode the SDK logs "Audio state will not
// be used" and getInputAudioState() returns an isMuted value it explicitly
// disavows -- trusting it painted MIC LIVE while the mic was actually off.
// A consent readout that false-alarms trains people to ignore it. This flag
// flips only if we ever deliberately enable input audio (push-to-talk, later).
let inputAudioEnabled = false;

const LABELS = {
  idle: 'Dormant — not watching',
  paused: 'Paused — off console',
  observing: 'Watching',
  thinking: 'Thinking',
  speaking: 'Speaking',
  driving: 'Driving',
  celebrating: 'Nice',
};

/** The status text is a truthful readout of system state, not decoration.
 *  "Dormant — not watching" must actually mean no capture is happening. */
function setState(state) {
  els.body.dataset.state = state;
  els.label.textContent = LABELS[state] ?? state;
}

function say(text, { bridge = false, append = false } = {}) {
  if (append) {
    els.speech.insertAdjacentText('beforeend', ` ${text}`);
  } else {
    els.speech.innerHTML = '';
    const span = document.createElement('span');
    if (bridge) span.className = 'bridge';
    span.textContent = text;
    els.speech.appendChild(span);
  }
  els.speech.scrollTop = els.speech.scrollHeight;
}

/** Mic state is part of the consent UI, not a detail. If the card says the mic
 *  is off, it has to actually be off -- and vice versa. */
function reportMic() {
  let live = false;
  if (inputAudioEnabled) {
    const st = anam?.getInputAudioState?.();
    live = st ? !st.isMuted : true;   // if enabled and unknown, assume LIVE
  }
  els.mic.textContent = live ? 'MIC LIVE' : 'mic off';
  els.mic.dataset.live = String(live);
}

let netTimer = null;
/** Transient network-quality readout in the detail slot. Congestion is common
 *  on WiFi and self-heals; a persistent modal would cry wolf. */
function showNetworkState(label) {
  els.detail.textContent = label;
  els.detail.dataset.net = 'weak';
  clearTimeout(netTimer);
  netTimer = setTimeout(() => {
    els.detail.dataset.net = '';
    els.detail.textContent = '';
  }, 6000);
}

function notice(html) {
  els.notice.innerHTML = html;
  els.notice.classList.add('show');
}

// ------------------------------------------------------------------ Anam

async function connect() {
  const res = await window.tony.sessionToken();
  if (!res.ok) {
    notice(`Can't reach Anam: ${res.error}. Tony will run text-only.`);
    return;
  }

  // Voice conversation: the mic is ON so Anam can transcribe the learner.
  // createClient(sessionToken, personaConfig?, options?) — persona slot stays
  // undefined because our token already carries it (CUSTOMER_CLIENT_V1).
  anam = createClient(res.token);
  inputAudioEnabled = true;

  // Connect watchdog. The only retry path used to hang off CONNECTION_CLOSED,
  // so a session that never ESTABLISHED (observed live: token minted, then
  // silence — no SESSION_READY, no WebRTC traffic) left Tony black forever.
  // If ready doesn't arrive in time, tear down and start over.
  clearTimeout(connectWatchdog);
  connectWatchdog = setTimeout(() => {
    window.tony.note?.('connect-timeout');
    try { anam?.stopStreaming?.(); } catch { /* never established */ }
    anam = null;
    connect().catch(() => {});
  }, 15000);

  // THE fix for silent Tony: the SDK emits the audio track but never sinks it.
  const audioEl = document.getElementById('persona-audio');
  anam.addListener(AnamEvent.AUDIO_STREAM_STARTED, (stream) => {
    window.tony.note?.('audio-started');
    audioEl.srcObject = stream;
    // autoplay of a MediaStream with audio can be blocked until a user gesture;
    // play() may reject, so retry on the next interaction.
    audioEl.play().catch(() => {
      const kick = () => { audioEl.play().catch(() => {}); window.removeEventListener('pointerdown', kick); };
      window.addEventListener('pointerdown', kick);
    });
  });

  anam.addListener(AnamEvent.SESSION_READY, () => {
    clearTimeout(connectWatchdog);
    window.tony.note?.('session-ready');
    setState('observing');
    reportMic();
  });

  // The avatar is only really present once video plays; before that the card
  // should not claim to be watching.
  anam.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => setState('observing'));

  anam.addListener(AnamEvent.SERVER_WARNING, (w) => {
    const msg = (typeof w === 'string' ? w : (w && w.message) || JSON.stringify(w)) || '';
    // Congestion is a network condition, not a Tony failure. Say so plainly and
    // transiently, in the status line, instead of a scary modal warning.
    if (/congest|network|bandwidth|quality reduced/i.test(msg)) {
      els.mic.dataset.net = 'weak';
      showNetworkState('weak connection');
    } else {
      notice(`Anam: ${msg}`);
    }
  });
  // Session tokens expire after 3600s (measured). A learning session outlives
  // that easily, so reconnect rather than going silently dormant mid-lesson.
  anam.addListener(AnamEvent.CONNECTION_CLOSED, () => {
    window.tony.note?.('connection-closed');
    setState('idle');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      window.tony.note?.('reconnecting');
      try { anam?.stopStreaming?.(); } catch { /* already down */ }
      anam = null;
      connect().catch(() => {});
    }, 2000);
  });

  // Learner talking over Tony is the same signal as the deadman switch:
  // any input means stop. The persona has a scripted beat for it.
  anam.addListener(AnamEvent.TALK_STREAM_INTERRUPTED, () => {
    window.tony.note?.('talk-interrupted');
    activeStream = null;
    window.tony.learnerInput();
    setState('observing');
  });

  // THE conversation loop. Anam transcribes the learner's speech and streams it
  // as USER messages. On endOfSpeech we have a complete utterance -> hand it to
  // our brain (which holds the console context + persona) and speak the answer.
  // Anam does STT; our brain does the thinking; Anam does TTS. Tony hears you,
  // and the thing that answers is the same brain watching your screen.
  let partialUser = '';
  anam.addListener(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, (evt) => {
    if (evt.role !== 'user') return;           // ignore Tony's own transcript
    partialUser = evt.content;
    if (evt.endOfSpeech && partialUser.trim()) {
      const heard = partialUser.trim();
      partialUser = '';
      setState('thinking');
      window.tony.heard(heard);                // -> main -> brain.ask(...)
    }
  });

  // streamToVideoAndAudioElements is deprecated in this SDK version. Use
  // streamToVideoElement (video) and attach the audio track ourselves from the
  // AUDIO_STREAM_STARTED event below -- the SDK captures that track but does
  // not play it in this mode.
  await anam.streamToVideoElement('persona');
}

/**
 * TTS pronunciation fixes. The card DISPLAYS the literal text ("us-east-1");
 * only the string handed to the voice is rewritten. Regions were the measured
 * offender: "us-east-1" spoke as the word "us", not "U S".
 */
const REGION_PREFIX = {
  us: 'U S', eu: 'E U', ap: 'A P', sa: 'S A', ca: 'C A', me: 'M E', af: 'A F', il: 'I L',
};
function normalizeForSpeech(text) {
  return text.replace(
    /\b(us|eu|ap|sa|ca|me|af|il)-(east|west|north|south|central|northeast|southeast|northwest|southwest)-(\d)\b/gi,
    (_, p, dir, n) => `${REGION_PREFIX[p.toLowerCase()]} ${dir} ${n}`
  );
}

/**
 * Cache hit: a complete string is already in hand, so talk() fires it with no
 * stream setup. Measured at the 270ms floor — pure Anam overhead, no inference
 * on the critical path.
 */
function speakComplete(text) {
  setState('speaking');
  say(text);
  anam?.talk(normalizeForSpeech(text));
}

/**
 * Cache miss: the bridge is deterministic and hardcoded, so it also goes out
 * via talk() at the same 270ms floor. Generating it with a model measured
 * 750ms — we were paying 480ms to say something we already knew we'd say.
 */
function speakBridge(text) {
  setState('speaking');
  say(text, { bridge: true });
  anam?.talk(normalizeForSpeech(text));
}

/** Substance arriving behind the bridge, streamed as tokens land. */
function speakFollowUp(text) {
  say(text, { append: true });
  if (!anam) return;
  activeStream = anam.createTalkMessageStream();
  if (activeStream.isActive()) {
    activeStream.streamMessageChunk(normalizeForSpeech(text), false);
    activeStream.endMessage();
  }
  activeStream = null;
  setState('observing');
}

// ------------------------------------------------------------------- IPC

window.tony.on('speak', ({ text, via }) => {
  if (via === 'bridge') speakBridge(text);
  else speakComplete(text);
});

window.tony.on('speak-followup', ({ text }) => speakFollowUp(text));

window.tony.on('state', ({ state }) => setState(state));

window.tony.on('hotkey', ({ ask }) => {
  // Render the real chord in the prompt; CSS ::after can't be set from JS, so
  // we drive a data attribute the stylesheet reads.
  document.body.dataset.askKey = ask
    .replace('Control', '^').replace('Alt', '⌥').replace('Command', '⌘')
    .replace('Shift', '⇧').replace('CommandOrControl', '⌘').replace(/\+/g, '');
});

window.tony.on('screen', (screen) => {
  els.detail.textContent = screen.aws ? `${screen.service}/${screen.page}` : 'off-console';
});

window.tony.on('deadman-abort', () => {
  setState('observing');
  say('You moved, I stopped. House rules. Where were we?');
});

window.tony.on('permissions', (perms) => {
  if (perms.accessibility === false) {
    notice(
      'Tony reads the screen through macOS Accessibility. Grant it in ' +
      '<a id="axlink">System Settings → Privacy &amp; Security → Accessibility</a>, then restart.'
    );
    document.getElementById('axlink')
      ?.addEventListener('click', () => window.tony.openAccessibilitySettings());
  }
});

window.tony.on('notice', ({ text }) => notice(text));

window.tony.on('observer-error', (e) => {
  if (e.fatal) notice(`Observer stopped: ${e.message}`);
});

// The Terraform hand-off. On-demand: the files box appears when the learner
// asks for their files and Tony hands off — reliable now that the handoff turn
// retries a JSON-only reply instead of being dropped on a parse failure. One
// click zips main.tf + README into Downloads and reveals it. This is the
// reproducible artifact an architect passes to a developer.
const filebox = document.getElementById('filebox');
window.tony.on('artifact', ({ tf, resources, label }) => {
  if (!tf) return;                        // only surface once there are files
  const n = resources || 0;
  // A design turn passes an explicit label ("Terraform template · …"); the
  // console-lesson hand-off falls back to its resource count.
  document.getElementById('fb-sub').textContent =
    label || (n ? `${n} resource${n === 1 ? '' : 's'} · Terraform` : 'Terraform ready');
  filebox.classList.add('show');
});

filebox?.addEventListener('click', async () => {
  if (filebox.dataset.busy === 'true') return;
  filebox.dataset.busy = 'true';
  const action = document.getElementById('fb-action');
  action.textContent = 'Saving…';
  const res = await window.tony.downloadArtifacts();
  if (res.ok) {
    action.textContent = 'Saved ✓';
    setTimeout(() => { action.textContent = 'Download'; filebox.dataset.busy = 'false'; }, 2500);
  } else {
    action.textContent = 'Retry';
    notice(`Download failed: ${res.error}`);
    filebox.dataset.busy = 'false';
  }
});

// Close/exit. The window is frameless, so this button is the only user-facing
// way to end the session. Tear the Anam session down locally FIRST — stop the
// stream (releases the mic) and cancel the reconnect/watchdog timers so nothing
// silently re-opens the session — then ask main to quit. Main's will-quit path
// closes the lesson browser gracefully before exiting.
document.getElementById('close')?.addEventListener('click', () => {
  clearTimeout(reconnectTimer);
  clearTimeout(connectWatchdog);
  reconnectTimer = null;
  connectWatchdog = null;
  try { anam?.stopStreaming?.(); } catch { /* already down */ }
  anam = null;
  setState('idle');
  els.mic.textContent = 'mic off';
  els.mic.dataset.live = 'false';
  window.tony.endSession();
});

// Mode buttons were removed with the compact circular card; the mode defaults
// to walk_through and remains settable via the set-mode IPC when a control
// surface returns (tray menu, voice command, ...).

// Deadman: any keypress or click anywhere in the overlay aborts driving.
// The main process also watches globally; this covers the focused window.
['keydown', 'mousedown'].forEach((ev) => {
  window.addEventListener(ev, () => {
    if (els.body.dataset.state === 'driving') window.tony.learnerInput();
  }, true);
});

connect().catch((err) => notice(`Startup failed: ${err.message}`));
