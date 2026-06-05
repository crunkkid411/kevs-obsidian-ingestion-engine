# Windows 10 setup (8 GB VRAM)

Plain-language setup. You can hand each numbered step to Claude Code / qwen-cli
and say "do this." Nothing here modifies or deletes your footage — the originals
are treated as read-only evidence.

> **Reality check:** none of the model steps were tested in the environment where
> this repo was assembled (it had no GPU and no footage). Treat the model stages
> as "wire and verify one at a time." STAGE 0 (hashing + metadata + database) and
> frame-accurate extraction only need FFmpeg + Postgres and should work as-is.

## 0. Install the basics
- **Node.js 20+** — https://nodejs.org
- **FFmpeg + ffprobe** on PATH — `winget install Gyan.FFmpeg`
- **Python 3.11** — https://python.org (check "Add to PATH")
- **Postgres 16 + pgvector** — install Postgres, then in `psql`: `CREATE EXTENSION vector;`
  (or use a hosted Postgres like Supabase/Neon and enable the `vector` extension).
- **PyTorch with CUDA** — from https://pytorch.org/get-started/locally/ (pick your CUDA).

## 1. Get the project ready
```bat
npm install
copy .env.example .env
```
Edit `.env`: set `LOCAL_ROOT` to your footage folder/drive and `DATABASE_URL`
to your Postgres connection string.

## 2. Make your case taxonomy
Copy `config/taxonomy.investigation.example.json` to `config/taxonomy.json` and
fill in the real **entities** — the defendant, the wife, etc. — with their
**aliases**, the **nicknames / inside-jokes** he uses, physical **descriptions**,
and **timeline_anchors** (e.g. the separation date). This is what lets the system
later connect "my ex, it's been 4 months" to the right person. Keep it updated as
you discover new code-words; the glossary is itself part of the evidence trail.

## 3. Run the deterministic intake (works now, no GPU needed)
```bat
npm run ingest "D:\footage"
```
This hashes every file (chain of custody), reads exact fps/resolution/duration,
registers each source in Postgres, and extracts frame-accurate keyframes. ASR /
diarization / ASD / embeddings will say "skipped" until you install them in the
next steps — that's expected, the run still completes and the corpus is registered.

## 4. Install the models (one at a time, verify each)
```bat
npm run setup:python        REM installs NeMo, sentence-transformers, mediapipe
```
Then enable stages in `.env` and re-run `npm run ingest`:
1. **ASR** — `ASR_BACKEND=parakeet`. Verify words+timestamps appear.
2. **Diarization** — `DIAR_BACKEND=sortformer`. Verify speaker turns appear.
3. **Embeddings** — leave `TEXT_EMBED_MODEL` default; verify `npm run search` returns hits.
4. **Visual ASD** — the misattribution fix. `scripts/asd_lr_asd.py` is a stub with
   exact wiring instructions; until it's done, every quote is flagged
   `needs-review` (the safe default). This is the most valuable thing to finish.

> Run stages **sequentially**, not all at once — 8 GB can't hold every model
> simultaneously. The pipeline is a conveyor belt. See `docs/MODELS-2026.md` for
> the VRAM math and which steps must use the API instead.

## 5. Search your archive
```bat
npm run search "every time he talks about his wife" --expand
npm run search "threats or intimidation" --include-unreviewed
```
Each hit shows the **source file**, **exact timestamp**, who it's attributed to,
the **confidence**, and whether it **needs review** — so you can jump straight to
the moment in the original footage and verify it yourself.

## 6. Heavy video questions (optional, costs money)
For "what is actually happening in this clip," set `VIDEO_BACKEND=openrouter` and
`OPENROUTER_API_KEY`, and run the (forthcoming) understanding step only on flagged
or searched segments. Per `docs/MODELS-2026.md`, a full dense pass is ~$7–$120
for 100 h depending on model — but with triage you'll spend a fraction of that.

## Evidence hygiene (please read)
- The tool never edits, moves, or deletes your originals. Keep a separate,
  untouched master copy of the drive regardless.
- Every AI conclusion (speaker identity, "my ex = the wife", topic labels) is a
  **claim with a confidence and a rationale**, stored for review — not a fact.
  Confirm anything legally load-bearing against the source yourself.
- When the machine can't see who's talking, it says **unknown** and flags it.
  Prefer that gap over a confident wrong name.
