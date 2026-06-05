# Kev's Obsidian Ingestion Engine

> ## 🔬 Forensic mode (this fork)
>
> This branch refactors the engine for **evidentiary video work** — organizing a
> large local archive (e.g. 500 GB / 100+ hours) so you can search it by meaning
> and pull up exact moments, with **chain of custody** and **audio-visual speaker
> attribution**. It is built for an authorized investigative-journalism workflow.
>
> **Start here:**
> - **`docs/MODELS-2026.md`** — model research (June 2026): ASR, diarization,
>   visual active-speaker detection, video understanding, embeddings — 8 GB-VRAM
>   viability, API alternatives, cost math.
> - **`docs/NATIVE-STACK.md`** — the **native** (C/Rust/Go/ONNX, no Python/web)
>   runtime stack: sherpa-onnx, sqlite-vec, fastembed-rs, llama.cpp, libmpv+egui,
>   ffmpeg signature, auto-editor.
> - **`docs/HANDOFF.md`** — ordered build plan (milestones + acceptance tests) for
>   a local Claude Code instance to implement the native tool.
> - **`docs/ARCHITECTURE.md`** — pipeline, data model, chain-of-custody/provenance.
> - **`docs/SETUP-WINDOWS.md`** — plain-language Windows 10 / 8 GB setup.
>
> **Beyond transcription/search, the pipeline flags the "20% nuance"** — a second
> voice, a phone call, a room/location change — as reviewable `events`, and
> **exports clean location frames + provenance** for detective OSINT fixture
> matching (it corroborates; it never concludes *where* or *who*). A native
> **libmpv player** with frame-accurate stepping and **auto-editor** clip export
> is the investigator's review surface.
>
> **Quickstart:**
> ```bat
> npm install
> copy .env.example .env          REM set LOCAL_ROOT + DATABASE_URL
> npm run ingest "D:\footage"     REM hash + probe + register + frame-accurate keyframes
> npm run search "every time he mentions his wife" --expand
> ```
> STAGE 0 (intake) runs with only FFmpeg + Postgres. The model stages
> (Parakeet ASR, Sortformer diarization, LR-ASD visual verification, Qwen3
> embeddings) are wired in `.env` and enabled one at a time on the GPU machine.
> **Recommended stack:** Parakeet-TDT-0.6B-v3 → Sortformer-4spk → LR-ASD+MediaPipe
> → Qwen3-Embedding (+ Qwen3-VL only on flagged/queried segments).
>
> ⚠️ The model integrations were **not** executed in the environment where this
> code was written (no GPU / no footage there) — validate each stage locally.
> Source files are treated as **read-only**; the pipeline never deletes them.
>
> ---
>
> The original generic engine is documented below and still available via
> `npm run batch:legacy`.

A generic, config-driven video content ingestion engine. Point it at a Dropbox folder, define your taxonomy, and it will:

1. **Download** videos from Dropbox (Google Drive support optional)
2. **Transcribe** them with Whisper (local or OpenAI API)
3. **Extract** key frames with OpenCV scene detection
4. **Analyze** the frames with Claude vision
5. **Classify** each video using your taxonomy via Claude
6. **Write** rich markdown notes into your Obsidian vault (with thumbnails, key quotes, suggested clips)
7. **Index** everything in a Postgres database for search and querying
8. **Auto-link** people, topics, and locations to build a knowledge graph

## Why?

Because your stack of unprocessed footage isn't searchable. This engine reads every video, understands what's in it, and turns it into a navigable Obsidian knowledge graph + queryable database — entirely driven by a single config file.

## What you get out

For every video:

- A **markdown note** in your Obsidian vault with:
  - YAML frontmatter (content type, topics, people, location, tone, quality, confidence)
  - Auto-generated title and one-line summary
  - Embedded thumbnail
  - Key quotes pulled from the transcript
  - Suggested clips with timestamps
  - The full timestamped transcript
  - Wiki-links to people you defined in your taxonomy
- A **database row** with all the same metadata
- A **searchable transcript** stored as both full text and timed segments
- **Per-frame analysis** data (faces detected, sharpness, brightness)
- **People appearance tracking** for cross-video search

## Setup

### 1. Install

```bash
git clone https://github.com/kevinbadi/kevs-obsidian-ingestion-engine.git
cd kevs-obsidian-ingestion-engine
npm install
pip3 install -r requirements.txt
```

You also need `ffmpeg` and `ffprobe` installed:

```bash
brew install ffmpeg     # macOS
sudo apt install ffmpeg # Linux
```

### 2. Define your taxonomy

Copy the example and customize it for your project:

```bash
cp config/taxonomy.example.json config/taxonomy.json
```

Edit `config/taxonomy.json`:

```json
{
  "project": {
    "name": "My Project",
    "description": "What this knowledge base is for",
    "context": "You are analyzing video content for [organization], which is a [type of org]. This context goes into the AI prompts."
  },
  "content_types": [
    "testimonial", "interview", "explainer", "podcast clip", "b-roll", ...
  ],
  "topic_areas": [
    "topic-one", "topic-two", "topic-three"
  ],
  "locations": ["office", "studio", "outdoor", "remote"],
  "tones": ["inspirational", "educational", "casual", "professional"],
  "production_qualities": ["professional", "raw", "screen-recording"],
  "people_of_interest": [
    { "name": "Person Name", "aliases": ["Nickname", "Alt Name"] }
  ],
  "additional_instructions": "Optional: extra guidance for the classifier."
}
```

