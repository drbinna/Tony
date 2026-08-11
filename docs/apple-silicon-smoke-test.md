# Apple Silicon smoke test (~2 minutes)

Run once on a real **M-series Mac** (M1/M2/M3/M4) before pushing a release to
Apple Silicon users. Static checks (CI's `build/verify-arch.sh`) prove the
binary is native arm64; this covers what only real hardware can: Gatekeeper
first-launch, permission prompts, and the avatar's GPU/WebRTC path.

**Prereqs:** an Apple Silicon Mac, Google Chrome, an AWS console login for a
throwaway/sandbox account.

## Steps

1. **Download** the Mac app from https://tony.usegoblin.xyz — the button serves
   the arm64 build on Apple Silicon. (Direct: `/downloads/Tony-arm64.dmg`.)

2. **Confirm it's native arm64** (optional, from Terminal after installing):
   ```sh
   lipo -archs /Applications/Tony.app/Contents/MacOS/Tony     # → arm64
   ```

3. **Install & first launch.** Open the DMG, drag Tony to Applications, launch.
   - ✅ Opens with **no** "unidentified developer", **no** "damaged", **no**
     Rosetta-install prompt. (It's signed + notarized, so it should just open.)
   - ✅ Activity Monitor → find **Tony** → the **Kind** column says **Apple**
     (not "Intel"). This is the native-vs-Rosetta proof.

4. **Permissions.** Grant Microphone when asked. Install the **Tony Chrome
   extension** from the site, load it at `chrome://extensions`, and open the AWS
   console in a tab.

5. **Avatar + voice.** Start a session. ✅ The avatar renders and **speaks**
   (GPU/WebRTC works), and it hears your voice.

6. **Full lesson (the real test).** By voice:
   - "Create an S3 bucket." → Tony highlights **Create bucket**, you consent, he
     clicks and confirms the green success banner.
   - "Give me the Terraform." → the **files box** appears; download it and
     confirm `main.tf` + `README.md` are inside.
   - "Delete the bucket." → Tony selects it and hits **Delete bucket** (not the
     info icon), types the name, confirms deletion.

## Pass criteria

- App opens with no Gatekeeper warning and runs as **Apple** (native).
- Avatar speaks; mic works.
- create → Terraform hand-off → delete completes without a crash.

## If anything fails

Grab the newest `transcripts/*.jsonl` from the app's data dir and any errors
from **Console.app** (filter: Tony), and hand them over.
