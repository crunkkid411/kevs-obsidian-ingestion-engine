-- Forensic video-ingestion schema.
--
-- Design goals (see docs/ARCHITECTURE.md):
--   * Sources are immutable; everything derived is keyed by source SHA-256.
--   * Segment / utterance grain, not per-video, so search returns exact moments.
--   * Every non-deterministic (model) output records its provenance and a
--     confidence, and is separated from deterministic facts.
--   * Append-only chain_of_custody for auditability.
--
-- Requires the pgvector extension for semantic search.
-- The embedding vector DIMENSION must match the embedding model you choose:
--   Qwen3-Embedding-0.6B = 1024,  Qwen3-Embedding-4B = 2560,  8B = 4096.
-- Default below is 1024. If you change models, change the vector(N) dimensions
-- and re-embed.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ───────────────────────────────────────────────────────────────────────────
-- SOURCES  (immutable originals — grain: one video file)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256          TEXT UNIQUE NOT NULL,         -- chain-of-custody anchor
  abs_path        TEXT NOT NULL,                -- where the file was read from
  file_name       TEXT NOT NULL,
  byte_size       BIGINT,
  container       TEXT,                         -- mp4, mkv, mov...
  duration_sec    DOUBLE PRECISION,
  fps             DOUBLE PRECISION,             -- exact avg frame rate
  fps_num         INTEGER,                      -- exact rational fps numerator
  fps_den         INTEGER,                      -- and denominator
  frame_count     BIGINT,
  width           INTEGER,
  height          INTEGER,
  orientation     TEXT,                         -- vertical | horizontal | square
  audio_streams   INTEGER,
  ffprobe_json    JSONB,                        -- full deterministic metadata
  recorded_at     TIMESTAMPTZ,                  -- if known (container metadata)
  ingested_at     TIMESTAMPTZ DEFAULT NOW(),
  status          TEXT DEFAULT 'ingested'       -- ingested|processing|done|error
);

-- ───────────────────────────────────────────────────────────────────────────
-- CHAIN OF CUSTODY  (append-only audit log)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chain_of_custody (
  id            BIGSERIAL PRIMARY KEY,
  source_id     UUID REFERENCES sources(id) ON DELETE RESTRICT,
  event         TEXT NOT NULL,                  -- ingested|hashed|stage_run|export|review
  detail        TEXT,
  actor         TEXT,                           -- tool/user that performed it
  model_name    TEXT,
  model_version TEXT,
  params        JSONB,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────────────────────
-- SEGMENTS  (time windows: shots, scenes, utterance windows)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_segments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     UUID REFERENCES sources(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                  -- shot|scene|utterance|topic|manual
  start_sec     DOUBLE PRECISION NOT NULL,
  end_sec       DOUBLE PRECISION NOT NULL,
  start_frame   BIGINT,                         -- exact frame index (deterministic)
  end_frame     BIGINT,
  label         TEXT,
  created_by    TEXT DEFAULT 'deterministic'    -- deterministic|model_inference|human
);
CREATE INDEX IF NOT EXISTS idx_segments_source ON media_segments(source_id);
CREATE INDEX IF NOT EXISTS idx_segments_time   ON media_segments(source_id, start_sec);

-- ───────────────────────────────────────────────────────────────────────────
-- TRANSCRIPT  (deterministic ASR token timing)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transcript_words (
  id            BIGSERIAL PRIMARY KEY,
  source_id     UUID REFERENCES sources(id) ON DELETE CASCADE,
  word          TEXT NOT NULL,
  start_sec     DOUBLE PRECISION NOT NULL,
  end_sec       DOUBLE PRECISION NOT NULL,
  confidence    DOUBLE PRECISION,
  asr_model     TEXT,
  asr_version   TEXT
);
CREATE INDEX IF NOT EXISTS idx_words_source ON transcript_words(source_id, start_sec);

-- ───────────────────────────────────────────────────────────────────────────
-- SPEAKERS  (diarization clusters within a source; may link to an entity)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS speakers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     UUID REFERENCES sources(id) ON DELETE CASCADE,
  cluster_label TEXT NOT NULL,                  -- e.g. "spk_0" from Sortformer
  entity_id     UUID,                           -- resolved identity (nullable)
  link_method   TEXT,                           -- audio|visual|both|manual
  link_confidence DOUBLE PRECISION,
  UNIQUE (source_id, cluster_label)
);

