# CLAUDE.md — read this first

This repo is a **forensic video-ingestion tool** for an authorized investigative
journalist: drop a drive of footage, it indexes everything (transcribe, diarize,
identify people/places, flag the meaningful exceptions), and the investigator
searches in plain language, jumps to the exact frame, verifies, and exports clips
— with a provenance trail behind every claim. It is a **triage tool, not court
evidence**: name things confidently with a confidence score; the human verifies.

## If the user says "set this up" (or similar)

They have cloned the repo and dropped a `test.mp4` in the root. That is the whole
brief. **Execute `docs/BUILD.md` end to end.** It is the authoritative, ordered
runbook. Do not improvise an architecture or ask the user for a prompt.

## Four things you must internalize before touching code

1. **Your training data is STALE on the model landscape.** The models in
   `config/models.lock.json` are real, current (verified 2026-06-05), and chosen
   deliberately. **Do NOT substitute models you remember** (Whisper, CLIP,
   GPT-4V, pyannote-only). If you doubt one, re-verify it against its linked
   source before changing anything — don't "fix" it from memory.
2. **`legacy/` is the OLD generic engine — ignore it.** Build only from `src/`.
3. **Source videos are evidence — never modify or delete them.** Write only to
   `tmp/`, `osint-export/`, the DB, `models/`, and build artifacts.
4. **The GUI is NATIVE and you verify it by SCREENSHOT. Do not relitigate this.**
   You will *instinctively* want to make the UI a web app and verify it with
   browser automation (Playwright). **That instinct is wrong here and is a hard
   NO** — the user has shipped many video apps and web video stacks fail for this
   work. Build native (Rust `egui` + `libmpv`, frame-accurate) per `docs/GUI.md`.
   Verify by driving the real app and reading SCREENSHOTS with your own vision.
   **Tool yourself for control** by adding the **Windows-MCP** server to Claude
   Code (`claude mcp add` — repo github.com/CursorTouch/Windows-MCP; it gives you
   mouse/keyboard/screenshot); optional pixel-grounding via ShowUI-2B. Exact loop
   and scenarios are in BUILD.md Phase 6. **Never ask the user to paste error
   codes** — read the screenshot + the app's log yourself and fix it.
5. **Use subagents** (one per phase) to keep your context focused, and **create
   skills** for repeated sub-tasks (e.g. `.claude/skills/ui-verify`).

## Map

- `docs/BUILD.md` — the runbook you execute. Start here.
- `config/models.lock.json` — exact model artifacts + where to get them + smoke
  tests. Authoritative.
- `docs/ARCHITECTURE.md` — pipeline + data model + chain-of-custody.
- `docs/NATIVE-STACK.md` — the native (Rust/ONNX/llama.cpp/sqlite-vec) target.
- `docs/VISION.md` — how vision works, incl. multi-hour clips (read-only).
- `docs/IDENTITY.md` — naming people/places + the learning/coverage loop.
- `docs/CONTEXT-REVIEW.md` — the per-media case-aware nuance agent.
- `docs/GUI.md` — the investigator UI (native: egui + libmpv): layout, design, the
  natural-language query agent, clip/stitch, and how it's self-verified.
- `docs/SETTINGS.md` + `config/settings.schema.json` — GUI-exposed vs set-once.
- `docs/MODELS-2026.md` — the cited research behind the model choices + cost math.

## Reality of what's here
The `src/` JS prototype's deterministic core is already tested (hashing,
frame-accurate extraction, scene/hash, both DB schemas, orchestrator flow,
identity/location matching, search, consolidation, context-review). Reuse it,
wire the real models into the adapter seams, then port hot paths to native per
NATIVE-STACK. The investigator-facing **player GUI** (BUILD.md Phase 5) is the
main thing still to build.
