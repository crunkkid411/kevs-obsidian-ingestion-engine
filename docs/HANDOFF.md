# Handoff plan for local Claude Code

This is the build order for turning the tested prototype in this repo into the
native, single-investigator tool described in `docs/NATIVE-STACK.md`. It is
written to be executed step by step by a local Claude Code instance on the
Windows machine that has the GPU, the footage, and `auto-editor` installed.

**Ground rules (carry these into every step):**
- Sources are **read-only**. Never modify, move, or delete an original. The JS
  prototype already enforces this; keep it true in the port.
- Every model output is a **claim with provenance + confidence**, separated from
  deterministic facts, and reviewable. When the machine can't verify (off-screen
  voice, >1 face, tiny face), it outputs **unknown + flag**, never a guess.
- This tool **corroborates**; it never concludes *where* footage was filmed or
  *who* someone is. It hands clean frames + exact timestamps to the human.

## What's already done and verified (build on it, don't redo)
- `src/sources/local.js` — read-only walk + SHA-256 + ffprobe (exact rational fps,
  orientation). **Tested.**
- `scripts/extract_frames_precise.py` — frame-accurate extraction (frame/timestamp/
  scene/fps modes). **Tested** (frame 29→0.984s; scene cut at exact frame 45).
- `src/analyze/signatures.js` — 64-bit aHash + Hamming + location-change detection.
  **Tested** (distinct shots → Hamming 32 ≥ 18).
- `src/analyze/events.js` — second-speaker / phone-call / location-change events.
  **Tested.**
- `src/db/schema.sql` (Postgres) + `src/db/schema.sqlite.sql` (**recommended**) —
  full forensic schema incl. `events`, `locations_of_interest`, `frame_signatures`,
  `clips`. **Both validated** (Postgres applied live with pgvector; SQLite DDL applied).
- `src/ingest.js` — staged orchestrator; STAGE 0 + frames + signatures + OSINT
  export run today; model stages degrade gracefully. **Tested end-to-end.**

These define the **contracts** the native code must match (same JSON shapes, same
DB columns, same OSINT sidecar format).

## Recommended workspace (Rust)
A single Rust workspace keeps the engine and the player in one native binary set.
```
forensic/
├─ crates/
│  ├─ store/        # rusqlite + sqlite-vec; mirrors schema.sqlite.sql; all inserts/queries
│  ├─ media/        # ffprobe/ffmpeg wrappers: probe, demux 16k wav, frame-accurate extract, aHash
│  ├─ asr/          # sherpa-onnx bindings: Parakeet words+timestamps, Silero VAD chunking
│  ├─ diarize/      # sherpa-onnx diarization: turns + speaker clusters
│  ├─ asd/          # ort: face detector + LR-ASD; per-turn visible-speaker score (the fix)
│  ├─ embed/        # fastembed-rs (Qwen3-Embedding) -> vectors; later Qwen3-VL-Embedding
│  ├─ analyze/      # port of signatures.js + events.js (aHash, hamming, events)
│  ├─ pipeline/     # port of ingest.js stage orchestration + OSINT export
│  └─ player/       # libmpv + egui review UI + clip export via auto-editor
└─ Cargo.toml
```
Go is fine for `pipeline`/`store` if preferred (sherpa-onnx and sqlite have Go
bindings), but `ort` + `egui` make Rust the path of least resistance for `asd`
and `player`.

## Milestones (each ends with a concrete acceptance test)

### M1 — Storage (`store`)
Port `schema.sqlite.sql` via `rusqlite`; load `sqlite-vec`; set the vec dim to
your embedding model (1024). Implement the inserts/queries the prototype has
(`registerSource`, `logCustody`, `insertWords`, `insertUtterance`,
`insertEmbedding`, `insertEvent`, `insertFrameSignature`,
`insertLocationOfInterest`, `insertClip`) + the cosine search from
`src/search/query.js`.
**Accept:** ingest a fake source + one embedding; the search query returns it
with timestamp + `needs_review`. (Matches the live Postgres test already passing.)