-- ───────────────────────────────────────────────────────────────────────────
-- UTTERANCES  (speech turns: text + attributed speaker + CONFIDENCE)
-- This is the heart of the misattribution defense. attribution_confidence and
-- conflict flags are first-class; low-confidence rows are review-gated.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS utterances (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id              UUID REFERENCES sources(id) ON DELETE CASCADE,
  segment_id             UUID REFERENCES media_segments(id) ON DELETE SET NULL,
  start_sec              DOUBLE PRECISION NOT NULL,
  end_sec                DOUBLE PRECISION NOT NULL,
  text                   TEXT NOT NULL,
  speaker_id             UUID REFERENCES speakers(id) ON DELETE SET NULL,
  -- attribution provenance
  audio_speaker          TEXT,                  -- what diarization said
  visual_speaker         TEXT,                  -- what active-speaker-detection said
  attribution_method     TEXT,                  -- audio|visual|both|unresolved
  attribution_confidence DOUBLE PRECISION,
  attribution_conflict   BOOLEAN DEFAULT FALSE, -- audio != visual, or off-screen
  needs_review           BOOLEAN DEFAULT FALSE,
  reviewed_by            TEXT,
  reviewed_at            TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_utt_source ON utterances(source_id, start_sec);
CREATE INDEX IF NOT EXISTS idx_utt_review ON utterances(needs_review) WHERE needs_review;

-- ───────────────────────────────────────────────────────────────────────────
-- ENTITIES  (people / places / things; aliases, nicknames, timeline anchors)
-- Powers oblique-reference resolution ("my ex" -> the wife).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name  TEXT NOT NULL,
  entity_type     TEXT DEFAULT 'person',        -- person|place|org|object|event
  aliases         TEXT[] DEFAULT '{}',          -- explicit alternative names
  nicknames       TEXT[] DEFAULT '{}',          -- audience inside-jokes / coded refs
  descriptions    TEXT[] DEFAULT '{}',          -- physical / contextual descriptions
  timeline_anchors JSONB DEFAULT '[]',          -- [{event, date, note}] for inference
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(canonical_name);

-- ───────────────────────────────────────────────────────────────────────────
-- REFERENCE RESOLUTIONS  (segment -> entity CLAIMS, with rationale + review)
-- A claim is never a fact until reviewed. Search can include/exclude unreviewed.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reference_resolutions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     UUID REFERENCES sources(id) ON DELETE CASCADE,
  segment_id    UUID REFERENCES media_segments(id) ON DELETE SET NULL,
  utterance_id  UUID REFERENCES utterances(id) ON DELETE SET NULL,
  surface_text  TEXT,                           -- the oblique phrase as said
  entity_id     UUID REFERENCES entities(id) ON DELETE SET NULL,
  rationale     TEXT,                           -- WHY the model linked it
  confidence    DOUBLE PRECISION,
  model_name    TEXT,
  model_version TEXT,
  review_status TEXT DEFAULT 'unreviewed',      -- unreviewed|confirmed|rejected
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_refres_entity ON reference_resolutions(entity_id);

-- ───────────────────────────────────────────────────────────────────────────
-- VISUAL OBSERVATIONS  (what a vision model saw, with provenance)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS visual_observations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     UUID REFERENCES sources(id) ON DELETE CASCADE,
  segment_id    UUID REFERENCES media_segments(id) ON DELETE SET NULL,
  at_sec        DOUBLE PRECISION,
  at_frame      BIGINT,
  observation   TEXT,                           -- description / detected content
  tags          TEXT[] DEFAULT '{}',
  model_name    TEXT,
  model_version TEXT,
  confidence    DOUBLE PRECISION
);
CREATE INDEX IF NOT EXISTS idx_visobs_source ON visual_observations(source_id, at_sec);

-- ───────────────────────────────────────────────────────────────────────────
-- EMBEDDINGS  (pgvector — semantic + multimodal search)
-- One row per embedded item (an utterance, a segment summary, or a frame).
-- vector dimension MUST match the model (see header note).
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS embeddings (
  id            BIGSERIAL PRIMARY KEY,
  source_id     UUID REFERENCES sources(id) ON DELETE CASCADE,
  ref_kind      TEXT NOT NULL,                  -- utterance|segment|frame
  ref_id        UUID,                           -- id of the referenced row
  modality      TEXT NOT NULL,                  -- text|image|multimodal
  space         TEXT NOT NULL,                  -- model id that produced it
  start_sec     DOUBLE PRECISION,               -- for direct timestamp linking
  end_sec       DOUBLE PRECISION,
  content       TEXT,                           -- the text that was embedded (if text)
  embedding     vector(1024)                    -- CHANGE dim to match your model
);
-- Approximate-nearest-neighbour index (cosine). Build after bulk load.
CREATE INDEX IF NOT EXISTS idx_embeddings_ann
  ON embeddings USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_embeddings_ref ON embeddings(ref_kind, ref_id);

-- ───────────────────────────────────────────────────────────────────────────
-- INFERENCES  (generic provenance ledger for ANY model output)
-- Anything an LLM/VLM asserts that isn't captured by a typed table above goes
-- here, so nothing model-generated is ever stored without provenance.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inferences (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     UUID REFERENCES sources(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                  -- topic|summary|flag|classification...
  input_refs    JSONB,                          -- what rows/timespans fed it
  output        JSONB,                          -- structured model output
  model_name    TEXT,
  model_version TEXT,
  prompt_hash   TEXT,                           -- hash of the exact prompt used
  params        JSONB,
  confidence    DOUBLE PRECISION,
  determinism   TEXT DEFAULT 'model_inference', -- always for this table
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inferences_source ON inferences(source_id, kind);

-- ───────────────────────────────────────────────────────────────────────────
-- PROCESSING LOG  (per-stage run record for reproducibility)
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS processing_log (
  id            BIGSERIAL PRIMARY KEY,
  source_id     UUID REFERENCES sources(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL,                  -- success|error|skipped
  determinism   TEXT,                           -- deterministic|model_inference
  model_name    TEXT,
  model_version TEXT,
  params        JSONB,
  error_message TEXT,
  duration_ms   INTEGER,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
