# BUILD RUNBOOK — autonomous setup (read this fully before doing anything)

You are a fresh Claude Code instance. The user cloned this repo, dropped a single
`test.mp4` in the root, and said something like "set this up." That is your whole
brief. This document is your authoritative plan. Follow it; do not improvise an
architecture.

## Non-negotiables (read first)

1. **Your training data is stale on the model landscape.** Models in
   `config/models.lock.json` are real and verified 2026-06-05. **Do NOT swap them
   for models you remember** (Whisper, CLIP, GPT-4V, pyannote-only, etc.). If you
   think one is wrong, re-verify against its linked source before changing
   anything, and write down why. The docs explain the tradeoffs:
   `docs/MODELS-2026.md`, `docs/NATIVE-STACK.md`, `docs/VISION.md`,
   `docs/IDENTITY.md`, `docs/CONTEXT-REVIEW.md`.
2. **`legacy/` is archival — ignore it.** It is the old generic engine, not this
   system. Do not build, run, or "fix" it.
3. **The source video is evidence. Never modify/delete `test.mp4` or any source.**
   Write only to `tmp/`, `osint-export/`, the database, and build artifacts.
4. **Use SUBAGENTS to keep context focused.** Spawn one subagent per phase/stage
   below; have it do the work, run its acceptance test, and report back a short
   result. Don't carry every stage's detail in your own context.
5. **Test your own work, and don't ask the user to paste errors.** Read logs and
   command output yourself. The user will not babysit this. When a step fails,
   diagnose from the output and fix it.
6. **If a Claude Code skill would help a repeatable sub-task, create it** under
   `.claude/skills/` (e.g. a `model-acquire` skill, a `stage-verify` skill, a
   `ui-drive` skill). Reuse across phases.

## What already exists (reuse it; don't rewrite)

The JS prototype in `src/` has a **deterministic core that is already tested**
(hashing, ffprobe exact-fps, frame-accurate extraction, scene cuts, perceptual
hashing, the forensic DB schema for both Postgres and SQLite, the orchestrator's
graceful-degradation flow, identity/location matching logic, the search query,
the consolidation/coverage pass, and the per-media context-review stage). Run it
first to see the shape, then wire the real models into the adapter seams and
(per `docs/NATIVE-STACK.md`) port the hot paths to native where it matters.

Entry points: `npm run ingest`, `npm run review`, `npm run search`,
`npm run consolidate`. Adapter seams: `src/adapters/models.js` + the Python
scripts in `scripts/`. Model artifacts: `config/models.lock.json`.

## Target architecture (the end state)

A native-first, single-investigator desktop tool: drop a drive of footage, it
runs overnight, and the investigator searches in plain language, sees flagged
"20% nuance" on a timeline, jumps to the exact frame, confirms/corrects, and
exports clips — with a provenance trail behind every item. Storage = SQLite +
sqlite-vec (no server). Audio = sherpa-onnx. Embeddings = fastembed-rs or
llama.cpp. VLM = llama.cpp (on-demand). GUI = a **local web app** with a
natural-language query agent and auto-editor clip/stitch (see `docs/GUI.md`).
See `docs/NATIVE-STACK.md` and `docs/HANDOFF.md` (milestones
M1–M8, M5.5, M5.7) for the module breakdown — this runbook is the execution order.

---

## PHASE 0 — Orient & detect environment
- Read this file, `config/models.lock.json`, `docs/ARCHITECTURE.md`,
  `docs/NATIVE-STACK.md`, `docs/VISION.md`, `docs/GUI.md`.
- Detect: OS, GPU + VRAM, and presence of `ffmpeg`/`ffprobe`, `node`, `python`,
  `rust`/`cargo`, `git`, and `auto-editor`. Install what's missing (see
  `docs/SETUP-WINDOWS.md`). Confirm `test.mp4` exists in the repo root.