### M2 — Media (`media`)
Wrap ffprobe/ffmpeg: `probe()` (exact rational fps, orientation), `demux_wav_16k()`,
`extract_frames()` (port `extract_frames_precise.py` semantics — accurate output
seek `-ss` AFTER `-i`), `ahash()` (8×8 gray → 64-bit). Optionally add ffmpeg
`signature` (MPEG-7) for cross-video matching.
**Accept:** on a known clip, frame 29 → 0.984 s and a hard cut is detected at the
exact frame (reproduce the prototype's numbers).

### M3 — ASR + diarization (`asr`, `diarize`)
sherpa-onnx: Parakeet ONNX → words+timestamps; Silero VAD for silence-boundary
chunking of multi-hour streams; diarization → speaker turns/clusters. Match the
JSON contracts in `src/adapters/models.js` (`runASR`, `runDiarization`).
**Accept:** a 2-speaker test clip yields correct word timings and ≥2 clusters;
a one-room monologue yields a single dominant speaker and **zero** second-speaker
events.

### M4 — Pipeline + events + OSINT (`analyze`, `pipeline`)
Port `signatures.js` + `events.js` + the `ingest.js` stage flow, including the
**OSINT export** (full-res location frame + provenance sidecar JSON — keep the
exact sidecar shape the prototype writes). Persist events/signatures/locations.
**Accept:** run over a folder; second voice and room change produce flagged
`events` + exported OSINT frames; a single-room monologue produces neither.

### M5 — Visual active-speaker (`asd`) — the misattribution fix
Export LR-ASD to ONNX (`torch.onnx`), add a face detector ONNX (SCRFD/YOLO-face).
Via `ort`: for each diarization turn on a **multi-face** segment, extract frames
at the turn's timestamps, detect/track faces, score lip-sync, pick the single
speaking face above `ASD_CONF_FLOOR` or output `null`. Feed back into utterance
attribution (the prototype already consumes this shape in STAGE 4).
**Accept:** on a clip with two visible faces where only one talks, the talker is
chosen; with off-screen narration, attribution is `unknown` + `needs_review`.
This is the highest-value milestone — do not let it silently guess.

### M6 — Embeddings + search (`embed`)
fastembed-rs Qwen3-Embedding-0.6B → vectors into sqlite-vec; port the
query-expansion (`--expand` folds entity aliases/nicknames) from
`src/search/query.js`. Add Qwen3-Reranker for precision if time allows.
**Accept:** "every time he mentions his wife" returns the oblique "my ex … 4
months" utterance, each hit showing source + timestamp + attribution + review state.

### M7 — Player + clipper (`player`) — the investigator's surface
libmpv + egui desktop app:
- Left: search box + results list (events, search hits, locations-of-interest),
  each row = file + timestamp + attribution + flags.
- Center: mpv video, **frame-accurate** step (`,`/`.`), exact seek to a hit.
- Mark **in/out**, then export an evidence clip via **`auto-editor`** (you have it
  installed — it cuts more precisely than raw ffmpeg) and record a `clips` row.
- One-click **review actions**: confirm / reject / set speaker identity; writes the
  `needs_review`, `attribution_*`, and `reviewed_by` fields.
- "Open OSINT folder" for a location-of-interest.
**Accept:** a non-technical user can search a phrase, jump to the exact frame,
confirm the speaker, and export a clip — without touching a terminal.

### M8 — On-demand understanding (optional)
Wire `VIDEO_BACKEND` to llama.cpp (local Qwen3-VL on extracted frames) and/or
OpenRouter, invoked **only** on flagged/queried segments. Store outputs as
`inferences`/`visual_observations` with provenance. (Cost math: `docs/MODELS-2026.md` §4–5.)

## "20% nuance" — make the deviations impossible to miss
Most footage is one person, one room; the value is the exceptions. The pipeline
already flags them as `events`; the UI must **surface them first**:
- A per-source timeline strip marking `second_speaker`, `phone_call`,
  `location_change`, `multi_face` so an investigator scans a 5-hour stream in seconds.
- A cross-video "this background recurs here too" view from `frame_signatures`
  (small Hamming distance) — supports fixture matching without leaving the tool.
- Phone-call upgrade (native): add the narrowband-audio check noted in
  `src/analyze/events.js` to raise `phone_call` confidence.

## Definition of done
A non-technical investigator points the tool at a drive, lets it run overnight,
then: searches behaviors/phrases, sees flagged deviations on a timeline, jumps to
the exact frame, confirms/corrects attribution, exports court-ready clips, and
hands OSINT location frames to detectives — all from one native app, with a full
provenance trail behind every item.
