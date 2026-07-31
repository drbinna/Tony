# Tony — goblin cloud tutor overlay

A floating macOS overlay that watches you work in the AWS console and teaches
as you go. Reads the screen through the accessibility tree, speaks through an
Anam avatar, thinks on Fireworks.

Every architectural choice below traces to a measurement in
`../tony-harness/LATENCY-FINDINGS.md`. This is not a greenfield design.

---

## Voice conversation (mic on)

Tony hears you and answers as himself, with the console in view:

1. Anam transcribes your speech and streams it as USER messages
   (MESSAGE_STREAM_EVENT_RECEIVED, with endOfSpeech marking a finished utterance)
2. on endOfSpeech, the renderer hands the transcript to main -> brain.ask
3. the brain answers with the SLOW model, given the current screen as context,
   in Tony's persona
4. the answer is spoken back through Gabriel via talk()

Anam does STT and TTS; OUR brain does the thinking. That is the only wiring
where "watches the console AND hears me AND answers as Tony" is all true at
once. The mic is live while a session is open — the status bar shows MIC LIVE.

## The one idea

**No model call is ever on the critical path.**

Anam's own threshold: above ~800ms a conversation feels broken. Measured:

| path | TTFW | verdict |
|---|---|---|
| question → kimi-k3-fast → speak | 3571ms | BROKEN |
| question → fastest available model → speak | 883ms (5390ms tail) | BROKEN |
| **cache hit → `talk()`** | **270ms** | OK |
| **hardcoded bridge → `talk()`** | **270ms** | OK |

So the slow brain runs on **observation**, not on the question. By the time the
learner asks, the answer is already sitting in the cache. Tony seeming fast is
not a speed optimization — it is a consequence of him having been watching.

On a miss, a **hardcoded** bridge line ("Reading your security group rules.")
goes out at the same 270ms floor while the fast model works behind it. An
LLM-generated bridge measured 750ms; we were paying 480ms of inference to say
something we already knew we were going to say.

## Layout

```
main.js              Electron main — window, observer wiring, IPC, deadman switch
preload.js           narrow contextIsolation bridge (no node, no keys in renderer)
observer/
  ax-dump.swift      macOS AX tree -> JSON. Tony's primary sense.
  build.sh           swiftc wrapper
  observer.js        tick loop, screen identity, signal extraction, change detection
brain/
  server.js          Anam token minting + two-speed dispatch. Ports to Fly unchanged.
  cache.js           precompute cache — the latency architecture
  bridges.js         deterministic bridge pool (the 480ms saving)
  prompts.js         FAST_SYS (plain text) + SLOW_SYS (v2, scored 6/6)
renderer/
  index.html         floating card; the state ring is the signature element
  renderer.js        Anam client, talk() dispatch, deadman capture
```

## Setup

```bash
npm install
cp .env.example .env
# open .env and fill in FIREWORKS_API_KEY and ANAM_API_KEY
npm start          # builds the AX helper + renderer bundle, then launches
```

Hotkeys: **Ctrl+Opt+Space** ask · **Cmd+Shift+D** devtools · **Cmd+Shift+Q** quit.
(Cmd+Shift+Space was dropped — it collides with Spotlight. Override the ask
chord with `TONY_ASK_HOTKEY` in `.env`, e.g. `TONY_ASK_HOTKEY=Control+Alt+T`.)
(The window is frameless with no dock icon, so Cmd+Shift+Q is the only way out.)

### The renderer must be bundled

`renderer/renderer.js` imports `@anam-ai/js-sdk`. The renderer runs as a pure
browser context (`contextIsolation: true`, `nodeIntegration: false`), so it
cannot resolve bare specifiers, the SDK's extensionless internal imports, or its
`buffer` dependency. `npm run build:renderer` bundles it with esbuild.

Loading `renderer.js` directly fails **silently** — the card renders its
hardcoded HTML defaults ("Dormant"), no listeners attach, and `connect()` never
runs, so the avatar stays black and every button is dead. If you ever see that
combination, the bundle is stale or missing: run `npm run build:renderer`.

Requires macOS, Xcode command line tools (`xcode-select --install`), and
Accessibility permission: **System Settings → Privacy & Security →
Accessibility**. Tony prompts on first launch and shows a fix-it notice if the
permission is missing.

Hotkey: **⌘⇧Space** — ask about the current screen.

## Session transcripts (debugging)

Every run writes an append-only JSONL transcript to `transcripts/` (gitignored;
override the location with `TONY_TRANSCRIPT_DIR`). It captures the whole
conversation with timings: learner utterances, cache-vs-bridge dispatch,
follow-up latency, precompute results (including raw model output on parse
failures), pointer resolution, deadman aborts, and Anam connection events.
Each answer also snapshots cache stats, so **every session measures the cache
hit rate** — the open question above.

```bash
npm run transcript                    # pretty-print the newest session
npm run transcript -- path/to.jsonl   # or a specific one
```

Writes are synchronous appends, so a crash keeps everything logged up to the
crash — which is exactly when you want the transcript.

## Design decisions worth knowing

**The fast path emits plain text, never JSON.** You cannot speak a partial JSON
object, so structured output forces you to buffer the whole response before the
first syllable. Structure lives on the slow path, which is never on the critical
path anyway.

**Reasoning models hide their output.** Every model in this Fireworks catalog
emits `reasoning_content` deltas before any speakable `content`. A consumer
reading `delta.content` alone sees an empty response and times out. Only
`deepseek-v4-flash` accepts `reasoning_effort: "none"`, which is why it is the
fast path.

