# Model & Pipeline Research for Video-Forensics Ingestion (June 2026)

> **Who this is for:** A non-developer investigative journalist organizing ~500 GB / 100+ hours of video as evidence in a criminal investigation, on a Windows 10 PC with an **8 GB VRAM** GPU, an **OpenRouter** API key, and **qwen-cli**.
>
> **Goal:** A **local-first** pipeline, with API used selectively for the expensive steps. The four big pains this document targets:
> 1. **Transcription quality** (currently parakeet-v2 ONNX).
> 2. **Speaker diarization is unreliable** (pyannote, ElevenLabs both buggy) and has caused **quote MISATTRIBUTION** — we want **visual** verification of who is actually speaking on screen.
> 3. **Imprecise frame extraction** — need true ~30 fps frame accuracy.
> 4. **Contextual / semantic search** where references are oblique (nicknames, inside jokes — e.g. "my ex" actually meaning his wife).
>
> **Big-picture recommendation (read this first):** Do a **cheap deterministic pass over everything** (ASR + audio diarization + visual speaker verification + shot detection + frame indexing + embeddings), then spend expensive **video-understanding** compute only on **flagged or queried** segments. Running a vision-language model densely over 100 hours at 30 fps is neither affordable nor necessary — see [Section 5](#5-recommended-strategy-triage-not-brute-force).

---

## 1. TL;DR — Recommended Stack

| Task | Recommended model | Local on 8 GB VRAM? | API alternative | Why |
|---|---|---|---|---|
| **ASR (transcription)** | **NVIDIA Parakeet-TDT-0.6B-v3** (upgrade from your v2) | ✅ Yes — 600M params, runs comfortably | **Qwen3-ASR-Flash** (~5.63% WER, 52 langs) | v3 ≈ **6.34% avg WER**, multilingual, auto language ID, handles long audio. Beats Whisper-large-v3 (7.44%) and ~10× faster class. ([HF](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [Gladia](https://www.gladia.io/blog/best-open-source-speech-to-text-models)) |
| **Speaker diarization (audio)** | **NVIDIA Sortformer `diar_streaming_sortformer_4spk-v2.1`** | ✅ Yes — small, streaming, ≤4 speakers | (rarely needed via API) | Open ASR models do **not** diarize. Sortformer pairs with Parakeet for speaker-attributed words **without pyannote**. ([HF](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1)) |
| **Active-speaker VISUAL verification** | **LR-ASD** (a.k.a. Light-ASD, IJCV 2025) + **MediaPipe** face/lip landmarks | ✅ Yes — lightweight, runs near-real-time | — | **This is the fix for misattribution.** Confirms which on-screen face's lips move with the audio. ([LR-ASD](https://github.com/Junhua-Liao/LR-ASD), [arXiv 2408.12102](https://arxiv.org/html/2408.12102v1)) |
| **Video understanding / temporal grounding** | **Qwen3-VL-8B-Instruct (GGUF, Q4)** for short clips/frames | ⚠️ Partial — short clips/frames only on 8 GB | **Qwen3-VL** via OpenRouter, or **Qwen3.5-Omni** / **Gemini 2.5** for dense long video | Text–Timestamp Alignment gives **second-level event localization**; 256K context. Hours-long dense video needs API or overnight chunking. ([HF](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct), [report](https://arxiv.org/pdf/2511.21631)) |
| **Text embeddings (semantic transcript search)** | **Qwen3-Embedding-0.6B** (or 4B if it fits) | ✅ Yes — 0.6B/4B fit 8 GB, 32K context | Qwen3-Embedding-8B via API | #1 on MTEB multilingual (8B = 70.58). Catches oblique references when paired with good chunking + an LLM query-expansion step. ([HF](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)) |
| **Multimodal embeddings (search by scenery + text)** | **Qwen3-VL-Embedding-2B (4-bit AWQ)** | ✅ Yes — AWQ-4bit build fits 8 GB | Qwen3-VL-Embedding-8B via API | Lets you search visual scenes and text in **one** vector space ("the kitchen argument"). ([HF](https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B), [AWQ build](https://huggingface.co/LifetimeMistake/Qwen3-VL-Embedding-2B-AWQ-4bit)) |
| **Reranking** | **Qwen3-Reranker-0.6B / 4B** (same family) | ✅ Yes | Qwen3-Reranker-8B via API | Re-orders top-k retrieval hits before you read them — big precision win for oblique queries. ([BentoML guide](https://www.bentoml.com/blog/a-guide-to-open-source-embedding-models)) |

**One-line summary of the stack:** Parakeet-v3 (ASR) → Sortformer (audio diarization) → LR-ASD + MediaPipe (visual speaker check) → shot detection + frame index → Qwen3 text + multimodal embeddings (search) → Qwen3-VL **only on demand** for the hard "what is happening here" questions.

---

## 2. Hardware Reality on 8 GB VRAM

8 GB is enough to run a **genuinely good** forensic pipeline locally — *as long as you don't try to do dense video understanding locally*. Here is the honest split.

### Fits locally on 8 GB (run these on everything)

| Component | Approx. footprint | Notes |
|---|---|---|
| Parakeet-TDT-0.6B-v3 (ASR) | ~1.5–2.5 GB | 600M params; long audio via local-attention mode (up to ~3 hr). |
| Sortformer 4-spk diarization | ~1–2 GB | Streaming, ≤4 speakers. |
| LR-ASD + MediaPipe (visual ASD) | ~1–2 GB (often CPU-friendly) | MediaPipe face/lip landmarks are light; LR-ASD is deliberately small. |
| Qwen3-Embedding-0.6B | ~1–1.5 GB | 4B fits too if run alone; 0.6B is the safe default. |
| Qwen3-VL-Embedding-2B-AWQ-4bit | ~2–3 GB | 4-bit AWQ specifically chosen to fit 8 GB. |
| Qwen3-VL-8B-Instruct GGUF **Q4** | ~5.5–6.5 GB weights + KV/vision overhead | **Tight.** Works for **short clips / a handful of frames**, not hours. See caveat below. |

**Rule of thumb:** run these **one stage at a time** (sequential batch jobs), not all at once. The pipeline is a conveyor belt, not a single mega-process.

### Must be API, chunked, or overnight

| Component | Why it doesn't fit | What to do instead |
|---|---|---|
| **Qwen3.5-Omni (30B MoE, 3B active)** | INT4 GGUF ≈ **15 GB** → needs **24 GB+** VRAM. SOTA on 32/36 audio-video benchmarks but **not** an 8 GB local model. | Use via **API** for the hardest "watch + listen + reason" segments. ([HF](https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct), [arXiv](https://arxiv.org/abs/2509.17765)) |
| **Dense long-video understanding** (whole livestreams) | A 3-hour stream is enormous in frames/tokens; even Qwen3-VL-8B can't cheaply chew hours locally. | **API** for flagged segments, or **overnight** local batches on short clips. |

### GGUF / llama.cpp vision-encoder caveat (validate this)

- Qwen3-VL GGUF builds **are** published (official, unsloth, lmstudio-community) and llama.cpp loads VLMs via a separate **`mmproj`** (multimodal projector) file alongside the main weights. Q4/Q5 are supported, and you can mix precision between the language and vision parts. ([HF GGUF](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF), [Unsloth run guide](https://unsloth.ai/docs/models/qwen3-vl-how-to-run-and-fine-tune))
- **Caveat to test on your machine:** llama.cpp's **video** path (multi-frame temporal handling, the Interleaved-MRoPE / timestamp-alignment behavior) is newer and less battle-tested than its **image** path. In practice, the reliable local pattern is: **you** extract frames at known timestamps (with FFmpeg) and feed a small set of images to Qwen3-VL, rather than handing it a raw video and trusting the encoder to sample it. There's active llama.cpp work on Qwen3-VL multimodal/embeddings ([discussion](https://github.com/ggml-org/llama.cpp/discussions/19516)). **Assume image-frame mode works; verify video mode before relying on it.**
- Windows prebuilt llama.cpp binaries with CUDA are available, so you don't need to compile. ([build note](https://knightli.com/en/2026/05/18/llama-cpp-windows-cuda-vulkan-gguf/))

---

## 3. Per-Task Deep Dives

### 3.1 ASR — upgrade Parakeet v2 → v3

You're already on the right family. Move from **parakeet-tdt-0.6b-v2** to **v3**:

- **600M** params, FastConformer-TDT, **25 European languages with automatic language detection**, up to **24 min full-attention** / **~3 hr local-attention** per pass, **6.34% avg WER** on the HF Open ASR Leaderboard. ([HF](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3))
- Context on the field: Parakeet v3 ~6.32%, Whisper-large-v3 7.44%, Qwen3-ASR ~5.63% (52 langs), Canary-1B-v2 beats Whisper ~10× faster. **Whisper is no longer the best local ASR.** ([Gladia](https://www.gladia.io/blog/best-open-source-speech-to-text-models), [Northflank](https://northflank.com/blog/best-open-source-speech-to-text-stt-model-in-2026-benchmarks))
- **For court-grade accuracy on key clips:** run **Qwen3-ASR-Flash** via API as a second opinion and diff the two transcripts; disagreements flag spots a human should re-listen to.
- **Practical tip:** for the long livestreams, chunk audio on **silence boundaries** (VAD), not fixed time, so you don't cut words. Keep the original timestamps so transcript ↔ video stays aligned to the frame.

### 3.2 Speaker diarization (audio) — replace pyannote with Sortformer

- Open ASR models do not diarize; that's why bolting pyannote/ElevenLabs on has been flaky.
- **`nvidia/diar_streaming_sortformer_4spk-v2.1`** is a NeMo streaming diarizer (FastConformer/NEST), **≤4 speakers**, that pairs with Parakeet for speaker-attributed words. ([HF](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1))
- **`parakeet.cpp`** already integrates **Sortformer** (its converter lists a `sortformer` model type) to produce speaker-attributed words **without pyannote**, in pure C++ — a clean, dependency-light path. ([repo](https://github.com/Frikallo/parakeet.cpp), [comparison](https://modelslab.com/blog/audio-generation/parakeet-cpp-vs-whisper-self-hosted-asr-comparison-2026)) Related ecosystem tools: [parakeet-rs](https://github.com/altunenes/parakeet-rs), [NeMo diarization-for-v3 thread](https://github.com/NVIDIA-NeMo/NeMo/discussions/14842).
- **Hard limit to respect:** Sortformer 4-spk handles **up to 4** speakers. Many livestreams have more (guests, chat callouts, crowds). When speaker count exceeds 4, audio-only diarization **will** mislabel — which is exactly why the **visual** layer below is mandatory, not optional.

### 3.3 Active-speaker VISUAL verification — the misattribution fix ⚠️

**This is the most important section for your evidence problem.** Audio-only diarization tells you "Speaker A vs Speaker B," but it does **not** tell you *which human on screen* that is — and getting that wrong is how a quote gets misattributed. The fix is **Active Speaker Detection (ASD)**: combine the audio with **lip-motion / facial-landmark** cues to confirm that the on-screen face's mouth is actually moving in sync with the words.

**Recommended visual layer:**
- **LR-ASD / Light-ASD** (IEEE CVPR 2023 → IJCV 2025): lightweight, robust, **state-of-the-art mAP**, weights published, runs near-real-time on modest hardware. ([Light-ASD](https://github.com/Junhua-Liao/Light-ASD), [LR-ASD](https://github.com/Junhua-Liao/LR-ASD)) TalkNet-ASD is the classic baseline; LR-ASD is the current lightweight best.
- **MediaPipe** for fast face detection + lip landmarks (to crop each face and measure mouth motion).
- Background / further reading: [Integrating Audio, Visual & Semantic Info for Multimodal Diarization](https://arxiv.org/html/2408.12102v1), AFL-Net (audio+face+lip cross-attention, ICASSP 2024), [3D-Speaker-Toolkit](https://arxiv.org/html/2403.19971v1), [AVA-ActiveSpeaker dataset](https://arxiv.org/pdf/1901.01342).

**Concrete reconciliation pipeline (per segment):**

1. **ASR** — Parakeet-v3 → words + timestamps.
2. **Audio diarization** — Sortformer → audio speaker labels (A/B/C/D) per word.
3. **Frame extraction** — FFmpeg pulls frames at the segment's timestamps (see [3.4](#34-frame-extraction--true-frame-accuracy)).
4. **Face tracking** — MediaPipe detects + tracks each on-screen face; crop each.
5. **Visual ASD** — LR-ASD scores, per frame, which face is *actively speaking* (lips moving in sync with audio).
6. **Reconcile** — map the audio speaker label to the on-screen identity that ASD says is talking.
   - **Agreement** (audio says "Speaker A" and exactly one face is visually speaking) → high-confidence attribution.
   - **Conflict or low confidence** (no face speaking, multiple faces, off-screen voice, >4 speakers, face too small) → **flag for human review**; never auto-attribute.
7. **Identity binding** — build a small gallery of face crops per recurring person so labels stay consistent across many videos (and so "Speaker A" becomes a real name once a human confirms it once).

**Forensic principle:** the system should output a **confidence + evidence** (which face, which frames) for every attributed quote, and **refuse to guess** when off-screen audio or crowd scenes make visual confirmation impossible. A flagged "unknown speaker" is far safer in a criminal case than a confident wrong name.

### 3.4 Frame extraction — true frame accuracy

For ~30 fps frame precision, use **FFmpeg** as the deterministic source of truth, not a model:

- Extract by exact timestamp / frame index (e.g. select specific PTS, or decode and index every frame's presentation timestamp) so a quote at `01:23:45.500` maps to a specific, reproducible frame.
- For long files, **decode once and index PTS** so later random-access frame pulls are exact and cheap.
- This deterministic index is what feeds both the visual-ASD step (3.3) and the on-demand VLM step (Section 5) — and it's what makes attributions **reproducible** for an evidence chain.

### 3.5 Video understanding / temporal grounding

- **Qwen3-VL-8B-Instruct**: **Text–Timestamp Alignment** for precise timestamp-grounded event localization, **Interleaved-MRoPE**, **256K context (→1M)** → second-level indexing over long video. Apache-2.0, GGUF available. ([HF](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct), [repo](https://github.com/QwenLM/Qwen3-VL), [report](https://arxiv.org/pdf/2511.21631)) Use **locally on short clips/frames (Q4)**, or via **API** for heavier work.
- **Qwen3.5-Omni** (30B MoE / 3B active): native text+audio+image+video + speech, SOTA on 32/36 audio-video benchmarks — **API-only** for you (24 GB+ to run). Best when you need *audio and video reasoned together* on a tough segment. ([HF](https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct))
- **ByteDance Seed1.5-VL** (the TikTok/ByteDance model you half-remembered): 532M vision encoder + 20B MoE LLM, SOTA on 14/19 video benchmarks incl. **temporal localization** — but **likely API/eval, not open weights**. ([repo](https://github.com/ByteDance-Seed/Seed1.5-VL), [report](https://seed.bytedance.com/en/public_papers/seed1-5-vl-technical-report))
- Other long-video options: **Tarsier2-7B** (long-form description, frame-level QA, streaming), **InternVL3** series.

### 3.6 Semantic / contextual search (the "my ex = his wife" problem)

Plain keyword search fails on nicknames and inside jokes. Two complementary layers:

- **Text embeddings** — **Qwen3-Embedding-0.6B** (or 4B), #1-family on MTEB multilingual, 32K context. Embed transcript chunks for "find me everything about X" by meaning, not exact words. ([HF](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B))
- **Multimodal embeddings** — **Qwen3-VL-Embedding-2B (4-bit AWQ)** puts **frames and text in one space**, so you can search "the argument in the car at night" by scenery. ([HF](https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B))
- **Reranking** — **Qwen3-Reranker** re-orders top hits for precision.
- **Resolving oblique references:** embeddings alone won't *know* that "my ex" means his wife. Maintain a **glossary / alias table** (nicknames → real identities, inside jokes → meanings) that a human curates as it's discovered, and do **LLM query-expansion** (via qwen-cli) at search time: expand "his ex" into the known aliases before retrieval. The embedding model handles *semantic similarity*; the alias table + LLM handles *project-specific code-words*. Treat the glossary itself as evidence-tracked (who decided "my ex" = the wife, and based on which clip).

---

## 4. Cost Estimate Sketch — ~100 Hours

> **All figures are rough ESTIMATES** to show the math and order of magnitude. Token-per-second rates, audio compression, and prompt sizes vary; **price your own sample hour before committing.**

### Local-only (the cheap pass — recommended for everything)

Dominated by **electricity + wall-clock time**, not dollars. ASR + diarization + ASD + embeddings on a single 8 GB GPU realistically run at **well faster than real-time for ASR** but the visual ASD + frame work is the slow part.

| Resource | Rough estimate for 100 h |
|---|---|
| Wall-clock (sequential stages, overnight batches) | ~days of unattended runtime; budget **1–2 weeks** of overnight batches with reruns |
| Electricity | A few dollars to low tens of dollars total (GPU ~150–250 W × runtime) |
| API cost | **$0** for the deterministic pass |

**Takeaway:** the full *baseline index* of 100 hours can be essentially **free in dollars**, paid in time. This is why everything cheap runs over everything.

### API for video understanding (the expensive pass — flagged segments only)

The thing to **avoid** is sending 100 hours of dense video to a VLM. Per-hour math for a couple of options:

**Gemini 2.5 video pricing basis:** video input ≈ **258 tokens/second @ 1 fps** → **~928,800 input tokens per hour** of video. ([Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing))

| Model (input price) | Tokens/hr of video | Input cost **per hour** | Cost for **100 h** (input only) |
|---|---|---|---|
| **Gemini 2.5 Pro** ($1.25 / 1M in, ≤200K ctx) | ~0.93M | **~$1.16 / hr** | **~$116** |
| **Qwen3-VL-8B-Instruct** via OpenRouter ($0.08 / 1M in) | ~0.93M (similar frame-token basis) | **~$0.07 / hr** | **~$7** |
| **Qwen3-VL-235B-A22B** via OpenRouter ($0.20 / 1M in) | ~0.93M | **~$0.19 / hr** | **~$19** |

> Output tokens are extra (Gemini 2.5 Pro $10/1M out; Qwen3-VL-8B $0.50/1M out) but for short summaries/answers they're small vs. video input. ([OpenRouter Qwen3-VL-8B](https://openrouter.ai/qwen/qwen3-vl-8b-instruct), [Qwen3-VL-235B](https://openrouter.ai/qwen/qwen3-vl-235b-a22b-instruct))

**ASR via API (if you skip local ASR):** Qwen3-ASR-Flash is **$35 / 1M input tokens** on OpenRouter, billed on audio tokens (not a clean per-hour number) — local Parakeet is almost certainly cheaper at 100 h scale. ([OpenRouter pricing](https://openrouter.ai/qwen/qwen3-asr-flash-2026-02-10/pricing))

**Qwen3.5-Omni via API:** sensible for a *small number* of hard audio+video segments; do not run it over all 100 h. ([WaveSpeed pricing notes](https://wavespeed.ai/blog/posts/qwen3-5-omni-api-pricing-2026/))

**Reading of the numbers:** even the "expensive" option is **~$100–$120 for one full dense pass at 1 fps** with Gemini, or **single-digit dollars** with Qwen3-VL — *if* you actually need to look at everything. You almost never do. With triage (Section 5) you'll send maybe **5–15%** of the footage to a VLM, cutting even that to a rounding error. The real cost is **time**, not money.

---

## 5. Recommended Strategy — Triage, Not Brute Force

**Why dense 30 fps VLM over 100 h is impractical:** 100 h × 3600 s × 30 fps = **~10.8 million frames**. Even at the friendly Qwen3-VL token price, dense 30 fps (vs the 1 fps assumed above) is ~30× the cost *and* enormous compute/time — and it's **wasteful**, because most frames are redundant (same shot, nobody new, nothing happening). Frame-accuracy is a **retrieval/extraction** problem, not a reason to feed every frame to a model.

**The tiered pipeline:**

### Tier 0 — Deterministic pass over EVERYTHING (cheap, local, overnight)
Run on all 100 h:
1. **ASR** (Parakeet-v3) → transcript + word timestamps.
2. **Audio diarization** (Sortformer) → speaker labels.
3. **Visual speaker verification** (LR-ASD + MediaPipe) → confirm/flag attributions.
4. **Shot / scene detection** (e.g. PySceneDetect) → segment each video into shots.
5. **Frame indexing** (FFmpeg, PTS-exact) → frame-accurate random access for any timestamp.
6. **Embeddings** — text (Qwen3-Embedding) + a few **keyframes per shot** (Qwen3-VL-Embedding) → searchable index.

Output: a fully **searchable, speaker-attributed, frame-indexed** corpus with **confidence flags** — for **~$0 in API** and a week or two of overnight runtime.

### Tier 1 — Targeted video understanding (expensive, selective)
Only run a VLM (Qwen3-VL local on short clips, or Qwen3-VL / Qwen3.5-Omni / Gemini via API) on:
- Segments **flagged** in Tier 0 (speaker conflict, low confidence, off-screen audio, >4 speakers).
- Segments **returned by a search query** ("show me where the kitchen argument happens").
- **On-demand** when the journalist asks "what is actually happening here?"

**How this achieves the needed precision:** **shot detection** picks the *right moments*, **frame indexing** gives **exact frames** at those moments, and the **VLM** reasons only about those few frames/clips. You get frame-accurate, second-grounded answers (thanks to Qwen3-VL's Text–Timestamp Alignment) **without** paying to watch every frame. Precision comes from the deterministic FFmpeg index; intelligence is spent only where it's needed.

```
ALL 100h ──▶ Tier 0 (cheap, local, runs on everything)
             ASR · audio diarization · visual ASD verify ·
             shot detection · frame index · embeddings
                    │
                    ├─▶ searchable, speaker-attributed, frame-indexed corpus
                    │
                    └─▶ FLAGGED or QUERIED segments only
                              │
                              ▼
                         Tier 1 (expensive, selective)
                         Qwen3-VL (local short clips / API) ·
                         Qwen3.5-Omni / Gemini for hardest audio+video
```

---

## 6. Honest Caveats / Things to Validate on YOUR Hardware

- **8 GB is tight for Qwen3-VL-8B Q4.** It should load with a small `mmproj`, but KV cache for long context + the vision encoder can push you over. Validate with **short** inputs first; if it OOMs, drop to **Qwen3-VL-4B** or push VL work to API. ([GGUF](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF))
- **llama.cpp VIDEO path is the riskiest local assumption.** Image-frame mode is reliable; the *temporal/video* handling (and Qwen3-VL embeddings) is newer. **Prefer the FFmpeg-frames → images workflow** and test video mode before depending on it. ([llama.cpp discussion](https://github.com/ggml-org/llama.cpp/discussions/19516))
- **Sortformer caps at 4 speakers.** Anything busier (crowds, overlapping guests) **will** mislabel on audio alone — lean on the visual ASD layer and flag for humans.
- **Visual ASD fails when the speaker is off-screen, tiny, turned away, or in a crowd.** Vertical livestreams and ~15 s Shorts often won't show the talker. **Off-screen voice = do not auto-attribute; flag it.** This is a feature, not a bug, for evidence integrity.
- **WER numbers are leaderboard averages.** Real footage (overlapping speech, noise, slang, music) will be worse. Treat ASR as a **draft** to be human-verified on quotes that matter legally.
- **Embeddings won't decode project-specific code-words on their own.** The **alias glossary + LLM query-expansion** is what resolves "my ex" → his wife. Curate it by hand and keep an audit trail of *who decided what, based on which clip*.
- **API pricing here is approximate and dated June 2026.** Re-check OpenRouter / Gemini pages before budgeting; token-per-second video billing varies by sampling rate. Price a **single sample hour** end-to-end first.
- **Evidence chain matters more than any benchmark.** For a criminal investigation, keep every attribution **reproducible** (original file + exact PTS frame + model + version + confidence) and make the system **say "unknown"** rather than guess. A flagged gap is defensible; a confident wrong name is not.

---

## Sources

- Parakeet-TDT-0.6B-v3 — https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- Parakeet-TDT-0.6B-v2 (diarization Q&A) — https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2/discussions/16
- Sortformer streaming diarization 4spk-v2.1 — https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1
- parakeet.cpp (Sortformer integration) — https://github.com/Frikallo/parakeet.cpp
- parakeet-rs — https://github.com/altunenes/parakeet-rs
- NeMo diarization for Parakeet v3 (discussion) — https://github.com/NVIDIA-NeMo/NeMo/discussions/14842
- parakeet.cpp vs Whisper comparison — https://modelslab.com/blog/audio-generation/parakeet-cpp-vs-whisper-self-hosted-asr-comparison-2026
- Best open-source STT (Gladia) — https://www.gladia.io/blog/best-open-source-speech-to-text-models
- Best open-source STT 2026 (Northflank) — https://northflank.com/blog/best-open-source-speech-to-text-stt-model-in-2026-benchmarks
- Qwen3-ASR paper — https://arxiv.org/pdf/2509.14128
- Qwen3-ASR-Flash pricing (OpenRouter) — https://openrouter.ai/qwen/qwen3-asr-flash-2026-02-10/pricing
- LR-ASD (IJCV 2025) — https://github.com/Junhua-Liao/LR-ASD
- LR-ASD paper (PDF) — https://duanhaihan.github.io/publications/2025/IJCV2025.pdf
- Light-ASD (CVPR 2023) — https://github.com/Junhua-Liao/Light-ASD
- Light-ASD paper — https://arxiv.org/pdf/2303.04439
- Multimodal speaker diarization (audio+visual+semantic) — https://arxiv.org/html/2408.12102v1
- 3D-Speaker-Toolkit — https://arxiv.org/html/2403.19971v1
- AVA-ActiveSpeaker dataset — https://arxiv.org/pdf/1901.01342
- Target ASD with audio-visual cues — https://arxiv.org/abs/2305.12831
- Qwen3-VL-8B-Instruct — https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct
- Qwen3-VL-8B-Instruct GGUF — https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF
- Qwen3-VL repo — https://github.com/QwenLM/Qwen3-VL
- Qwen3-VL tech report — https://arxiv.org/pdf/2511.21631
- Unsloth Qwen3-VL run/fine-tune guide — https://unsloth.ai/docs/models/qwen3-vl-how-to-run-and-fine-tune
- llama.cpp Qwen3-VL multimodal/embeddings discussion — https://github.com/ggml-org/llama.cpp/discussions/19516
- llama.cpp Windows CUDA prebuilt binaries — https://knightli.com/en/2026/05/18/llama-cpp-windows-cuda-vulkan-gguf/
- Qwen3.5-Omni release (MarkTechPost) — https://www.marktechpost.com/2026/03/30/alibaba-qwen-team-releases-qwen3-5-omni-a-native-multimodal-model-for-text-audio-video-and-realtime-interaction/
- Qwen3-Omni repo — https://github.com/QwenLM/Qwen3-Omni
- Qwen3-Omni-30B-A3B-Instruct — https://huggingface.co/Qwen/Qwen3-Omni-30B-A3B-Instruct
- Qwen3-Omni paper — https://arxiv.org/abs/2509.17765
- Qwen3.5-Omni API pricing (WaveSpeed) — https://wavespeed.ai/blog/posts/qwen3-5-omni-api-pricing-2026/
- ByteDance Seed1.5-VL repo — https://github.com/ByteDance-Seed/Seed1.5-VL
- Seed1.5-VL (MarkTechPost) — https://www.marktechpost.com/2025/05/15/bytedance-introduces-seed1-5-vl-a-vision-language-foundation-model-designed-to-advance-general-purpose-multimodal-understanding-and-reasoning/
- Seed1.5-VL technical report — https://seed.bytedance.com/en/public_papers/seed1-5-vl-technical-report
- Qwen3-Embedding-0.6B — https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- Open-source embedding models guide (BentoML) — https://www.bentoml.com/blog/a-guide-to-open-source-embedding-models
- Choosing an embedding model for RAG 2026 (Milvus) — https://milvus.io/blog/choose-embedding-model-rag-2026.md
- Qwen3-VL-Embedding-2B — https://huggingface.co/Qwen/Qwen3-VL-Embedding-2B
- Qwen3-VL-Embedding-2B-AWQ-4bit — https://huggingface.co/LifetimeMistake/Qwen3-VL-Embedding-2B-AWQ-4bit
- Qwen3-VL-8B-Instruct pricing (OpenRouter) — https://openrouter.ai/qwen/qwen3-vl-8b-instruct
- Qwen3-VL-235B-A22B-Instruct pricing (OpenRouter) — https://openrouter.ai/qwen/qwen3-vl-235b-a22b-instruct
- Gemini API pricing — https://ai.google.dev/gemini-api/docs/pricing