- **Acceptance:** print a short environment report (OS, VRAM, tool versions,
  test.mp4 found). If VRAM < 8GB or a core tool can't be installed, say so and
  propose the API fallback path — don't silently continue.

## PHASE 1 — Acquire & smoke-test models (one subagent)
For each model the build will use, download the EXACT artifact from
`config/models.lock.json` and run its `smoke_test`. **A model is not "installed"
until its smoke test passes.** Cache downloads under a `models/` dir (gitignored).
- ASR: sherpa-onnx Parakeet-v3 int8 → transcribe a bundled test wav → non-empty
  text with word timestamps.
- Diarization: segmentation + CAM++ embedding → diarize a 2-speaker sample → ≥2
  speakers.
- Text embeddings: Qwen3-Embedding-0.6B → two paraphrases score high cosine;
  confirm dim == 1024 == the vec table dimension.
- (Defer LR-ASD/face/VLM to their phases.)
- **Acceptance:** a table of model → smoke-test PASS/FAIL. Stop on any FAIL and
  fix before continuing.

## PHASE 2 — Wire the deterministic + audio pipeline (subagent per stage)
Bring `npm run ingest` from "graceful skip" to "real output" on `test.mp4`,
stage by stage (see `src/ingest.js`). After each, query the DB to verify rows.
1. **STAGE 0 intake** — already real: sha256 + ffprobe → `sources` row. Verify.
2. **Frames + signatures + OSINT** — already real: keyframes, `frame_signatures`,
   `locations_of_interest`. Verify exported frames + sidecars appear.
3. **ASR** — wire sherpa-onnx Parakeet → `transcript_words` populated with
   timings.
4. **Diarization** — wire sherpa-onnx → `speakers` + diarized turns; utterances
   built and named ("unidentified speaker N" until enrollment).
5. **Embeddings** — wire Qwen3-Embedding → `embeddings` rows; `npm run search
   "<phrase from test.mp4>"` returns the moment with timestamp.
- **Acceptance:** after ingest, `test.mp4` has a source row, words, utterances,
  events (if any), locations (if any), and is searchable by meaning.

## PHASE 3 — Identity, ASD, and the knowledge base (subagent)
- **Enrollment:** implement the enroll step (voice print via sherpa speaker-id;
  face print via ArcFace) reading `enrollment_clips` from the taxonomy; store in
  `identity_enrollments`. Perceptual-hash `known_locations.reference_frames`.
- **Naming:** the matching logic already exists (`src/analyze/identify.js`,
  tested). Feed real embeddings into it so speakers/locations get real names.
- **ASD (the misattribution fix):** export LR-ASD to ONNX, add SCRFD face detect,
  run via `ort` on multi-face/second-speaker segments only; reconcile into
  utterance attribution (the orchestrator already consumes this shape).
- **Coverage:** `npm run consolidate` prints recognition coverage.
- **Acceptance:** an enrolled person is auto-named in `test.mp4` with a
  confidence; off-screen/again-unknown speech reads "unidentified … needs review";
  coverage report prints.

## PHASE 4 — Context-review agent (subagent)
- Already implemented (`src/review/`). Confirm a backend: `claude-code` (local,
  for sensitive context) or `openrouter` (testing). Fill in real case knowledge
  in `config/context-review.prompt.md` (or leave the template for the user).
- **Acceptance:** `npm run review` produces `context_annotations` on `test.mp4`
  (or correctly reports "no significance" if test.mp4 has nothing case-relevant),
  each flagged unreviewed with rationale + confidence + prompt_hash.

## PHASE 5 — Build the investigator GUI (subagent; the deliverable)
Build the **local web app** specified in `docs/GUI.md` (Rust/axum or Go backend
serving a localhost JSON API over the DB + the query agent + clip/stitch via
`auto-editor`; plain HTML/CSS/JS frontend). The heavy compute stays native; only
this thin UI shell is web (rationale + the browser-automation verification benefit
are in `docs/GUI.md`). Minimum:
- Full-width **natural-language search box** → the **query agent** endpoint
  (semantic + alias expansion + optional LLM intent-parse; extend
  `src/search/query.js`). Returns ranked segments with file/timestamp/speaker/
  location/flags/confidence + matching context annotations.