The `people_of_interest` list is what powers automatic person detection. The classifier scans transcripts AND filenames for these names (and their aliases) and creates wiki-links to them in Obsidian.

### 3. Configure environment

```bash
cp .env.example .env
```

Fill in:

- `DROPBOX_ACCESS_TOKEN` — from your Dropbox app console
- `ANTHROPIC_API_KEY` — for the AI vision and classifier
- `DATABASE_URL` — any Postgres connection string (insforge, Supabase, Neon, local)
- `OBSIDIAN_VAULT_PATH` — absolute path to your Obsidian vault

See `.env.example` for the full list.

### 4. Run a batch

```bash
node src/batch.js "/path/to/your/dropbox/folder"
```

The engine will:
- List all videos in that folder (recursively)
- Skip any already in the database
- Process each one end-to-end
- Delete the local file after processing (so you don't fill up your disk)
- Write notes to your vault and rows to your database

You can run **multiple batches in parallel** for different folders. Just open new terminal windows.

## Configuration Reference

### Taxonomy fields

| Field | Purpose |
|-------|---------|
| `project.name` | Used in tags (e.g., `MyProject/treatment/...`) |
| `project.context` | Domain context passed to AI prompts |
| `content_types` | Pickable types (one primary + secondary) |
| `topic_areas` | Tags applied to each video (multi-select) |
| `locations` | Where the video was shot |
| `tones` | Mood / emotional register |
| `production_qualities` | Visual quality categorization |
| `people_of_interest` | Names + aliases the classifier should detect |

### Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `SOURCE` | dropbox | Source plugin to use |
| `DROPBOX_ACCESS_TOKEN` | - | Dropbox API token |
| `ANTHROPIC_API_KEY` | - | Claude API key |
| `AI_MODEL` | claude-sonnet-4-6 | Claude model for vision + classification |
| `WHISPER_MODE` | local | `local` (free, on-device) or `api` (paid) |
| `WHISPER_MODEL` | base | tiny / base / small / medium / large |
| `DATABASE_URL` | - | Postgres connection string |
| `OBSIDIAN_VAULT_PATH` | ./vault | Path to your vault |
| `OBSIDIAN_NOTES_FOLDER` | Videos | Subfolder for notes |
| `MAX_FILE_SIZE_BYTES` | 2 GB | Skip files larger than this |

## Architecture

```
┌──────────┐    ┌────────┐    ┌─────────┐    ┌──────────┐
│ Dropbox  │ →  │ Batch  │ →  │ Process │ →  │ Outputs  │
│  Drive   │    │ runner │    │         │    │          │
└──────────┘    └────────┘    └─────────┘    └──────────┘
                                  │              │
                                  │              ├── Obsidian vault
                                  │              ├── Postgres
                                  │              └── Thumbnails
                                  │
                              ┌───┴──────────────┐
                              │                  │
                          Whisper            OpenCV
                          transcript         frames
                              │                  │
                              └──→ Claude Vision ←┘
                                       │
                                  Classifier
                                       │
                              JSON output → Vault + DB
```

## Source Plugins

Currently:

- **Dropbox** (`src/sources/dropbox.js`) — fully implemented
- **Google Drive** (`src/sources/google-drive.js`) — placeholder, easy to port from existing implementations

To add a new source, create a module exporting `listVideos()`, `downloadVideo()`, and `getShareLink()`.

## Database Schema

5 tables, auto-created on first run:

| Table | What |
|-------|------|
| `videos` | Core record per video — tags, metadata, status |
| `transcripts` | Full text + JSONB segments per video |
| `frame_analyses` | Per-frame OpenCV + AI vision data |
| `people_appearances` | Junction table — people detected in each video |
| `processing_log` | Audit trail of pipeline runs |

## Real-World Example

This engine was built for the [CPI Content Engine](https://github.com/kevinbadi/cpi-content-engine) — a private project that processed **900+ videos** from a stem cell therapy clinic, classifying them into a taxonomy of treatment areas, content types, locations, and 100+ named patients/influencers. Check out `examples/` for the full taxonomy used there.

## Limitations

- Files over 2 GB are skipped by default (configurable)
- ProRes 422 .mov files may fail Whisper (no extractable audio)
- Local Whisper runs on CPU (slower than GPU)
- Dropbox short-lived tokens expire after ~4 hours (manual refresh; full OAuth flow not yet implemented)
- No face recognition — people are detected via transcript or filename only

## Roadmap

- [ ] Long-lived Dropbox refresh token flow
- [ ] Google Drive source plugin port
- [ ] Vector embeddings for semantic transcript search
- [ ] Face recognition for visual person detection
- [ ] Web UI for browsing/searching the knowledge base
- [ ] Cron-based watcher mode (vs one-shot batch)

## License

MIT
