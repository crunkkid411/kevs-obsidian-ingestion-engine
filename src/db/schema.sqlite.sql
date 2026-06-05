-- Forensic schema — SQLite + sqlite-vec variant (RECOMMENDED for a single
-- investigator on one machine: in-process, no server, no bloat).
--
-- Mirrors src/db/schema.sql (Postgres) table-for-table. Differences:
--   * ids are app-or-default-generated TEXT (lower(hex(randomblob(16))))
--   * timestamps are ISO-8601 TEXT; arrays/JSON are TEXT holding JSON
--   * vectors live in a sqlite-vec vec0 virtual table joined by rowid
--
-- Load the extension first (sqlite-vec): in the sqlite3 CLI `.load ./vec0`,
-- or via your driver's load_extension(). vec dimension MUST match the model
-- (Qwen3-Embedding-0.6B = 1024).
--
-- NOTE: sqlite-vec (asg017) currently does brute-force search (no ANN index).
-- At this archive's scale (~100h -> hundreds of thousands of utterance vectors)
-- brute force is still millisecond-range and perfectly fine. If you later need
-- ANN, sqlite-vector (sqliteai) adds it; same vec0-style API.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  sha256        TEXT UNIQUE NOT NULL,
  abs_path      TEXT NOT NULL,
  file_name     TEXT NOT NULL,
  byte_size     INTEGER,
  container     TEXT,
  duration_sec  REAL,
  fps           REAL,
  fps_num       INTEGER,
  fps_den       INTEGER,
  frame_count   INTEGER,
  width         INTEGER,
  height        INTEGER,
  orientation   TEXT,
  audio_streams INTEGER,
  ffprobe_json  TEXT,
  recorded_at   TEXT,
  ingested_at   TEXT DEFAULT (datetime('now')),
  status        TEXT DEFAULT 'ingested'
);

