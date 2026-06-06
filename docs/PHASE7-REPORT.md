# Phase 7 — Final Report
Generated: 2026-06-05

---

## Environment

| Item | Value |
|------|-------|
| OS | Windows 10 Home 10.0.19045 |
| Python | 3.12.3 (conda-forge, MSC v.1938 64-bit) |
| ffmpeg | C:\Program Files\ffmpeg\...\bin\ffmpeg.exe (2025-05-05 build) |
| sqlite-vec | models/sqlite-vec/vec0.dll — loaded via sqlite3 extension |
| Rust/egui GUI | gui/target/release/forensic-gui.exe — 6.29 MB release binary |
| DB | forensic.db (SQLite + sqlite-vec, 26 tables) |

---

## Models — Status

| Role | Model | Status |
|------|-------|--------|
| ASR | Parakeet-TDT-0.6B-v3 (sherpa-onnx, ONNX int8) | **WIRED** — Python shim `src/asr.js`; smoke-test: test.mp4 → 11 utterances, word timestamps |
| Diarization | sherpa-onnx pyannote-segmentation-3-0 + CAM++ 3D-Speaker | **WIRED** — integrated in ASR/diarization pipeline |
| Speaker ID | CAM++ 3D-Speaker (same ONNX as diarization embedding) | **WIRED** — enroll/match API in sherpa-onnx |
| Active Speaker Detection | LR-ASD | **DEFERRED** — `ASD_BACKEND=none`; ONNX export non-trivial; see `docs/ASD-SETUP.md` |
| Face ID | ArcFace (InsightFace buffalo_l w600k_r50, ONNX) | **WIRED** — adapter seam in `src/identity.js` |
| Text Embeddings | Qwen3-Embedding-0.6B | **WORKING** — `scripts/embed_text.py`; 1024-dim; 11 embeddings in DB |
| Multimodal Embeddings | Qwen3-VL-Embedding-2B | **DEFERRED** — optional per lock; enable after text search validated in production |
| Video Understanding | Qwen3-VL-8B-Instruct (GGUF, Q4, llama.cpp) | **WIRED** — adapter in `src/vision.js`; on-demand only; dense pass deferred |
| Context Review Agent | claude-opus-4-8 (local Claude Code, headless) | **WIRED** — `src/context-review.js`; requires real case prompt in config |

---

## Pipeline Stages — Status

| Stage | Code | DB evidence | Status |
|-------|------|-------------|--------|
| 0 — Ingest + hash | `src/ingest.js` | `sources` table, sha256 keyed | PASS |
| 1 — Frame extraction + scene cut | `src/frames.js` | `media_segments`, `frame_signatures` | PASS |
| 2 — ASR + diarization | `src/asr.js` (sherpa-onnx) | 11 utterances in `utterances` | PASS |
| 3 — Embeddings | `scripts/embed_text.py` | 11 text embeddings in `embeddings_meta` | PASS |
| 4 — Search | `src/search.js` + sqlite-vec KNN | Query returns 11 ranked hits with cosine scores | PASS |
| 5 — Identity / location | `src/identity.js` | `identity_enrollments`, `known_locations` exist | WIRED (no enrollments yet — user adds reference faces/voices) |
| 6 — Context review | `src/context-review.js` | `context_annotations` table exists | WIRED (requires real case prompt — see below) |

---

## GUI — Phase 5 (Native Rust egui)

- Binary: `gui/target/release/forensic-gui.exe` (6.29 MB, eframe 0.29 + wgpu)
- Launch: `.\gui\target\release\forensic-gui.exe`
- Features: search bar, KNN results list, result selection, video preview panel (CYAN-bordered placeholder), transport controls, Clip (ffmpeg), Queue, Stitch (ffmpeg concat), Confirm/Reject/Set-Speaker DB actions
- CLI: `--initial-query <text>` pre-populates query and fires auto-search on first frame

---

## Phase 6 — Self-Verification (7/7 PASS)

```
Phase 6 — 7/7 PASS
========================================
[PASS] (0) App launches
[PASS] (a) Search — 11 text embeddings in DB
[PASS] (b) Select result (screenshot taken)
[PASS] (d) Clip creates file — ['test_1-10.mp4']
[PASS] (e) Stitch output exists — osint-export/clips/stitched_output.mp4
[PASS] (f) Confirm decreases needs_review — 9 -> 8
[PASS] source file untouched
```

Verified by `tools/ui_verify/phase6_verify.py` using Win32 PrintWindow (GPU capture) + numpy color detection. Screenshots: `tools/ui_verify/runs/00_launch.png` through `06_final.png`.

---

## What Works Right Now

- Drop a video → hash → transcribe with word timestamps → diarize → embed all utterances
- Natural-language query → KNN search → ranked results with similarity scores
- Select a result → view file, timestamp, speaker, confidence
- Clip a result to `osint-export/clips/` via ffmpeg
- Queue multiple results → stitch into a single export file
- Confirm/Reject a result → sets `needs_review` flag in DB
- Provenance: every write carries source sha256, model id, and timestamp
- GUI self-verification: fully automated, screenshot-driven, no browser

---

## What Is Deferred

| Item | Why | How to unblock |
|------|-----|----------------|
| ASD (LR-ASD ONNX) | PyTorch→ONNX export non-trivial | See `docs/ASD-SETUP.md` |
| Multimodal embeddings (Qwen3-VL-Embedding-2B) | Marked optional in lock; enable after text search validated | Set `MULTIMODAL_EMBED=1` in `.env` and run pipeline |
| Dense VLM pass (Qwen3-VL-8B) | Too slow for full video; on-demand only | Trigger in `src/vision.js` on `needs_review=1` segments |
| libmpv frame-accurate player | GUI shows static preview; clip/stitch work | Integrate `libmpv2` crate per `docs/GUI.md` |
| Face/voice enrollment | Schema and adapter seams are ready; no reference data yet | Add reference images/clips via enroll API |

---

## User Action Required

### 1. `config/context-review.prompt.md` — fill with real case knowledge
Currently a placeholder. Add known entities, disputed claims, locations of interest, and what to flag. This drives the Stage 6 context-review agent.

### 2. `config/taxonomy.json` — replace with real entity names
Currently an example. Add actual person names, locations, and roles for your investigation.

### 3. Identity enrollments
To enable face/speaker matching, enroll reference material:
```bash
node src/identity.js enroll --type face --name "Subject A" --image ref.jpg
node src/identity.js enroll --type voice --name "Subject A" --clip ref.wav
```
No code changes required — schema and adapter seams are ready.

---

## Re-running

Pipeline is idempotent (keyed by sha256 in `sources`). To process new footage:
```bash
node src/orchestrator.js path/to/new-footage.mp4
```

To re-run Phase 6 verification:
```bash
.venv/Scripts/python.exe tools/ui_verify/phase6_verify.py
```
