import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

let pool = null;

export async function connect() {
  if (!config.db.url) {
    console.log('[DB] No DATABASE_URL configured — DB disabled');
    return null;
  }

  pool = new Pool({
    connectionString: config.db.url,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });

  const client = await pool.connect();
  try {
    const res = await client.query('SELECT NOW()');
    console.log(`[DB] Connected at ${res.rows[0].now}`);
  } finally {
    client.release();
  }

  await createSchema();
  return pool;
}

async function createSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS videos (
      id                  SERIAL PRIMARY KEY,
      source_id           TEXT UNIQUE NOT NULL,
      file_name           TEXT NOT NULL,
      source_link         TEXT,
      content_type        TEXT,
      gender              TEXT,
      topic_areas         TEXT[],
      people_mentions     TEXT[],
      location            TEXT,
      tone                TEXT,
      production_quality  TEXT,
      confidence          FLOAT,
      summary             TEXT,
      duration            FLOAT,
      language            TEXT,
      status              TEXT DEFAULT 'auto-tagged',
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      processed_at        TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS transcripts (
      id          SERIAL PRIMARY KEY,
      video_id    INT REFERENCES videos(id) ON DELETE CASCADE,
      full_text   TEXT,
      segments    JSONB,
      key_quotes  JSONB,
      language    TEXT
    );

    CREATE TABLE IF NOT EXISTS frame_analyses (
      id                  SERIAL PRIMARY KEY,
      video_id            INT REFERENCES videos(id) ON DELETE CASCADE,
      frame_number        INT,
      timestamp           FLOAT,
      gender              TEXT,
      subject             TEXT,
      content_indicators  TEXT,
      faces_detected      INT,
      brightness          FLOAT,
      sharpness           FLOAT,
      resolution          TEXT
    );

    CREATE TABLE IF NOT EXISTS people_appearances (
      id            SERIAL PRIMARY KEY,
      video_id      INT REFERENCES videos(id) ON DELETE CASCADE,
      person_name   TEXT,
      detected_via  TEXT,
      role          TEXT,
      confidence    FLOAT
    );

    CREATE TABLE IF NOT EXISTS processing_log (
      id            SERIAL PRIMARY KEY,
      video_id      INT REFERENCES videos(id) ON DELETE CASCADE,
      step          TEXT,
      status        TEXT,
      error_message TEXT,
      duration_ms   INT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `;

  await pool.query(sql);
  console.log('[DB] Schema ready (5 tables)');
}

export async function insertVideo({ file, classification, transcript, visionAnalysis, sourceLink }) {
  if (!pool) {
    console.log('[DB] Skipping insert — not connected');
    return null;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const videoRes = await client.query(
      `INSERT INTO videos (
        source_id, file_name, source_link, content_type, gender,
        topic_areas, people_mentions, location, tone, production_quality,
        confidence, summary, duration, language, status, processed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (source_id) DO UPDATE SET
        content_type = EXCLUDED.content_type,
        gender = EXCLUDED.gender,
        topic_areas = EXCLUDED.topic_areas,
        people_mentions = EXCLUDED.people_mentions,
        confidence = EXCLUDED.confidence,
        summary = EXCLUDED.summary,
        processed_at = EXCLUDED.processed_at
      RETURNING id`,
      [
        file.id,
        file.name,
        sourceLink,
        classification.content_type,
        classification.gender,
        classification.topic_areas || [],
        classification.people_mentions || [],
        classification.location || null,
        classification.tone || null,
        classification.production_quality || null,
        classification.confidence,
        classification.summary,
        transcript.duration,
        transcript.language,
        'auto-tagged',
        new Date().toISOString(),
      ],
    );
    const videoId = videoRes.rows[0].id;

    await client.query(
      `INSERT INTO transcripts (video_id, full_text, segments, key_quotes, language)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [videoId, transcript.text, JSON.stringify(transcript.segments),
       JSON.stringify(classification.key_quotes || []), transcript.language],
    );

    const frames = visionAnalysis.frames || [];
    for (const frame of frames) {
      await client.query(
        `INSERT INTO frame_analyses (
          video_id, frame_number, timestamp, gender, subject,
          content_indicators, faces_detected, brightness, sharpness, resolution
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [videoId, frame.frame_number, frame.timestamp, frame.gender,
         frame.subject || frame.body_part, frame.content_indicators,
         frame.faces_detected || 0, frame.brightness || 0,
         frame.sharpness || 0, frame.resolution || null],
      );
    }

    const detectedPeople = classification.people_detected || [];
    for (const person of detectedPeople) {
      await client.query(
        `INSERT INTO people_appearances (video_id, person_name, detected_via, role, confidence)
         VALUES ($1, $2, $3, $4, $5)`,
        [videoId, person.name, person.detected_via || 'unknown',
         person.role || null, classification.confidence],
      );
    }

    await client.query(
      `INSERT INTO processing_log (video_id, step, status) VALUES ($1, $2, $3)`,
      [videoId, 'full_pipeline', 'success'],
    );

    await client.query('COMMIT');
    console.log(`[DB] Inserted video #${videoId}: ${file.name}`);
    return videoId;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[DB] Insert failed for ${file.name}:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

export async function isProcessed(sourceId) {
  if (!pool) return false;
  const res = await pool.query('SELECT id FROM videos WHERE source_id = $1', [sourceId]);
  return res.rows.length > 0;
}
