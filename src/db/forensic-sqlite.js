/**
 * Forensic SQLite layer — mirrors forensic.js (Postgres) table-for-table.
 *
 * Uses Node.js 24's built-in `node:sqlite` module (no extra dependency).
 * Extension: attempts to load sqlite-vec (vec0 virtual table for embeddings).
 *   If sqlite-vec is not yet installed, embedding inserts silently skip and
 *   a warning is logged once — all other stages still run.
 *
 * DB file: SQLITE_DB_PATH env (default: ./forensic.db in the project root).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

let db = null;
let vecEnabled = false;

// ── helpers ────────────────────────────────────────────────────────────────

function randomId() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');
}

// ── public API ─────────────────────────────────────────────────────────────

export async function connect() {
  const dbPath = process.env.SQLITE_DB_PATH
    ? path.resolve(process.cwd(), process.env.SQLITE_DB_PATH)
    : path.join(ROOT, 'forensic.db');

  db = new DatabaseSync(dbPath, { allowExtension: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  // Try to load sqlite-vec for vector embeddings.
  // node:sqlite requires { allowExtension: true } and paths without the .dll/.so suffix
  // (SQLite appends the platform suffix automatically).
  const vecBase = path.join(ROOT, 'models', 'sqlite-vec', 'vec0');
  const vecCandidates = [vecBase, vecBase + '.dll', vecBase + '.so', 'vec0'];
  for (const p of vecCandidates) {
    try { db.loadExtension(p); vecEnabled = true; break; } catch { /* next */ }
  }

  if (!vecEnabled) {
    console.warn('[DB] sqlite-vec not loaded — embedding inserts will be skipped until models/sqlite-vec/vec0.dll is present.');
  }

  // Apply schema (idempotent CREATE TABLE IF NOT EXISTS).
  let schema = fs.readFileSync(path.join(__dirname, 'schema.sqlite.sql'), 'utf-8');
  if (!vecEnabled) {
    // Skip the vec0 virtual table — requires the extension.
    schema = schema.replace(/CREATE VIRTUAL TABLE[\s\S]*?;/g, '');
  }
  db.exec(schema);
  console.log(`[DB] SQLite forensic DB ready: ${dbPath}${vecEnabled ? ' (sqlite-vec OK)' : ''}`);
  return db;
}

export async function isIngested(sha256) {
  if (!db) return false;
  const row = db.prepare('SELECT id FROM sources WHERE sha256 = ?').get(sha256);
  return row?.id || null;
}

export async function registerSource(desc) {
  if (!db) return null;
  const id = randomId();
  db.prepare(`
    INSERT INTO sources (
      id, sha256, abs_path, file_name, byte_size, container, duration_sec,
      fps, fps_num, fps_den, frame_count, width, height, orientation,
      audio_streams, ffprobe_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(sha256) DO UPDATE SET abs_path = excluded.abs_path
  `).run(
    id, desc.sha256, desc.abs_path, desc.file_name, desc.byte_size ?? null,
    desc.container ?? null, desc.duration_sec ?? null, desc.fps ?? null,
    desc.fps_num ?? null, desc.fps_den ?? null, desc.frame_count ?? null,
    desc.width ?? null, desc.height ?? null, desc.orientation ?? null,
    desc.audio_streams ?? 0, JSON.stringify(desc.ffprobe_json || {}),
  );
  const row = db.prepare('SELECT id FROM sources WHERE sha256 = ?').get(desc.sha256);
  const sourceId = row.id;
  await logCustody(sourceId, 'ingested', `registered ${desc.file_name} (${desc.sha256.slice(0, 12)}…)`, { actor: 'pipeline/stage0' });
  return sourceId;
}

export async function logCustody(sourceId, event, detail, opts = {}) {
  if (!db) return;
  db.prepare(`
    INSERT INTO chain_of_custody (source_id, event, detail, actor, model_name, model_version, params)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    sourceId, event, detail ?? null, opts.actor ?? 'pipeline',
    opts.model_name ?? null, opts.model_version ?? null,
    opts.params ? JSON.stringify(opts.params) : null,
  );
}

export async function logStage(sourceId, stage, status, opts = {}) {
  if (!db) return;
  db.prepare(`
    INSERT INTO processing_log (source_id, stage, status, determinism, model_name, model_version, params, error_message, duration_ms)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    sourceId, stage, status, opts.determinism ?? null, opts.model_name ?? null,
    opts.model_version ?? null, opts.params ? JSON.stringify(opts.params) : null,
    opts.error ?? null, opts.durationMs ?? null,
  );
}