- **Left column (~50%):** scrollable results (quote, timestamp, speaker, flags,
  file, location). Clicking a row **seeks the player and plays that segment**;
  switching rows switches fast.
- **Right (~50%):** video player (part of the screen), transport, **"Clip this"**,
  **"+ Queue"**, the **queue list**, and **"Stitch ⬇"** (sequential concat).
  Clips cut with `auto-editor` from exact DB timestamps → frame-accurate output;
  the original is never modified.
- **Review actions** (confirm/reject/set identity) writing the review fields.
- Dark neon design per `docs/GUI.md` (semantic colors; calm, obvious).
- **Acceptance:** the app launches at a localhost URL, loads `test.mp4`'s index,
  and a human (or the Phase 6 harness) can search → click a result → it plays →
  Clip / Queue / Stitch → review — with no terminal use.

## PHASE 6 — Self-verification with real UI interaction (REQUIRED)
Do not declare done from unit tests alone. Drive the actual UI like a user and
watch what happens.

- **Because the UI is a local web app, verify with browser automation** —
  **Playwright MCP** (preferred for Claude Code) or an equivalent browser-harness
  — driving a real browser at the local URL. This gives reliable accessibility-tree
  targeting, clicks/typing, screenshots, and DOM assertions. Spawn a SEPARATE
  Claude Code instance (or a subagent driving the harness in a see→act→verify
  loop). Capture screenshots + logs to `tools/ui_verify/runs/`.
- Scenarios to pass: (a) type a natural-language query known to match `test.mp4`
  and get a result; (b) click a result and confirm the player seeks to that
  timestamp and plays; (c) frame-step (or `1/fps` nudge) and confirm the time
  changes; (d) Clip a segment and confirm a new file exists with the right
  duration AND the original is byte-identical (re-hash it); (e) Queue two segments
  + Stitch and confirm the output concatenates them in order; (f) confirm/reject an
  annotation and confirm the DB row updated.
- **On failure, the agent reads the screenshot + DOM + logs, diagnoses, fixes the
  code, rebuilds, re-runs — it does NOT ask the user to paste an error.** Loop
  until green or a genuine blocker, then report exactly what's stuck and what you
  tried.
- **Native-shell fallback only:** if a future build uses a native (egui/Tauri)
  shell instead of the web app, verify with **Windows-MCP + pywinauto (UI
  Automation)** — not coordinate-based pyautogui — but note egui exposes a weak
  accessibility tree, which is why the default UI is web.
- **Acceptance:** a green report, each scenario PASS with a screenshot + the
  artifacts produced (clip files, DB changes), and a re-hash proving the source is
  untouched.

## PHASE 7 — Final report
Summarize: environment, models installed (with smoke-test results), each pipeline
stage status, the GUI, and the Phase 6 scenario results. State plainly what works,
what's deferred (e.g. M8 dense VLM, multimodal embeddings), and any blocker. Leave
`config/context-review.prompt.md` and `config/taxonomy.json` clearly marked for the
user to fill with real case data.

---

## Operating rules throughout
- **Subagents:** one per phase/stage; keep each one's context tight; you hold only
  the checklist + their summarized results.
- **Skills:** create `.claude/skills/` entries for anything you do more than once
  (model acquisition, stage verification, UI driving). Search for existing skills
  first.
- **Provenance:** never store a model output without its provenance fields (the
  schema already has them). Never present an AI guess as fact — it's a reviewable
  claim.
- **Don't regress the model choices.** If you ever feel the urge to "simplify" by
  swapping in a model you already know, re-read non-negotiable #1.
- **Idempotent + resumable:** re-running a phase should detect what's already done
  (the DB is keyed by source sha256; models are cached) and not redo it.
