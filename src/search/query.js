/**
 * Semantic search over the ingested corpus.
 *
 *   node src/search/query.js "every time he talks about his wife" [--k 20] [--include-unreviewed]
 *
 * Embeds the query with the same model used at ingest, runs a pgvector ANN
 * search over utterance embeddings, and returns each hit WITH its source file,
 * exact timestamp, attribution + confidence, and review status — so a result is
 * immediately verifiable against the original footage.
 *
 * For oblique references ("his wife" when he says "my ex"), pass --expand to
 * fold in known aliases/nicknames from the taxonomy entities before searching.
 */
import 'dotenv/config';
import { config } from '../config.js';
import { connect, getPool } from '../db/index.js';
import { embedTexts } from '../adapters/models.js';

function parseArgs(argv) {
  const out = { k: 20, includeUnreviewed: false, expand: false, query: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--k') out.k = parseInt(argv[++i]);
    else if (argv[i] === '--include-unreviewed') out.includeUnreviewed = true;
    else if (argv[i] === '--expand') out.expand = true;
    else rest.push(argv[i]);
  }
  out.query = rest.join(' ');
  return out;
}

/** Fold known aliases/nicknames into the query text (project code-words). */
function expandQuery(query) {
  const entities = config.taxonomy.entities || [];
  const extra = [];
  for (const e of entities) {
    const terms = [e.canonical_name, ...(e.aliases || []), ...(e.nicknames || [])];
    if (terms.some((t) => t && query.toLowerCase().includes(t.toLowerCase()))) {
      extra.push(...terms.filter(Boolean));
    }
  }
  return extra.length ? `${query}\nrelated terms: ${[...new Set(extra)].join(', ')}` : query;
}

async function searchSqlite(db, vecFloat32, k, includeUnreviewed) {
  const reviewFilter = includeUnreviewed ? '' : 'AND (u.needs_review = 0 OR u.needs_review IS NULL)';
  const sql = `
    SELECT s.file_name, s.abs_path,
           m.start_sec, m.end_sec, m.content,
           u.speaker_name, u.speaker_confidence,
           u.audio_speaker, u.visual_speaker, u.attribution_method,
           u.attribution_confidence, u.attribution_conflict, u.needs_review,
           1 - v.distance AS similarity
    FROM (
      SELECT rowid, distance
      FROM embeddings_vec
      WHERE embedding MATCH ?
      AND k = ${k}
      ORDER BY distance
    ) v
    JOIN embeddings_meta m ON m.id = v.rowid
    JOIN sources s ON s.id = m.source_id
    LEFT JOIN utterances u ON u.id = m.ref_id AND m.ref_kind = 'utterance'
    WHERE m.modality = 'text' ${reviewFilter}
    ORDER BY v.distance`;
  return db.prepare(sql).all(vecFloat32);
}

async function searchPostgres(pool, vecJson, k, includeUnreviewed) {
  const reviewFilter = includeUnreviewed ? '' : 'AND (u.needs_review = FALSE OR u.needs_review IS NULL)';
  const sql = `
    SELECT s.file_name, s.abs_path,
           e.start_sec, e.end_sec, e.content,
           u.speaker_name, u.speaker_confidence,
           u.audio_speaker, u.visual_speaker, u.attribution_method,
           u.attribution_confidence, u.attribution_conflict, u.needs_review,
           1 - (e.embedding <=> $1) AS similarity
    FROM embeddings e
    JOIN sources s ON s.id = e.source_id
    LEFT JOIN utterances u ON u.id = e.ref_id AND e.ref_kind = 'utterance'
    WHERE e.modality = 'text' ${reviewFilter}
    ORDER BY e.embedding <=> $1
    LIMIT $2`;
  const r = await pool.query(sql, [vecJson, k]);
  return r.rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) { console.error('Usage: node src/search/query.js "<question>" [--k N] [--expand] [--include-unreviewed]'); process.exit(1); }

  await connect();
  const pool = getPool();
  if (!pool) { console.error('No database pool — cannot search.'); process.exit(1); }

  const queryText = args.expand ? expandQuery(args.query) : args.query;
  const emb = await embedTexts([queryText]);
  if (emb.skipped || !emb.vectors?.[0]) { console.error(`Embedding failed: ${emb.reason || 'no vector'}`); process.exit(1); }

  const storage = process.env.STORAGE || 'sqlite';
  let rows;
  if (storage === 'sqlite') {
    const vecFloat32 = Float32Array.from(emb.vectors[0]);
    rows = await searchSqlite(pool, vecFloat32, args.k, args.includeUnreviewed);
  } else {
    const vecJson = `[${emb.vectors[0].join(',')}]`;
    rows = await searchPostgres(pool, vecJson, args.k, args.includeUnreviewed);
  }

  if (!rows.length) { console.log('No matches. Try --expand or --include-unreviewed.'); process.exit(0); }

  console.log(`\nTop ${rows.length} matches for: "${args.query}"${args.expand ? ' (expanded)' : ''}\n`);
  for (const row of rows) {
    const ts = fmt(row.start_sec);
    const sim = (row.similarity * 100).toFixed(1);
    const who = row.speaker_name || row.visual_speaker || row.audio_speaker || 'unidentified speaker';
    const whoConf = row.speaker_confidence != null ? ` (${(row.speaker_confidence * 100).toFixed(0)}% match)` : '';
    const flags = [
      row.needs_review ? '⚠ verify' : null,
      row.attribution_conflict ? '⚠ attribution-conflict' : null,
    ].filter(Boolean).join(' · ');
    console.log(`[${sim}%] ${who}${whoConf} — ${row.file_name} @ ${ts} ${flags ? '— ' + flags : ''}`);
    console.log(`        "${(row.content || '').slice(0, 240)}"`);
    console.log(`        ${row.abs_path}\n`);
  }
  process.exit(0);
}

function fmt(sec) {
  if (sec == null) return '?';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
