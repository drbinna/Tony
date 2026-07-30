import { createClient } from '@anam-ai/js-sdk';
import { AnamEvent } from '@anam-ai/js-sdk/dist/module/types';

const els = {
  body: document.body,
  label: document.getElementById('label'),
  detail: document.getElementById('detail'),
  speech: document.getElementById('speech'),
  notice: document.getElementById('notice'),
};

let anam = null;
let activeStream = null;   // in-flight createTalkMessageStream, if any

const LABELS = {
  idle: 'Dormant — not watching',
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

  anam = createClient(res.token);

  anam.addListener(AnamEvent.SESSION_READY, () => setState('observing'));
  anam.addListener(AnamEvent.CONNECTION_CLOSED, () => setState('idle'));

  // Learner talking over Tony is the same signal as the deadman switch:
  // any input means stop. The persona has a scripted beat for it.
  anam.addListener(AnamEvent.TALK_STREAM_INTERRUPTED, () => {
    activeStream = null;
    window.tony.learnerInput();
    setState('observing');
  });

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
