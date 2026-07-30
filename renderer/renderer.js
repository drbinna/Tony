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

  // createClient(sessionToken, personaConfig?, options?) — THREE positional
  // args. Passing an options object second lands it in the personaConfig slot,
  // and since our token already carries the persona (minted server-side with
  // CUSTOMER_CLIENT_V1), Anam rejects the session: "This session token already
  // contains a persona configuration." Persona slot stays undefined; options
  // go third. disableInputAudio keeps the mic fully off until push-to-talk.
  anam = createClient(res.token, undefined, { disableInputAudio: true });

  // THE fix for silent Tony: the SDK emits the audio track but never sinks it.
  const audioEl = document.getElementById('persona-audio');
  anam.addListener(AnamEvent.AUDIO_STREAM_STARTED, (stream) => {
    audioEl.srcObject = stream;
    // autoplay of a MediaStream with audio can be blocked until a user gesture;
    // play() may reject, so retry on the next interaction.
    audioEl.play().catch(() => {
      const kick = () => { audioEl.play().catch(() => {}); window.removeEventListener('pointerdown', kick); };
      window.addEventListener('pointerdown', kick);
    });
  });

  anam.addListener(AnamEvent.SESSION_READY, () => {
    setState('observing');
    anam.muteInputAudio?.();          // belt and braces alongside disableInputAudio
    reportMic();
  });

  // The avatar is only really present once video plays; before that the card
  // should not claim to be watching.
  anam.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => setState('observing'));

  anam.addListener(AnamEvent.SERVER_WARNING, (w) => {
    notice(`Anam warning: ${typeof w === 'string' ? w : JSON.stringify(w)}`);
  });
  // Session tokens expire after 3600s (measured). A learning session outlives
  // that easily, so reconnect rather than going silently dormant mid-lesson.
  anam.addListener(AnamEvent.CONNECTION_CLOSED, () => {
    setState('idle');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      try { anam?.stopStreaming?.(); } catch { /* already down */ }
      anam = null;
      connect().catch(() => {});
    }, 2000);
  });

  // Learner talking over Tony is the same signal as the deadman switch:
  // any input means stop. The persona has a scripted beat for it.
  anam.addListener(AnamEvent.TALK_STREAM_INTERRUPTED, () => {
    activeStream = null;
    window.tony.learnerInput();
    setState('observing');
  });

  // streamToVideoAndAudioElements is deprecated in this SDK version. Use
  // streamToVideoElement (video) and attach the audio track ourselves from the
  // AUDIO_STREAM_STARTED event below -- the SDK captures that track but does
  // not play it in this mode.
  await anam.streamToVideoElement('persona');
}

/**
 * Cache hit: a complete string is already in hand, so talk() fires it with no
 * stream setup. Measured at the 270ms floor — pure Anam overhead, no inference
 * on the critical path.
 */
function speakComplete(text) {
  setState('speaking');
  say(text);
  anam?.talk(text);
}

/**
 * Cache miss: the bridge is deterministic and hardcoded, so it also goes out
 * via talk() at the same 270ms floor. Generating it with a model measured
 * 750ms — we were paying 480ms to say something we already knew we'd say.
 */
function speakBridge(text) {
  setState('speaking');
  say(text, { bridge: true });
  anam?.talk(text);
}

/** Substance arriving behind the bridge, streamed as tokens land. */
function speakFollowUp(text) {
  say(text, { append: true });
  if (!anam) return;
  activeStream = anam.createTalkMessageStream();
  if (activeStream.isActive()) {
    activeStream.streamMessageChunk(text, false);
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

window.tony.on('observer-error', (e) => {
  if (e.fatal) notice(`Observer stopped: ${e.message}`);
});

// --------------------------------------------------------------- controls

document.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const mode = await window.tony.setMode(btn.dataset.mode);
    document.querySelectorAll('[data-mode]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    });
  });
});

// Deadman: any keypress or click anywhere in the overlay aborts driving.
// The main process also watches globally; this covers the focused window.
['keydown', 'mousedown'].forEach((ev) => {
  window.addEventListener(ev, () => {
    if (els.body.dataset.state === 'driving') window.tony.learnerInput();
  }, true);
});

connect().catch((err) => notice(`Startup failed: ${err.message}`));
