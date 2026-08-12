# Scripted demos (the fast, repeatable path)

For a live demo you want **fast and identical every time** — no model latency,
no variance. A scripted demo (a "rail") runs a fixed lesson deterministically:
each step is pre-authored narration + one action against a role/name target, so
the only per-step cost is the DOM action + a short settle. Consent is preserved
— Tony highlights, asks, and acts on your "go" — and the Terraform hand-off
still works (steps can carry the `resource`/`data` to commit).

## Run one

- **By voice:** start a session and say **"run the EC2 demo"** (or *start* /
  *launch* / *play*). Then just say **"go"** / "next" / "launch it" to advance
  each step; a real question mid-demo falls through to the model for that turn;
  **"stop"** ends it.
- **Auto-start:** launch with the env set —
  `TONY_DEMO=ec2 TONY_FAST_CONFIRM=1 TONY_SETTLE_MS=800 npm run start:ext` — and
  the demo begins on your first utterance.

## Speed knobs (also help normal lessons)

| Env | Effect |
| --- | --- |
| `TONY_FAST_CONFIRM=1` | confirm turns run on the fast model — ~2× faster per action |
| `TONY_SETTLE_MS=800` | shorter post-action settle (default 1800; use on a warmed account) |

The rail itself uses `TONY_SETTLE_MS` (default 900) between steps.

## EC2 demo prerequisite

`browser/demos/ec2-launch.js` launches a real t3.micro. Fresh accounts default
to **0 vCPU quota**, so the final launch fails with "requested more vCPU
capacity…". Raise **Service Quotas → EC2 → Running On-Demand Standard instances
(L-1216C47A)** to ≥ 4 before demoing, or the flow ends on the quota error.

## Tuning a script

Console labels drift. Dry-run once; if a step misses, its
`demo-act ok:false` in the newest `transcripts/*.jsonl` names the step — fix that
step's `targetName` in the script (targets are plain role + accessible-name).

## Adding a demo

1. Write `browser/demos/<name>.js` exporting `{ name, intro, steps, outro }`.
   Each step: `{ say, act?, resource?, data?, variables?, outputs?, settleMs? }`
   where `act` is `{ tool, role, targetName, text?, submit?, url?, nth? }`.
2. Register it in `browser/lesson.js`: `const DEMOS = { ec2: …, <name>: require('./demos/<name>') }`.
3. Trigger it by saying "run the &lt;name&gt; demo" or `TONY_DEMO=<name>`.
