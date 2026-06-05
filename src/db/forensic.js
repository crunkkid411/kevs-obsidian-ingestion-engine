/**
 * Forensic Postgres layer.
 *
 * Applies src/db/schema.sql and provides the small set of helpers the pipeline
 * needs for STAGE 0 (intake) plus chain-of-custody logging. Higher stages
 * (utterances, embeddings, inferences) write through `logCustody` + typed
 * inserts as they are wired up; the schema for all of them already exists.
 *
 * Everything here keys off the source SHA-256 so the evidence chain is intact.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pool = null;

export async function connect() {
  if (!config.db.url) {
    console.log('[DB] No DATABASE_URL configured — DB disabled (dry run).');
    return null;
  }
  pool = new Pool({
    connectionString: config.db.url,
    ssl: config.db.url.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 5,
  });
  const client = await pool.connect();
  try {
    const r = await client.query('SELECT NOW()');
    console.log(`[DB] Connected at ${r.rows[0].now}`);
  } finally {
    client.release();
  }
  await applySchema();
  return pool;
}

async function applySchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  try {
    await pool.query(sql);
    console.log('[DB] Forensic schema ready.');
  } catch (err) {
    // pgvector missing is the most common failure — surface it clearly.
    if (/vector/i.test(err.message)) {
      console.error('[DB] Schema failed — is the pgvector extension installed? ' +
        'On a managed Postgres enable it; locally: CREATE EXTENSION vector;');
    }
    throw err;
  }
}

/** Has this exact file (by hash) already been ingested? */
export async function isIngested(sha256) {
  if (!pool) return false;
  const r = await pool.query('SELECT id FROM sources WHERE sha256 = $1', [sha256]);
  return r.rows[0]?.id || null;
}

/** STAGE 0: register an immutable source. Idempotent on sha256. */
export async function registerSource(desc) {
  if (!pool) { console.log('[DB] (dry run) would register', desc.file_name); return null; }
  const r = await pool.query(
    `INSERT INTO sources (
       sha256, abs_path, file_name, byte_size, container, duration_sec,
       fps, fps_num, fps_den, frame_count, width, height, orientation,
       audio_streams, ffprobe_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (sha256) DO UPDATE SET abs_path = EXCLUDED.abs_path
     RETURNING id`,
    [
      desc.sha256, desc.abs_path, desc.file_name, desc.byte_size, desc.container,
      desc.duration_sec, desc.fps, desc.fps_num, desc.fps_den, desc.frame_count,
      desc.width, desc.height, desc.orientation, desc.audio_streams,
      JSON.stringify(desc.ffprobe_json || {}),
    ],
  );
  const id = r.rows[0].id;
  await logCustody(id, 'ingested', `registered ${desc.file_name} (${desc.sha256.slice(0, 12)}…)`, { actor: 'pipeline/stage0' });
  return id;
}

/** Append-only chain-of-custody event. */
export async function logCustody(sourceId, event, detail, opts = {}) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO chain_of_custody (source_id, event, detail, actor, model_name, model_version, params)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sourceId, event, detail || null, opts.actor || 'pipeline',
     opts.model_name || null, opts.model_version || null,
     opts.params ? JSON.stringify(opts.params) : null],
  );
}

/** Per-stage processing record (reproducibility). */
export async function logStage(sourceId, stage, status, opts = {}) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO processing_log (source_id, stage, status, determinism, model_name, model_version, params, error_message, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [sourceId, stage, status, opts.determinism || null, opts.model_name || null,
     opts.model_version || null, opts.params ? JSON.stringify(opts.params) : null,
     opts.error || null, opts.durationMs || null],
  );
}

// ── Typed inserts for the deterministic + model stages ────────────────────

/** Bulk insert ASR words (deterministic token timing). */
export async function insertWords(sourceId, words, asr) {
  if (!pool || !words?.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const w of words) {
      await client.query(
        `INSERT INTO transcript_words (source_id, word, start_sec, end_sec, confidence, asr_model, asr_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sourceId, w.word, w.start, w.end, w.confidence ?? null, asr?.model || null, asr?.version || null],
      );
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

/** Upsert a diarization-cluster speaker, return its id. */
export async function upsertSpeaker(sourceId, clusterLabel) {
  if (!pool) return null;
  const r = await pool.query(
    `INSERT INTO speakers (source_id, cluster_label) VALUES ($1,$2)
     ON CONFLICT (source_id, cluster_label) DO UPDATE SET cluster_label = EXCLUDED.cluster_label
     RETURNING id`,
    [sourceId, clusterLabel],
  );
  return r.rows[0].id;
}

/** Insert an utterance with full attribution provenance. */
export async function insertUtterance(sourceId, u) {
  if (!pool) return null;
  const r = await pool.query(
    `INSERT INTO utterances (
       source_id, start_sec, end_sec, text, speaker_id,
       audio_speaker, visual_speaker, attribution_method, attribution_confidence,
       attribution_conflict, needs_review
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [sourceId, u.start, u.end, u.text, u.speakerId || null,
     u.audioSpeaker || null, u.visualSpeaker || null, u.method || 'audio',
     u.confidence ?? null, !!u.conflict, !!u.needsReview],
  );
  return r.rows[0].id;
}

/** Insert a semantic embedding row (pgvector). */
export async function insertEmbedding(sourceId, e) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO embeddings (source_id, ref_kind, ref_id, modality, space, start_sec, end_sec, content, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [sourceId, e.refKind, e.refId || null, e.modality || 'text', e.space,
     e.start ?? null, e.end ?? null, e.content || null, vectorLiteral(e.vector)],
  );
}

// pgvector accepts a string like '[0.1,0.2,...]'
function vectorLiteral(v) {
  return Array.isArray(v) ? `[${v.join(',')}]` : v;
}

export function getPool() { return pool; }