CREATE TABLE IF NOT EXISTS chain_of_custody (
  id            INTEGER PRIMARY KEY,
  source_id     TEXT REFERENCES sources(id),
  event         TEXT NOT NULL,
  detail        TEXT,
  actor         TEXT,
  model_name    TEXT,
  model_version TEXT,
  params        TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media_segments (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_id   TEXT REFERENCES sources(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  start_sec   REAL NOT NULL,
  end_sec     REAL NOT NULL,
  start_frame INTEGER,
  end_frame   INTEGER,
  label       TEXT,
  created_by  TEXT DEFAULT 'deterministic'
);
CREATE INDEX IF NOT EXISTS idx_segments_time ON media_segments(source_id, start_sec);

CREATE TABLE IF NOT EXISTS transcript_words (
  id          INTEGER PRIMARY KEY,
  source_id   TEXT REFERENCES sources(id) ON DELETE CASCADE,
  word        TEXT NOT NULL,
  start_sec   REAL NOT NULL,
  end_sec     REAL NOT NULL,
  confidence  REAL,
  asr_model   TEXT,
  asr_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_words_source ON transcript_words(source_id, start_sec);

CREATE TABLE IF NOT EXISTS speakers (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_id       TEXT REFERENCES sources(id) ON DELETE CASCADE,
  cluster_label   TEXT NOT NULL,
  entity_id       TEXT,
  link_method     TEXT,
  link_confidence REAL,
  UNIQUE (source_id, cluster_label)
);

CREATE TABLE IF NOT EXISTS utterances (
  id                     TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_id              TEXT REFERENCES sources(id) ON DELETE CASCADE,
  segment_id             TEXT,
  start_sec              REAL NOT NULL,
  end_sec                REAL NOT NULL,
  text                   TEXT NOT NULL,
  speaker_id             TEXT,
  speaker_name           TEXT,                  -- named conclusion ("Defendant")
  speaker_confidence     REAL,
  audio_speaker          TEXT,
  visual_speaker         TEXT,
  attribution_method     TEXT,
  attribution_confidence REAL,
  attribution_conflict   INTEGER DEFAULT 0,
  needs_review           INTEGER DEFAULT 0,
  reviewed_by            TEXT,
  reviewed_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_utt_source ON utterances(source_id, start_sec);
CREATE INDEX IF NOT EXISTS idx_utt_review ON utterances(needs_review);

CREATE TABLE IF NOT EXISTS entities (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  canonical_name   TEXT NOT NULL,
  entity_type      TEXT DEFAULT 'person',
  aliases          TEXT DEFAULT '[]',           -- JSON array
  nicknames        TEXT DEFAULT '[]',
  descriptions     TEXT DEFAULT '[]',
  timeline_anchors TEXT DEFAULT '[]',
  notes            TEXT
);

CREATE TABLE IF NOT EXISTS reference_resolutions (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  segment_id    TEXT,
  utterance_id  TEXT,
  surface_text  TEXT,
  entity_id     TEXT,
  rationale     TEXT,
  confidence    REAL,
  model_name    TEXT,
  model_version TEXT,
  review_status TEXT DEFAULT 'unreviewed',
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visual_observations (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  segment_id    TEXT,
  at_sec        REAL,
  at_frame      INTEGER,
  observation   TEXT,
  tags          TEXT DEFAULT '[]',
  model_name    TEXT,
  model_version TEXT,
  confidence    REAL
);

-- Embeddings: metadata table + sqlite-vec virtual table joined by rowid.
CREATE TABLE IF NOT EXISTS embeddings_meta (
  id         INTEGER PRIMARY KEY,               -- == rowid in embeddings_vec
  source_id  TEXT REFERENCES sources(id) ON DELETE CASCADE,
  ref_kind   TEXT NOT NULL,
  ref_id     TEXT,
  modality   TEXT NOT NULL,
  space      TEXT NOT NULL,
  start_sec  REAL,
  end_sec    REAL,
  content    TEXT
);
CREATE INDEX IF NOT EXISTS idx_emb_ref ON embeddings_meta(ref_kind, ref_id);
-- Requires sqlite-vec loaded. Change float[1024] to match your model dim.
CREATE VIRTUAL TABLE IF NOT EXISTS embeddings_vec USING vec0(embedding float[1024]);

CREATE TABLE IF NOT EXISTS inferences (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  input_refs    TEXT,
  output        TEXT,
  model_name    TEXT,
  model_version TEXT,
  prompt_hash   TEXT,
  params        TEXT,
  confidence    REAL,
  determinism   TEXT DEFAULT 'model_inference',
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS processing_log (
  id            INTEGER PRIMARY KEY,
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL,
  determinism   TEXT,
  model_name    TEXT,
  model_version TEXT,
  params        TEXT,
  error_message TEXT,
  duration_ms   INTEGER,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- The "20% nuance" events.
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_id    TEXT REFERENCES sources(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  start_sec    REAL NOT NULL,
  end_sec      REAL,
  start_frame  INTEGER,
  end_frame    INTEGER,
  confidence   REAL,
  detail       TEXT,
  evidence     TEXT,
  determinism  TEXT DEFAULT 'deterministic',
  needs_review INTEGER DEFAULT 1,
  reviewed_by  TEXT,
  reviewed_at  TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source_id, start_sec);
CREATE INDEX IF NOT EXISTS idx_events_kind   ON events(kind);

-- OSINT location handoff (candidate frames + metadata; NOT geolocation claims).
CREATE TABLE IF NOT EXISTS locations_of_interest (
  id                   TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_id            TEXT REFERENCES sources(id) ON DELETE CASCADE,
  start_sec            REAL NOT NULL,
  end_sec              REAL,
  representative_frame TEXT,
  ahash                TEXT,
  location_name        TEXT,                    -- "Defendant's home" when matched
  location_confidence  REAL,
  recording_date       TEXT,
  exported_dir         TEXT,
  status               TEXT DEFAULT 'unreviewed',
  notes                TEXT,
  created_at           TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_loi_ahash ON locations_of_interest(ahash);

-- Perceptual hashes for cross-video recurrence / fixture matching.
CREATE TABLE IF NOT EXISTS frame_signatures (
  id         INTEGER PRIMARY KEY,
  source_id  TEXT REFERENCES sources(id) ON DELETE CASCADE,
  at_sec     REAL,
  at_frame   INTEGER,
  ahash      TEXT,
  frame_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_fsig_ahash ON frame_signatures(ahash);

-- Human-created evidence clips from the player UI.
CREATE TABLE IF NOT EXISTS clips (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  in_sec        REAL NOT NULL,
  out_sec       REAL NOT NULL,
  label         TEXT,
  note          TEXT,
  exported_path TEXT,
  created_by    TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- KNOWLEDGE BASE (case-specific facts you provide; the system learns + applies).
-- Voice/face prints go in embeddings_vec like everything else; this table holds
-- the metadata + which vec rowid is the print.
CREATE TABLE IF NOT EXISTS identity_enrollments (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  entity_id     TEXT REFERENCES entities(id) ON DELETE CASCADE,
  modality      TEXT NOT NULL,                  -- voice | face
  vec_rowid     INTEGER,                        -- rowid in embeddings_vec holding the print
  ref_source_id TEXT,
  ref_start_sec REAL,
  ref_end_sec   REAL,
  confirmed_by  TEXT,
  notes         TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_enroll_entity ON identity_enrollments(entity_id, modality);

CREATE TABLE IF NOT EXISTS known_locations (
  id                TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name              TEXT NOT NULL,
  entity_id         TEXT,
  reference_ahashes TEXT DEFAULT '[]',          -- JSON array of perceptual hashes
  reference_frames  TEXT DEFAULT '[]',          -- JSON array of frame paths
  confirmed_by      TEXT,
  notes             TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_knownloc_name ON known_locations(name);

-- Output of the per-media case-context review agent.
CREATE TABLE IF NOT EXISTS context_annotations (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  source_id     TEXT REFERENCES sources(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  start_sec     REAL,
  end_sec       REAL,
  surface_text  TEXT,
  linked_entity TEXT,
  linked_name   TEXT,
  note          TEXT,
  rationale     TEXT,
  significance  TEXT,
  confidence    REAL,
  backend       TEXT,
  model_name    TEXT,
  prompt_hash   TEXT,
  review_status TEXT DEFAULT 'unreviewed',
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ctxann_source ON context_annotations(source_id, start_sec);
CREATE INDEX IF NOT EXISTS idx_ctxann_kind   ON context_annotations(kind);
