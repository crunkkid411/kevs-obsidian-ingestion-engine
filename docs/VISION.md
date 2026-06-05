# How vision works (and how 5-hour clips are handled)

This answers three questions: what "vision analysis" actually is here, how it
runs on multi-hour videos **without ever touching the original file**, and what
vision data feeds the case-context review agent.

## The original file is never modified

Every visual step **reads** the source and **writes derived data elsewhere**:
- Frames are decoded to a scratch dir (`tmp/work/<hash>/frames/`), used, and
  deleted at the end of the run.
- Exported OSINT/location frames are copied to `osint-export/` (outside the
  source).
- The source's SHA-256 is recorded at intake; if it ever changes, that's a
  chain-of-custody red flag. The pipeline has no code path that writes to the
  source. (`config.neverDeleteSources = true`.)

## Two layers of vision

### Layer 1 — Deterministic, runs on EVERYTHING (cheap, fast, local)
This is what makes even a 5-hour stream tractable. No model "watches" the whole
video. Instead:

1. **ffprobe** reads exact metadata (true rational fps, resolution, duration).
2. **Shot/scene detection** (ffmpeg `select='gt(scene,T)'`) finds the handful of
   moments where the picture changes — in a static one-room livestream that may
   be only a few dozen cuts across 5 hours.
3. **Frame-accurate extraction** (`scripts/extract_frames_precise.py`) pulls the
   *exact* frame at each cut (or any timestamp) using decode-accurate seeking —
   the "30fps precision" you needed.
4. **Perceptual hashing** (`src/analyze/signatures.js`, 64-bit aHash; or ffmpeg's
   MPEG-7 `signature` filter) fingerprints each keyframe → detects **location
   changes** and **cross-video recurrence** (same room appearing in other files).
5. **MediaPipe / face detect (ONNX)** runs only where needed (multi-face or
   second-speaker segments) for active-speaker detection.

Cost of Layer 1 over 5 hours: minutes of CPU, a few hundred small JPEGs in
scratch. This is the dense pass.

### Layer 2 — VLM understanding, runs ONLY on a few frames of a few segments
A vision-language model (Qwen3-VL-8B local, or an API model) answers "what is
happening here." It is **never** fed the 5-hour video. For long video:

```
5h video ─▶ shot detection ─▶ N shots (e.g. 40 shots)
                                  │
                 for a flagged shot or a search hit only:
                                  ▼
              extract 1–4 frame-accurate keyframes for that shot
                                  ▼
              send those few IMAGES (+ their timestamps) to Qwen3-VL
                                  ▼
              get a description grounded to the exact timestamp
              -> stored as visual_observations (with provenance)
```

Why frames-not-video: llama.cpp's image path is reliable; its raw-video path is
newer (see `config/models.lock.json` → video_understanding). Extracting frames
ourselves also keeps everything frame-accurate and reproducible. A whole-archive
dense VLM pass is intentionally avoided — it's ~10.8M frames over 100h and
unnecessary (most frames are redundant). Triage: VLM only on flagged/queried
shots. Cost math is in `docs/MODELS-2026.md` §4–5.

## So when does vision "analyze the footage"?

- **At ingest:** Layer 1 runs on everything (shots, keyframes, signatures,
  locations, ASD on multi-face spots). This is automatic.
- **Optionally at ingest (triaged):** Layer 2 VLM on shots that look eventful, to
  pre-populate `visual_observations` (this is milestone **M8** — enable it after
  the core pipeline works; default off to control cost).
- **On demand:** Layer 2 VLM when a search drills into a moment or a reviewer
  asks "what's in this clip."

## What feeds the context-review agent (the "second set of eyes")

Vision runs **before** the context-review agent. The review agent currently
receives, per video: the transcript (with speaker names + timestamps), the
detected **events** (second speaker / phone / location change), and the detected
**locations**. Because those rows are produced by Layer 1 (+ optional Layer 2),
the agent is already reasoning over vision output, not raw pixels.

**Optional upgrade (M8.5):** also attach a few keyframes (location-change frames,
or frames from flagged shots) to the review prompt when the review backend is
vision-capable (a local Qwen3-VL via llama.cpp, or a multimodal API model). Then
the agent gets a genuine "second set of eyes" — it can catch a visible detail the
transcript missed (a face, an object, a place). This is a clean extension:
`src/review/context.js` builds the user prompt; add image attachments there and
have the backend pass them through. Keep it behind a flag because not every
backend/model accepts images and it raises cost.

## One-line summary
Deterministic ffmpeg/hash/MediaPipe vision indexes **all** footage cheaply and
frame-accurately; a VLM is spent only on a few frames of a few segments; the
review agent reasons over those outputs (and, optionally, a few keyframes) with
your case knowledge. The original file is only ever read.
