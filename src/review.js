/**
 * Context-review pass — run AFTER ingest (or re-run whenever you update the case
 * context in config/context-review.prompt.md).
 *
 *   node src/review.js              # review every source not yet reviewed
 *   node src/review.js --all        # re-review everything (e.g. after prompt edits)
 *
 * ONE agent per media file, run with a small concurrency limit (precision over
 * throughput — too many at once dilutes attention). Backend + model + the case
 * context prompt are all configurable (GUI-editable; see settings.schema.json).
 */
import 'dotenv/config';
import { config } from './config.js';
import { connect, getPool, sourcesNeedingReview } from './db/forensic.js';
import { reviewSource } from './review/context.js';

async function main() {
  const all = process.argv.includes('--all');
  await connect();
  const pool = getPool();
  if (!pool) { console.error('No DATABASE_URL — nothing to review.'); process.exit(1); }

  let sources;
  if (all) {
    sources = (await pool.query('SELECT id, file_name FROM sources ORDER BY ingested_at')).rows;
  } else {
    sources = await sourcesNeedingReview();
  }
  console.log(`Context review: ${sources.length} source(s) | backend=${config.contextReview.backend} ` +
    `model=${config.contextReview.model} concurrency=${config.contextReview.concurrency}`);
  if (config.contextReview.backend === 'none') {
    console.log('Backend is "none" — set CONTEXT_REVIEW_BACKEND=claude-code (local) or openrouter.');
    process.exit(0);
  }

  // Simple concurrency-limited worker pool: one agent per file, N at a time.
  const queue = [...sources];
  let done = 0, stored = 0;
  async function worker(id) {
    while (queue.length) {
      const s = queue.shift();
      const res = await reviewSource(s.id);
      done++;
      if (res.skipped) console.log(`[w${id}] ${s.file_name}: skipped (${res.reason})`);
      else {
        stored += res.stored;
        console.log(`[w${id}] ${s.file_name}: ${res.stored} annotations [${res.significance}] — ${(res.summary || '').slice(0, 100)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, config.contextReview.concurrency) }, (_, i) => worker(i + 1)));

  console.log(`\nDone. Reviewed ${done} source(s), stored ${stored} annotations (all flagged unreviewed for human confirmation).`);
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
