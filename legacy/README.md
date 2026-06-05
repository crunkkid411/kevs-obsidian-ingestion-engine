# legacy/ — archival, NOT part of the forensic system. Ignore for the build.

These are the files from the **original** generic marketing-content engine the
repo was forked from (Dropbox → Whisper → Claude-vision → Obsidian-markdown,
then *deletes the source file*). They are kept only for reference.

**Do not build, run, wire, or "fix" anything in here.** Their imports are
intentionally not maintained. The forensic pipeline that supersedes them lives in
`src/` and is described in `docs/ARCHITECTURE.md` + `docs/BUILD.md`.

| Legacy file | Superseded by |
|---|---|
| `batch.js` | `src/ingest.js` (forensic orchestrator) |
| `sources/dropbox.js` → `dropbox.js` | `src/sources/local.js` (read-only, hashing, no delete) |
| `transcribe/whisper.js` | `src/adapters/models.js` runASR → Parakeet (see `config/models.lock.json`) |
| `vision/frames.js` (OpenCV 6-frame) + `extract_frames.py` | `scripts/extract_frames_precise.py` (frame-accurate) + `src/analyze/signatures.js` |
| `classify/agent.js` | `src/review/` (case-aware context-review agent) |
| `markdown/writer.js` | Postgres/SQLite + `src/search/query.js` + the player UI |
| `db/postgres.js` | `src/db/forensic.js` + `src/db/schema*.sql` |
