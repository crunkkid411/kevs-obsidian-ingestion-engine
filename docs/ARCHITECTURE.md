# Forensic Video Ingestion Architecture

> **Status:** design + foundational implementation. Some runtime model
> integrations are stubbed with clear contracts and must be wired up on the
> Windows machine that has the GPU and the footage (see `docs/SETUP-WINDOWS.md`).
> Nothing in this document was executed against real footage or a GPU in the
> environment where it was written — treat performance/cost numbers as estimates
> to validate locally.

## What this repo was vs. what this turns it into

The original "Kev's Obsidian Ingestion Engine" is a **generic marketing-content
classifier**: pull videos from Dropbox → Whisper transcript → 6 OpenCV key
frames → one Claude call that labels the whole video against a taxonomy → write
an Obsidian note + a Postgres row → **delete the local file**.

That design is wrong for an evidentiary use case in three load-bearing ways:

1. **It destroys the source.** `src/batch.js` calls `fs.unlink(localPath)` after
   every video. For evidence, the source files are the artifact. They must be
   treated as immutable, hashed, and never modified or deleted by the tool.
2. **It classifies whole videos, not moments.** A 5-hour livestream gets one
   row. You cannot answer "pull up every moment he refers to his wife" from a
   single per-video label. Search has to operate at the **segment / utterance**
   level with timestamps.
3. **It has no provenance and no notion of confidence.** A single LLM call emits
   "key_quotes" with a guessed speaker. In a criminal matter, every derived
   claim needs to record *which model produced it, from what input, and whether
   a human verified it* — and AI inferences must be visibly separated from
   ground truth.

This architecture keeps the good bones (config-driven taxonomy, Postgres index,
Obsidian output) and rebuilds the pipeline around **chain of custody,
segment-level indexing, audio-visual speaker attribution, and semantic search.**

---

## Core principles

> **This is an investigative triage tool, not a court-evidence generator.**
> Nothing it outputs goes to court on its own — detectives verify every item (in
> real time, by playing the exact clip) and decide what matters. That changes the
> posture from "refuse to guess" to **"state the best-supported conclusion in
> plain language, with a confidence, and make it trivial to verify."**

1. **Sources are immutable.** We read, hash (SHA-256), and never write to or
   delete the originals. Everything derived lives in a separate store keyed by
   the source hash.
2. **Everything is provenanced.** Every conclusion records: source file + hash,
   exact time span (and frame indices where visual), the model name + version,
   the inputs/params, the raw model output, a `determinism` flag, and a
   **confidence**. Provenance is what lets a human verify *and* lets us measure
   accuracy — it is not a reason to withhold a conclusion.
