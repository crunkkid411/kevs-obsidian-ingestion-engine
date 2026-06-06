# Native-first stack (no Python runtime, no web, lean on 8 GB)

This revises `docs/MODELS-2026.md` for your stated preference: **C/C++/Rust/Go/
ONNX over Python and web**, single investigator on one machine, ruthlessly
accurate, no bloat. The *model choices* don't change; the **runtimes** do — we
drop NeMo/PyTorch/sentence-transformers/MediaPipe in favor of ONNX/GGUF engines
with native bindings. The JS pipeline in this repo is a **reference/prototype**
(its deterministic core is tested); the native build below is the production target.

> **Important correction discovered during research:** NVIDIA **Sortformer's ONNX
> export is currently broken** (dynamic slicing/reshape ops aren't ONNX-friendly —
> NeMo issues [#15077](https://github.com/NVIDIA-NeMo/NeMo/issues/15077),
> [#15536](https://github.com/NVIDIA-NeMo/NeMo/issues/15536)). So for a *native*
> stack, do **not** route diarization through Sortformer-ONNX yet. Use
> **sherpa-onnx**'s diarization (segmentation + speaker-embedding clustering),
> which is pure ONNX/C++, has no 4-speaker cap, and already ships. Revisit
> Sortformer if/when its ONNX path lands.

## The stack

| Job | Native engine | Language / binding | Model (ONNX/GGUF) | Notes |
|---|---|---|---|---|
| **ASR** | **sherpa-onnx** | C++ core; Rust/Go/C bindings | Parakeet-TDT-0.6b ONNX (you already use Parakeet ONNX) | offline, word timestamps, VAD included. ([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)) |
| **VAD (chunking)** | sherpa-onnx (Silero VAD) | same | silero ONNX | silence-boundary chunking of long streams |
| **Speaker diarization** | **sherpa-onnx diarization** | same | pyannote-segmentation ONNX + 3D-Speaker embedding ONNX | native, no Sortformer, no 4-spk cap. ([k2-fsa](https://github.com/k2-fsa/sherpa-onnx)) |
| **Visual active-speaker (the misattribution fix)** | **onnxruntime via `ort`** | Rust | LR-ASD exported to ONNX + a small face detector (e.g. SCRFD/YOLO-face ONNX) | runs only on multi-face / second-speaker segments. ([LR-ASD](https://github.com/Junhua-Liao/LR-ASD), [ort](https://github.com/pykeio/ort)) |
| **Speaker identification (voice print → name)** | **sherpa-onnx** speaker ID | C++/Rust/Go | WeSpeaker / 3D-Speaker ONNX | built-in enrollment API; same engine as diarization. Turns a cluster into "Defendant". ([sherpa speaker-id](https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html)) |
| **Face identification (face print → name)** | **`face_id` crate** (SCRFD + ArcFace) via `ort` | Rust | InsightFace buffalo_l / ArcFace ONNX (512-dim) | cosine match vs enrolled faces; names the on-screen person. ([face_id](https://docs.rs/face_id), [arcface-onnx](https://huggingface.co/garavv/arcface-onnx)) |
| **Text embeddings** | **fastembed-rs** (candle) *or* **llama.cpp** server | Rust *or* C++ | Qwen3-Embedding-0.6B (ONNX via fastembed `qwen3` feature, or GGUF) | fastembed-rs supports Qwen3 behind the `qwen3` feature. ([fastembed-rs](https://github.com/Anush008/fastembed-rs)) |
| **Multimodal (scenery) embeddings** | fastembed-rs (candle) | Rust | Qwen3-VL-Embedding-2B | text+image in one space for "the kitchen at night". ([fastembed-rs](https://github.com/Anush008/fastembed-rs)) |
| **Video understanding (on-demand only)** | **llama.cpp** | C++ / GGUF | Qwen3-VL-8B-Instruct GGUF (Q4) | frames→images workflow; API for hard hours. ([Qwen3-VL GGUF](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF)) |
| **Frame fingerprint / location matching** | **ffmpeg** (`signature` filter) + 64-bit aHash | native CLI / Rust | — | MPEG-7 video signature is Hamming-comparable; aHash for room-change. ([ffmpeg signature](https://ffmpeg.org/ffmpeg-filters.html#signature)) |
| **Frame-accurate cut/clip** | **auto-editor** (Nim) — you have it | CLI | — | more precise cutting than raw ffmpeg; drive it from the player for evidence clips |
| **Storage + vector search** | **SQLite + sqlite-vec** | C extension; Rust `rusqlite` / Go | — | in-process, no server. Brute-force vec search is ms-range at this scale. ([sqlite-vec](https://github.com/asg017/sqlite-vec)) |
| **Investigator GUI** | **local web app** (Rust/axum or Go backend + HTML/CSS/JS) | Rust/Go + web | — | localhost UI over the DB + query agent; HTML5 video (WebCodecs for frame-step); clip/stitch via auto-editor. **Web (not native egui) so the build self-verifies via browser automation** — see `docs/GUI.md`. Native alt: Tauri / libmpv+egui. |
| **UI self-verification** | **Playwright MCP** / browser-harness | — | — | drives the local web UI for BUILD.md Phase 6. Native fallback: Windows-MCP + pywinauto (UIA), not pyautogui. |

## Why these

- **sherpa-onnx** is the keystone: one offline ONNX engine that does ASR +
  diarization + VAD with **C++/Rust/Go** bindings and runs on CPU or modest GPU.
  It removes the entire Python/NeMo dependency for the audio pipeline and already
  has a Parakeet-TDT runtime (you're on Parakeet ONNX today, so this is a small step).
- **sqlite-vec** kills the Postgres server. For one investigator this is the
  difference between "double-click an app" and "manage a database." No ANN index
  yet, but brute-force over a few hundred-thousand vectors is milliseconds.
- **libmpv** is *the* frame-accurate engine; **egui** gives a native, immediate-mode
  GPU UI with no web stack. **auto-editor** (which you already run) does the actual
  evidence-grade cutting.
- **ffmpeg `signature`** is built-in, native, and purpose-built for "does this
  scene/fixture recur" — exactly the OSINT corroboration the detectives do by hand.

## What stays API (unchanged from MODELS-2026.md)
Dense long-video understanding and the hardest audio+video reasoning go to
**Qwen3-VL / Qwen3.5-Omni / Gemini** via OpenRouter — only on flagged or queried
segments. 8 GB can't host those locally. The native stack above is for the
**cheap pass over everything**; the API is for the **expensive 1%**.

## Honest caveats
- **LR-ASD has no official ONNX** — you (or local Claude Code) export it with
  `torch.onnx`. It's small; the risk is op coverage. Until it's exported, the
  visual-verification stage stays a stub and every quote is flagged for review.
- **fastembed-rs Qwen3 support is behind a feature flag / candle backend** —
  verify the exact model id loads before committing; llama.cpp's embedding server
  is the fallback (note its Qwen3-Embedding quirk in [llama.cpp #20085](https://github.com/ggml-org/llama.cpp/issues/20085)).
- **sqlite-vec dimension is fixed at table creation** — set it to your embedding
  model's dim (1024 for Qwen3-Embedding-0.6B) and re-create if you switch models.

## Sources
- sherpa-onnx — https://github.com/k2-fsa/sherpa-onnx
- parakeet-rs (alt native ASR+diarization) — https://github.com/altunenes/parakeet-rs
- Sortformer ONNX export issues — https://github.com/NVIDIA-NeMo/NeMo/issues/15077 , https://github.com/NVIDIA-NeMo/NeMo/issues/15536
- sqlite-vec — https://github.com/asg017/sqlite-vec
- sqlite-vector (ANN alt) — https://github.com/sqliteai/sqlite-vector
- fastembed-rs — https://github.com/Anush008/fastembed-rs
- llama.cpp embeddings note — https://github.com/ggml-org/llama.cpp/issues/20085
- Qwen3-VL multimodal embedding in llama.cpp — https://github.com/ggml-org/llama.cpp/discussions/19516
- ort (ONNX Runtime for Rust) — https://github.com/pykeio/ort
- LR-ASD — https://github.com/Junhua-Liao/LR-ASD
- libmpv Rust bindings — https://github.com/Cobrand/mpv-rs , https://docs.rs/libmpv
- egui — https://github.com/emilk/egui
- ffmpeg signature filter — https://ffmpeg.org/ffmpeg-filters.html#signature