export async function insertWords(sourceId, words, asr) {
  if (!db || !words?.length) return;
  const stmt = db.prepare(`
    INSERT INTO transcript_words (source_id, word, start_sec, end_sec, confidence, asr_model, asr_version)
    VALUES (?,?,?,?,?,?,?)
  `);
  db.exec('BEGIN');
  try {
    for (const w of words) {
      stmt.run(sourceId, w.word, w.start, w.end, w.confidence ?? null, asr?.model ?? null, asr?.version ?? null);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export async function upsertSpeaker(sourceId, clusterLabel) {
  if (!db) return null;
  const id = randomId();
  db.prepare(`
    INSERT INTO speakers (id, source_id, cluster_label) VALUES (?,?,?)
    ON CONFLICT(source_id, cluster_label) DO NOTHING
  `).run(id, sourceId, clusterLabel);
  return db.prepare('SELECT id FROM speakers WHERE source_id=? AND cluster_label=?')
    .get(sourceId, clusterLabel)?.id ?? null;
}

export async function insertUtterance(sourceId, u) {
  if (!db) return null;
  const id = randomId();
  db.prepare(`
    INSERT INTO utterances (
      id, source_id, start_sec, end_sec, text, speaker_id,
      speaker_name, speaker_confidence,
      audio_speaker, visual_speaker, attribution_method, attribution_confidence,
      attribution_conflict, needs_review
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, sourceId, u.start, u.end, u.text, u.speakerId ?? null,
    u.speakerName ?? null, u.speakerConfidence ?? null,
    u.audioSpeaker ?? null, u.visualSpeaker ?? null, u.method ?? 'audio',
    u.confidence ?? null, u.conflict ? 1 : 0, u.needsReview ? 1 : 0,
  );
  return id;
}

export async function insertEmbedding(sourceId, e) {
  if (!db || !vecEnabled) return;
  const metaStmt = db.prepare(`
    INSERT INTO embeddings_meta (source_id, ref_kind, ref_id, modality, space, start_sec, end_sec, content)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  db.exec('BEGIN');
  try {
    const info = metaStmt.run(
      sourceId, e.refKind, e.refId ?? null, e.modality ?? 'text', e.space,
      e.start ?? null, e.end ?? null, e.content ?? null,
    );
    // node:sqlite passes JS Numbers as REAL (float); sqlite-vec rejects that for
    // rowid. Put the rowid (a trusted internal BigInt) directly in the SQL literal
    // and pass only the Float32Array as a parameter — that binding always works.
    const rowid = info.lastInsertRowid; // BigInt from node:sqlite
    const vec = Float32Array.from(Array.isArray(e.vector) ? e.vector : Array.from(e.vector));
    db.prepare(`INSERT INTO embeddings_vec(rowid, embedding) VALUES (${rowid}, ?)`).run(vec);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export async function insertEvent(sourceId, e) {
  if (!db) return null;
  const id = randomId();
  db.prepare(`
    INSERT INTO events (id, source_id, kind, start_sec, end_sec, start_frame, end_frame, confidence, detail, evidence, needs_review)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, sourceId, e.kind, e.start_sec, e.end_sec ?? null,
    e.start_frame ?? null, e.end_frame ?? null, e.confidence ?? null,
    e.detail ?? null, e.evidence ? JSON.stringify(e.evidence) : null, 1,
  );
  return id;
}

export async function insertFrameSignature(sourceId, s) {
  if (!db) return;
  db.prepare(`
    INSERT INTO frame_signatures (source_id, at_sec, at_frame, ahash, frame_path)
    VALUES (?,?,?,?,?)
  `).run(sourceId, s.timestamp ?? null, s.frame_index ?? null, s.ahash, s.path ?? null);
}

export async function insertLocationOfInterest(sourceId, l) {
  if (!db) return;
  const id = randomId();
  db.prepare(`
    INSERT INTO locations_of_interest (id, source_id, start_sec, end_sec, representative_frame, ahash, location_name, location_confidence, recording_date, exported_dir)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, sourceId, l.start_sec, l.end_sec ?? null, l.representative_frame ?? null,
    l.ahash ?? null, l.location_name ?? null, l.location_confidence ?? null,
    l.recording_date ?? null, l.exported_dir ?? null,
  );
}

export async function sourcesNeedingReview() {
  if (!db) return [];
  return db.prepare(`
    SELECT s.id, s.file_name FROM sources s
    WHERE NOT EXISTS (SELECT 1 FROM context_annotations c WHERE c.source_id = s.id)
    ORDER BY s.ingested_at
  `).all();
}

export async function gatherForReview(sourceId) {
  if (!db) return null;
  const utt = db.prepare('SELECT start_sec, end_sec, speaker_name, text FROM utterances WHERE source_id=? ORDER BY start_sec').all(sourceId);
  const ev  = db.prepare('SELECT kind, start_sec, end_sec, detail FROM events WHERE source_id=? ORDER BY start_sec').all(sourceId);
  const loc = db.prepare('SELECT start_sec, location_name FROM locations_of_interest WHERE source_id=? ORDER BY start_sec').all(sourceId);
  const src = db.prepare('SELECT file_name FROM sources WHERE id=?').get(sourceId);
  return { file_name: src?.file_name, utterances: utt, events: ev, locations: loc };
}

export async function insertContextAnnotation(sourceId, a) {
  if (!db) return;
  const id = randomId();
  db.prepare(`
    INSERT INTO context_annotations (id, source_id, kind, start_sec, end_sec, surface_text, linked_name, note, rationale, significance, confidence, backend, model_name, prompt_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, sourceId, a.kind ?? 'nuance', a.start_sec ?? null, a.end_sec ?? null,
    a.surface_text ?? null, a.linked_entity ?? null, a.note ?? null,
    a.rationale ?? null, a.significance ?? null, a.confidence ?? null,
    a.backend ?? null, a.model_name ?? null, a.prompt_hash ?? null,
  );
}

/**
 * Load all voice (and optionally face) enrollments for use during ingestion.
 * Reads from the `voice_enrollments` table populated by scripts/enroll_voice.py.
 * Returns [{ entity_name, modality, embedding: Float32Array }]
 */
export function loadEnrollments() {
  if (!db) return [];
  // voice_enrollments may not exist yet (created on first enrollment)
  let rows;
  try {
    rows = db.prepare(
      'SELECT entity_name, modality, embedding FROM voice_enrollments ORDER BY enrolled_at'
    ).all();
  } catch {
    // Table doesn't exist yet — no enrollments
    return [];
  }
  return rows.map((r) => ({
    entity_name: r.entity_name,
    modality: r.modality,
    // embedding is stored as a packed float32 BLOB; convert to Float32Array
    embedding: new Float32Array(r.embedding.buffer ?? r.embedding),
  }));
}

/** Returns the raw db handle (used by query.js for ad-hoc queries). */
export function getPool() { return db; }
