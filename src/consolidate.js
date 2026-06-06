/**
 * Consolidation / "learning" pass — run periodically (e.g. nightly) or after a
 * review session. Two jobs:
 *
 *   1. PROPAGATE confirmed identities across the corpus. When a reviewer confirms
 *      "this voice/face is the Defendant" (an enrollment), apply that name to
 *      every matching speaker cluster in every other video. (Voice/face matching
 *      is model-gated in the native build; here we do the deterministic part:
 *      propagate a confirmed cluster->entity binding to identical clusters and
 *      reconcile names.)
 *
 *   2. REPORT COVERAGE so accuracy gaps are visible — the whole point of naming
 *      confidently. "Defendant recognized in 47/92 videos" tells you enrollment
 *      or thresholds need work; a system that only ever says "a speaker" hides
 *      that completely.
 *
 *   node src/consolidate.js
 */
import 'dotenv/config';
import { connect, getPool } from './db/index.js';

function coverage(db) {
  const totalRow = db.prepare('SELECT count(*) AS n FROM sources').get();
  const total = totalRow ? Number(totalRow.n) : 0;

  const named = db.prepare(`
    SELECT speaker_name, count(DISTINCT source_id) AS videos, count(*) AS utterances
    FROM utterances
    WHERE speaker_name IS NOT NULL AND lower(speaker_name) NOT LIKE 'unidentified%'
    GROUP BY speaker_name ORDER BY videos DESC
  `).all();

  const unident = db.prepare(`
    SELECT count(*) AS utterances, count(DISTINCT source_id) AS videos
    FROM utterances WHERE speaker_name IS NULL OR lower(speaker_name) LIKE 'unidentified%'
  `).get();

  const places = db.prepare(`
    SELECT location_name, count(DISTINCT source_id) AS videos
    FROM locations_of_interest WHERE location_name IS NOT NULL
    GROUP BY location_name ORDER BY videos DESC
  `).all();

  const needsReview = db.prepare(`
    SELECT count(*) AS n FROM utterances WHERE needs_review = 1
  `).get();

  console.log(`\n=== COVERAGE (${total} videos) ===`);
  if (!named.length) console.log('  No named speakers yet — enroll a voice/face for each person of interest.');
  for (const r of named) {
    const videos = Number(r.videos);
    const utterances = Number(r.utterances);
    const pct = total ? ((videos / total) * 100).toFixed(0) : '0';
    const warn = total && videos / total < 0.5 ? '  ⚠ low — check enrollment/threshold' : '';
    console.log(`  ${r.speaker_name}: recognized in ${videos}/${total} videos (${pct}%), ${utterances} utterances${warn}`);
  }
  const unidentUtterances = Number(unident?.utterances ?? 0);
  const unidentVideos = Number(unident?.videos ?? 0);
  console.log(`  unidentified: ${unidentUtterances} utterances across ${unidentVideos} videos`);
  console.log(`  needs_review: ${Number(needsReview?.n ?? 0)} utterances flagged`);
  if (places.length) {
    console.log('  locations:');
    for (const p of places) console.log(`    ${p.location_name}: ${Number(p.videos)}/${total} videos`);
  }
}

/**
 * Propagate human-confirmed speaker names. If a reviewer set speakers.entity_id
 * for a cluster (link_method='manual'), copy the entity's canonical name onto
 * that source's utterances for that cluster.
 */
function propagate(db) {
  // Check if entities table has any rows first
  const entityCount = db.prepare('SELECT count(*) AS n FROM entities').get();
  if (!entityCount || Number(entityCount.n) === 0) {
    console.log('\n=== PROPAGATION ===\n  no confirmed entity bindings yet (no manual speaker links)');
    return;
  }

  const result = db.prepare(`
    UPDATE utterances
    SET speaker_name = (
      SELECT e.canonical_name FROM speakers s
      JOIN entities e ON e.id = s.entity_id
      WHERE s.id = utterances.speaker_id AND s.entity_id IS NOT NULL
    ),
    speaker_confidence = 1.0
    WHERE speaker_id IN (
      SELECT s.id FROM speakers s
      WHERE s.entity_id IS NOT NULL
        AND (utterances.speaker_name IS NULL OR lower(utterances.speaker_name) LIKE 'unidentified%')
    )
  `).run();

  console.log(`\n=== PROPAGATION ===\n  applied confirmed names to ${result.changes} utterances`);
}

async function main() {
  await connect();
  const db = getPool();
  if (!db) { console.error('No DB connection — nothing to consolidate.'); process.exit(1); }
  propagate(db);
  coverage(db);
  console.log('\nTip: low-coverage names usually mean a missing/weak voice or face ' +
    'enrollment, or an ASD/identification threshold set too strict.');
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
