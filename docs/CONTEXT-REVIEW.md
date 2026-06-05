# Context-review agent — the case-aware "nuance" pass

The ingest models (ASR, diarization, embeddings, VLM) are general-purpose. They
don't know your case — that "my ex, it's been 4 months" is the wife, that a
throwaway line contradicts a court filing, that a nickname is an inside joke for
a specific person. A **context-review agent** closes that gap: it reads each
video with your case knowledge and writes the human-meaningful annotations the
base models miss.

This was the missing step. The pipeline previously only had a *placeholder* for
reference resolution; this is the real, implemented stage.

## Design

- **One agent per media file.** Each video is reviewed in its own fresh agent
  call — the design that preserves nuance. Batching many files into one call
  caused details to be overlooked. A small concurrency limit
  (`CONTEXT_REVIEW_CONCURRENCY`, default 2) runs a few files in parallel without
  diluting attention.
- **Runs as a separate pass** (`npm run review`), after ingest, so it can re-run
  whenever you update the case context — without re-transcribing anything.
- **Pluggable backend** (`CONTEXT_REVIEW_BACKEND`):
  - **`claude-code`** — your **local** Claude Code instance, headless
    (`claude -p … --append-system-prompt … --model …`). Your sensitive case
    context and the transcripts **never leave the machine**. This is the point of
    your local "llm-wiki" instance: it already carries verified court documents
    and specific instructions, and that context changes what it deems meaningful.
  - **`openrouter`** — an API model, for **testing which model is best at nuance**.
    Use only because nothing in *this project's code* is confidential — do not
    send genuinely sensitive case context to an API backend.
  - **`mock`** — offline dev backend (emits a representative annotation).
- **Everything is a reviewable claim.** Each annotation stores its rationale,
  confidence, the backend+model, and a hash of the exact case-context prompt
  used — and starts `unreviewed`. Nothing is asserted as fact; the human
  confirms at playback.

## The editable brain: `config/context-review.prompt.md`

This file **is** the case knowledge — people, aliases, nicknames, timeline
anchors, relationships, what matters vs. what's noise. It's sent as the agent's
system prompt. **It is GUI-editable** (see `config/settings.schema.json` →
`CONTEXT_REVIEW_SYSTEM_PROMPT`) so the investigator updates it as the case
develops, no code changes. When the backend is `claude-code`, this content stays
local.

The agent returns structured JSON (summary + annotations + significance); the
stage parses it and writes rows to `context_annotations`.

## What it produces (`context_annotations` table)

| kind | example |
|---|---|
| `reference_resolution` | "my ex" at 2:00 → **The Wife** (timeline: split 4 months prior) |
| `contradiction` | a statement that conflicts with a known fact — high value |
| `notable_moment` | an admission/threat worth a detective's eyes |
| `nuance` | an inside-joke/callback that identifies a person or place |

Each row: `start/end_sec`, `surface_text`, `linked_name`, `note`, `rationale`,
`confidence`, `significance`, `backend`, `model_name`, `prompt_hash`,
`review_status`. These surface in search and the player so a reviewer jumps to
the exact moment and confirms or rejects.

## Run it

```bat
npm run review            REM review sources not yet reviewed
npm run review -- --all   REM re-review everything (after editing the case prompt)
```

## Tuning / accuracy
- Re-run `--all` after meaningful case-context edits; `prompt_hash` records which
  prompt version produced each annotation, so you can tell stale ones apart.
- Test models on a few files via `openrouter` (non-sensitive), then switch the
  production pass to `claude-code` for the real, sensitive run.
- Keep confidence honest: the agent is told to return an empty list for noise —
  a video with no annotations is a valid, useful result.
