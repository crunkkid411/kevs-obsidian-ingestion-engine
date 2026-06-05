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
import { connect, getPool } from './db/forensic.js';

async function coverage(pool) {
  const total = (await pool.query('SELECT count(*)::int AS n FROM sources')).rows[0].n;

  const named = (await pool.query(`
    SELECT speaker_name, count(DISTINCT source_id)::int AS videos, count(*)::int AS utterances
    FROM utterances
    WHERE speaker_name IS NOT NULL AND speaker_name NOT ILIKE 'unidentified%'
    GROUP BY speaker_name ORDER BY videos DESC`)).rows;

  const unident = (await pool.query(`
    SELECT count(*)::int AS utterances, count(DISTINCT source_id)::int AS videos
    FROM utterances WHERE speaker_name IS NULL OR speaker_name ILIKE 'unidentified%'`)).rows[0];

  const places = (await pool.query(`
    SELECT location_name, count(DISTINCT source_id)::int AS videos
    FROM locations_of_interest WHERE location_name IS NOT NULL
    GROUP BY location_name ORDER BY videos DESC`)).rows;

  console.log(`\n=== COVERAGE (${total} videos) ===`);
  if (!named.length) console.log('No named speakers yet — enroll a voice/face for each person of interest.');
  for (const r of named) {
    const pct = total ? ((r.videos / total) * 100).toFixed(0) : '0';
    const warn = total && r.videos / total < 0.5 ? '  ⚠ low — check enrollment/threshold' : '';
    console.log(`  ${r.speaker_name}: recognized in ${r.videos}/${total} videos (${pct}%), ${r.utterances} utterances${warn}`);
  }
  console.log(`  unidentified: ${unident.utterances} utterances across ${unident.videos} videos`);
  if (places.length) {
    console.log(`  locations:`);
    for (const p of places) console.log(`    ${p.location_name}: ${p.videos}/${total} videos`);
  }
}

/**
 * Propagate human-confirmed speaker names. If a reviewer set speakers.entity_id
 * for a cluster (link_method='manual'), copy the entity's canonical name onto
 * that source's utterances for that cluster. (Cross-video voice/face matching is
 * the native build's job; this applies confirmed within-source bindings + keeps
 * names consistent.)
 */
async function propagate(pool) {
  const r = await pool.query(`
    UPDATE utterances u
    SET speaker_name = e.canonical_name, speaker_confidence = 1.0
    FROM speakers s
    JOIN entities e ON e.id = s.entity_id
    WHERE u.speaker_id = s.id AND s.entity_id IS NOT NULL
      AND (u.speaker_name IS NULL OR u.speaker_name ILIKE 'unidentified%')
    `);
  console.log(`\n=== PROPAGATION ===\n  applied confirmed names to ${r.rowCount} utterances`);
}

async function main() {
  await connect();
  const pool = getPool();
  if (!pool) { console.error('No DATABASE_URL — nothing to consolidate.'); process.exit(1); }
  await propagate(pool);
  await coverage(pool);
  console.log('\nTip: low-coverage names usually mean a missing/weak voice or face ' +
    'enrollment, or an ASD/identification threshold set too strict.');
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