3. **Name things in natural language. Conclude when the data supports it.**
   "Defendant at home, 0:14:32" — not "Speaker 1 in a descriptive indoor
   background." The system uses the **knowledge base** (enrolled people, voices,
   faces, known locations) plus multiple corroborating data points to assign
   real names and places. It falls back to description ("unidentified male,
   unknown indoor location") **only when it genuinely has no match** — and those
   fall-backs are the to-do list, not the default.
4. **Naming makes errors visible; vagueness hides them.** If the system names the
   defendant and is wrong, the reviewer sees it instantly and we can tune. If it
   only ever says "a speaker," a 50%-miss rate is invisible. So we prefer a
   confident, checkable name over a safe-sounding non-answer. Confidence scores +
   coverage stats (e.g. "defendant recognized in 47/92 videos") turn mistakes
   into a feedback signal.
5. **Verification happens at the moment of reading.** Every searched quote,
   speaker, or location is one click from the exact frame in the player. Being
   occasionally wrong is cheap because confirmation is immediate; that is the
   whole point of the multi-step, human-in-the-loop design.
6. **The system learns.** Confirmed identities/locations are enrolled and
   propagated across the corpus; a periodic **consolidation pass** merges
   clusters, applies confirmed names everywhere they match, learns new aliases,
   and reports coverage gaps. (See `docs/IDENTITY.md`.)
7. **Reproducibility.** A run is described by config (models, versions, params)
   recorded into the DB so any output can be regenerated and audited.

---

## Pipeline overview

```
                          ┌─────────────────────────────────────────┐
                          │  STAGE 0 — INTAKE (deterministic)         │
 local hard drive  ─────► │  walk dir, SHA-256 each file, ffprobe     │
 (read-only)              │  metadata, register in `sources`,         │
                          │  write chain_of_custody row. NEVER edits  │
                          │  or deletes the original.                 │
                          └───────────────────┬───────────────────────┘
                                              │
        ┌──────────────────────────────┬──────┴───────────────┬───────────────────────────┐
        ▼                              ▼                      ▼                           ▼
┌───────────────┐            ┌──────────────────┐   ┌──────────────────┐        ┌──────────────────┐
│ STAGE 1 AUDIO │            │ STAGE 2 VISUAL    │   │ STAGE 3 DIARIZE  │        │ (timing source)  │
│ demux wav     │            │ frame-accurate    │   │ Sortformer (audio│        │                  │
│ 16k mono      │            │ extraction at true│   │ 4-spk) → speaker │        │                  │
│ (deterministic)│           │ fps + scene cuts  │   │ turns w/ times   │        │                  │
└──────┬────────┘            │ (deterministic)   │   └────────┬─────────┘        │                  │
       │                     └─────────┬─────────┘            │                  │                  │
       ▼                               │                      │                  │                  │
┌───────────────┐                      │                      │                  │                  │
│ STAGE 1b ASR  │                      │                      │                  │                  │
│ parakeet-v3   │                      │                      │                  │                  │
│ word+seg times│                      │                      │                  │                  │
│ (deterministic│                      │                      │                  │                  │
│  token timing)│                      │                      │                  │                  │
└──────┬────────┘                      │                      │                  │                  │
       │                               ▼                      ▼                  │                  │
       │              ┌──────────────────────────────────────────────┐          │                  │
       └─────────────►│ STAGE 4 — SPEAKER ATTRIBUTION (audio+visual)    │◄────────┘                  │
                      │ For each diarized turn, find the on-screen      │                             │
                      │ face whose lip motion matches the speech        │                             │
                      │ (active-speaker detection). Reconcile audio     │                             │
                      │ cluster ↔ visible person ↔ known identity.      │                             │
                      │ Emits utterances with speaker + CONFIDENCE +    │                             │
                      │ conflict flags.  [model_inference]              │                             │
                      └───────────────────────┬────────────────────────┘                             │
                                              │                                                       │
                      ┌───────────────────────▼────────────────────────┐                             │
                      │ STAGE 5 — SEGMENTATION + EMBEDDINGS             │                             │
                      │ chunk into utterance/topic segments; embed text │                             │
                      │ (Qwen3-Embedding) + key frames (Qwen3-VL-Embed) │                             │
                      │ into pgvector. (deterministic given the models) │                             │
                      └───────────────────────┬────────────────────────┘                             │
                                              │                                                       │
                      ┌───────────────────────▼────────────────────────┐                             │
                      │ STAGE 6 — UNDERSTANDING (triaged, on flagged    │                             │
                      │ segments or on-demand): Qwen3-VL-8B local for   │                             │
                      │ scene/event description + temporal grounding;   │                             │
                      │ API (Qwen3.5-Omni / Gemini) for hard segments.  │                             │
                      │ [model_inference, confidence-scored]            │                             │
                      └───────────────────────┬────────────────────────┘                             │
                                              │                                                       │
                      ┌───────────────────────▼────────────────────────┐                             │
                      │ STAGE 7 — ENTITY / REFERENCE RESOLUTION         │                             │
                      │ map nicknames, descriptions, oblique references │                             │
                      │ ("my ex", "the 4 months ago thing") to known    │                             │
                      │ entities using a rules + timeline + LLM layer.  │                             │
                      │ Every link stored with rationale + confidence.  │                             │
                      │ [model_inference, human-review gated]           │                             │
                      └───────────────────────┬────────────────────────┘                             │
                                              │                                                       │
                      ┌───────────────────────▼────────────────────────┐                             │
                      │ OUTPUTS: Postgres (queryable) + Obsidian notes  │                             │
                      │ + semantic search CLI/API. Every claim links    │                             │
                      │ back to source hash + timestamp + model.        │                             │
                      └─────────────────────────────────────────────────┘                            │
```

Stages 0–3, 5 are **deterministic given fixed models** and pipe automatically.
Stages 4, 6, 7 are **model inferences** — they write confidence + provenance and
can be re-run or human-corrected without touching the deterministic layers.

---

## The two hard problems, and how the design addresses them

### Problem A — "Who is actually speaking?" (misattribution)

Audio-only diarization (pyannote, or ElevenLabs' service) clusters voices but
doesn't *know who is on screen*. In livestreams with overlapping talk, callers,
clips, and background audio it mislabels turns — and a mislabeled turn becomes a
misattributed quote.

**Design:** treat attribution as a *reconciliation* of three independent signals,
each stored separately so a human can audit the join:

- **Audio diarization** (`nvidia/diar_streaming_sortformer_4spk-v2.1`): voice
  cluster + turn timestamps.
- **Active-speaker detection (visual):** for the turn's time span, detect faces,
  track them, and score lip-motion-vs-audio synchrony (MediaPipe face mesh +
  an ASD model). The face that "lights up" in sync is the visible speaker.
- **Known-identity match:** is that face/voice one of the `people_of_interest`?

The pipeline records the *agreement* between these. High agreement → high
confidence. Disagreement (voice says speaker A, the only visible synced face is
B, off-screen audio, etc.) → **flagged for human review**, never auto-attributed.
See `docs/MODELS-2026.md` for the specific models and the ASD approach.

### Problem B — Oblique / contextual reference ("my ex" = his wife)

This is genuinely an inference problem and must be handled as one, with a paper
trail:

1. **Retrieve**, don't keyword-match. Segment embeddings (Qwen3-Embedding) let
   "pull up every stream where he mentions his wife" return segments that *mean*
   that even when the words differ.
2. **Resolve with rules + timeline + LLM.** An `entities` table holds each person
   with aliases, nicknames, physical descriptions, and **timeline anchors**
   (e.g. "separated ~Feb 2026"). A resolution step proposes links from a segment
   to an entity, using the known timeline (a video posted 4 months after the
   split that says "imagine if my ex was harassing me, it's been like 4 months"
   → candidate link to the wife) and writes a **rationale + confidence**.
3. **Never hard-assert.** The link is stored as a *claim* with its evidence,
   reviewable and overridable. Search can include or exclude unreviewed inferences.

**This is implemented as the context-review agent (STAGE 7).** A separate pass
(`npm run review`) sends each video's transcript + data points, plus your
editable **case-context prompt**, to ONE agent per file (your local Claude Code
instance for sensitive context, or an API model for testing). It writes
`context_annotations` — reference resolutions, contradictions, notable moments —
each with rationale + confidence, flagged for review. See `docs/CONTEXT-REVIEW.md`.

---

## Data model (see `src/db/schema.sql`, and `src/db/schema.sqlite.sql` for the native default)

| Table | Grain | Purpose |
|---|---|---|
| `sources` | one video file | immutable record: path, **sha256**, ffprobe metadata, duration, fps, resolution |
| `chain_of_custody` | event | append-only log: ingested/processed/exported, who/what/when, model+version |
| `media_segments` | time span | shot/scene/utterance windows with start/end + frame indices |
| `transcript_words` | word | ASR token with precise start/end (deterministic timing) |
| `utterances` | speech turn | text + **speaker_name** + confidence + attribution provenance + conflict flags |
| `speakers` | voice/person within a source | diarization cluster, linked (maybe) to an entity |
| `entities` | person/place/thing | canonical name, aliases, nicknames, descriptions, **timeline anchors** |
| `reference_resolutions` | claim | segment → entity link with rationale + confidence + review status |
| `visual_observations` | frame/segment | model description of what's on screen, with model provenance |
| `embeddings` | segment/frame | pgvector / sqlite-vec vectors for text + multimodal search |
| `inferences` | claim | generic model-inference record: input refs, model, prompt, raw output, confidence, reviewed_by |
| `events` | time span | the **"20% nuance"**: second_speaker / phone_call / location_change / multi_face |
| `locations_of_interest` | time span | OSINT handoff: exported frame + **location_name** + provenance |
| `frame_signatures` | frame | perceptual hashes for cross-video fixture / location matching |
| `clips` | in/out span | human-created evidence clips from the player |
| `identity_enrollments` | print | confirmed voice/face prints per entity (the knowledge base) |
| `known_locations` | place | named places + reference perceptual hashes ("Defendant's home") |
| `context_annotations` | claim | per-media case-aware review: reference resolutions, contradictions, notable moments + rationale + confidence (see `docs/CONTEXT-REVIEW.md`) |

Every non-deterministic row carries `model_name`, `model_version`, `params`,
`confidence`, `determinism`, and `reviewed_by` / `reviewed_at`. Naming + the
knowledge base are detailed in `docs/IDENTITY.md`.

---

## Why local-first + API triage (not "VLM every frame")

Dense 30fps vision-model captioning of 100+ hours is impractical (cost and time)
and unnecessary. The precision you need ("30fps") is about **frame-accurate
extraction and timestamps**, not about asking an LLM to look at every frame. So:

- **Deterministic dense pass over everything:** frame-accurate decode, scene/shot
  cuts, ASR with word timings, audio diarization, embeddings. Cheap, runs
  overnight, fully local. This alone makes the archive searchable.
- **Targeted understanding pass:** run the heavy video model only on segments a
  query or a flag points at (a flagged turn, a search hit you're drilling into).
  Local `Qwen3-VL-8B` for most of it; API (`Qwen3.5-Omni` / Gemini) for the
  hardest segments. This is where the 8GB VRAM budget actually holds.

Model choices, VRAM math, and cost estimates are in **`docs/MODELS-2026.md`**.

---

## Search ("get actual data out")

Two query paths, both returning **source + timestamp + provenance** so a hit is
immediately verifiable:

- **Semantic:** embed the query, ANN search over `embeddings`, return ranked
  segments with their utterances and a deep link to the exact timestamp.
- **Structured:** SQL over `entities` / `utterances` / `reference_resolutions`
  ("every utterance attributed to X with confidence > 0.8", "every segment
  resolved to the wife entity, including unreviewed inferences").

Obsidian remains a *human-review surface* (notes per source/segment with
backlinks, embedded thumbnails, and review checkboxes), but it is no longer the
system of record — Postgres is. You are not locked into Obsidian.

---

## Implementation status in this branch

| Piece | Status |
|---|---|
| Local read-only source + SHA-256, no deletion | implemented (`src/sources/local.js`) |
| Frame-accurate extraction at true fps + scene cuts | implemented (`scripts/extract_frames.py`) |
| Forensic Postgres schema + provenance | implemented (`src/db/schema.sql`) |
| Config / `.env` / requirements for the 2026 stack | implemented |
| Investigation taxonomy example | implemented (`config/taxonomy.investigation.example.json`) |
| Model research + recommendations | implemented (`docs/MODELS-2026.md`) |
| ASR / diarization / ASD / video / embedding adapters | **contracts + stubs** — wire on Windows |
| Stage orchestrator (deterministic auto-pipe + gated LLM) | **scaffold** — see `src/pipeline/` |
| Semantic search CLI | **scaffold** |

The legacy generic engine files (`src/transcribe`, `src/vision/frames.js`,
`src/classify`, `src/markdown`, `src/sources/dropbox.js`, old `src/batch.js`)
are left in place for reference but are superseded by the forensic pipeline for
this use case.
