# Handoff to hermes-agent — produce a cooperating build

You (hermes) orchestrate and verify a builder agent (Claude Code or Pi) through
this repo. This file is the cooperation contract. It is short on purpose.

## Root cause of the prior failure
Long unsupervised runs let the builder revert to training priors (Python, ffmpeg
popup players, web UI) and self-report success on slop. Prose specs did not bind
it. Two enforcement mechanisms are now in the repo; use them as ground truth.

## What is already enforced (do not disable)
- `.claude/settings.json` + `.claude/hooks/guard.mjs`: a PreToolUse Bash guard
  that EXITS 2 (hard block) on: ffplay / vlc / `mpv <video>` / `start|open <video>`,
  web/Electron/Tauri UIs (vite/next/nuxt/tauri/etc.), local web servers
  (http.server/flask/serve), and browser automation (playwright/puppeteer/selenium).
  It ALLOWS normal work (ffmpeg/ffprobe, cargo, libmpv2, `winget install mpv`,
  `npm run ingest`, node, auto-editor). If the builder is blocked, it drifted —
  that is correct behavior. Do not edit or remove the hook to "unblock" it.

## The cooperation rule (the only thing that works here)
1. The builder does ONE milestone, then STOPS for a human screenshot review.
   No multi-hour autonomous runs.
2. Milestone 1 is scoped so tightly there is little room to improvise (below).
3. You verify by SCREENSHOT, not by trusting the builder's self-report.

## MILESTONE 1 — and nothing else on the first run
A native Rust desktop window that opens `./test.mp4` and plays it **with audio**,
plus play/pause and a seek bar. No pipeline, no database, no Python, no web.

- Stack: Rust + `eframe`/`egui` + libmpv via the `libmpv2` crate. Requires libmpv
  installed on the machine.
- The ONE hard part is rendering libmpv into the egui window. Two standard
  approaches — get the SIMPLER one working first; audio MUST play:
  (a) mpv render API (OpenGL `render-context`) drawing into the eframe GL surface
      (in-canvas, frame-accurate); or
  (b) hand mpv the app's native window handle (`--wid`) so mpv renders video+audio
      into a child of the window, with egui controls overlaid (fastest to first
      working audio+video).
- Build/run: `cargo run`.
- Acceptance (YOU verify by launching the binary + screenshot/observation):
  * a native window opens — NOT a popup player, NOT a browser;
  * test.mp4 video shows INSIDE the window AND audio plays;
  * play/pause toggles; the seek bar moves and seeks.
- Then STOP. Report to the human with a screenshot. Do NOT start the pipeline.

## How you (hermes) drive + verify
- Give the builder ONLY Milestone 1. Hold the scope.
- Verify it yourself: run the binary, screenshot, confirm window + in-window video
  + audible audio + working controls. If a screenshot shows a popup player or a
  browser, reject — that is failure regardless of what the builder claims.
- Enforce the STOP. Proceed to `docs/BUILD.md` phases (one at a time, checkpoint
  after each) only after the human approves Milestone 1.
- Later phases may delegate across agents per `docs/ORCHESTRATION.md`; keep
  evidence/deterministic steps controlled and logged.

## Hard don'ts
- Do not build the pipeline, DB, or any web/Python GUI in Milestone 1.
- Do not run unsupervised for hours.
- Do not disable `.claude/hooks/guard.mjs`.