**The state ring is the consent UI.** Window chrome encodes system state
truthfully: dormant means no capture is happening, and "Tony has the wheel" only
appears in AWS orange when input synthesis is live. The character being
expressive *is* the disclosure — that is why the visual states are load-bearing
and not decoration.

**Safety is enforced server-side.** `permitsDriving()` and `sanitizeAction()`
in `brain/server.js` gate mutating actions to sandbox accounts. The prompt says
the same thing; that is defense in depth, not the enforcement. A prompt rule is
a seatbelt, not a wall.

**Anti-nag and anti-repeat are client state.** `triggersFired` and `scarsUsed`
travel in the prompt suffix because the model cannot self-regulate across
stateless calls. Without them, v1 of the prompt told the identical anecdote in
4 of 4 responses.

**Tony goes quiet off-console.** The observer emits `left-console` and the
overlay drops to `idle`. This halves the capture surface and matches the persona
rule about not commenting on things the learner did not ask about.

## Verified against the real SDK (@anam-ai/js-sdk 2.5.0)

The docs import `AnamEvent` from `@anam-ai/js-sdk/dist/module/types`. That works
on esm.sh but throws `ERR_UNSUPPORTED_DIR_IMPORT` under Node/Electron ESM — the
package ships no exports map and directory imports are unsupported. Import from
the package root instead. This crashes on launch if you follow the docs verbatim.

Real `AnamEvent` members: MESSAGE_HISTORY_UPDATED, MESSAGE_STREAM_EVENT_RECEIVED,
CONNECTION_ESTABLISHED, CONNECTION_CLOSED, INPUT_AUDIO_STREAM_STARTED,
VIDEO_STREAM_STARTED, VIDEO_PLAY_STARTED, AUDIO_STREAM_STARTED,
TALK_STREAM_INTERRUPTED, SESSION_READY, SERVER_WARNING.

The package also exports `unsafe_createClientWithApiKey`. Do not use it — that is
the path that puts your Anam key in the renderer.

## Audio: the SDK does not play the avatar's voice for you

Verified by reading `StreamingClient.onTrackEventHandler` in the installed SDK
(@anam-ai/js-sdk 2.5.0): `streamToVideoElement` attaches the VIDEO track to your
element, but the AUDIO track is only emitted via the `AUDIO_STREAM_STARTED`
event and never played. You MUST attach it to an audio sink yourself:

```js
const audioEl = document.getElementById('persona-audio');
anam.addListener(AnamEvent.AUDIO_STREAM_STARTED, (stream) => {
  audioEl.srcObject = stream;
  audioEl.play().catch(() => {/* retry after a user gesture */});
});
```

`streamToVideoAndAudioElements` is deprecated in this version — do not use it.
A muted `<video>` element also silences everything, so the video element must
not carry the `muted` attribute.

This was the cause of the silent avatar. It could only be found by reading the
SDK source; the quickstart does not mention it.

## Known gaps

- **Cache hit rate is unmeasured.** This is THE open question. At 100% Tony
  feels human; at 40% most interactions take the bridge path. Instrumentation
  now exists — every session transcript snapshots cache stats per exchange
  (`npm run transcript`) — but no real session has been measured yet.
- **Anam overhead of 270ms assumes 120ms TTS.** That is an estimate. Replace it
  with a live-session measurement before trusting any number here.
- **The goblin question is open, and now narrower.** The account's library was
  enumerated on 2026-07-30: 10 avatars, all photorealistic humans (Gabriel,
  Anne, Liv, Mia, Bella, Finn, Johnny, Kenji, Zekhtar, Pulse). No stylized or
  non-human avatar exists to copy, so the test is: upload goblin art to Anam Lab
  and see whether cara-4 renders it. Gabriel/table is wired as a stand-in.
- **Session tokens expire after 3600s** (measured). The renderer now reconnects
  on CONNECTION_CLOSED, but a longer-lived refresh path is untested.
- **WebRTC paths are unverified.** Key auth, persona listing, and
  mintSessionToken() are all confirmed against the live API. `talk()` and
  `createTalkMessageStream()` need a browser session and have not been run.
- ~~Mic gating is unresolved.~~ **RESOLVED.** The SDK exposes
  `createClient(token, { disableInputAudio: true })` plus `muteInputAudio()`,
  `unmuteInputAudio()`, and `getInputAudioState()`. Tony starts with the mic
  fully off and surfaces its live state in the status bar, because a card that
  says "mic off" has to mean it.
- **No vision fallback wired yet.** The slow prompt can return `need_vision`,
  and k3-fast grounds at 0-2px on this fixture, but the screenshot capture path
  is not built. The AX tree covers the mock console completely; real consoles
  with canvas regions will need it.
- ~~Input synthesis is not implemented.~~ **IMPLEMENTED (scope B).**
  `observer/drive.swift` synthesizes CGEvents (glide + click, unicode typing,
  scroll), spawned per-gesture by `pointer/driver.js`. Sandbox-gated by
  `sanitizeAction` exactly as before — own_account actions still demote to a
  point. The deadman lives at the lowest level: every synthesized event is
  tagged in eventSourceUserData, and a listen-only event tap inside the helper
  exits(2) on ANY untagged human input, aborting the gesture mid-flight.
  abortDriving() also SIGKILLs the helper from the main-process side.
- **macOS only.** The AX tree is the primary sense; Windows would need a
  parallel UIA reader.
