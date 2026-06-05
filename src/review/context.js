/**
 * Per-media context-review stage. For ONE source: assemble its transcript +
 * data points, send them with the case-context system prompt to the configured
 * agent, parse the JSON result, and store each annotation as a reviewable claim.
 *
 * One source per call = one agent per media file (the design that preserves
 * nuance). The entrypoint src/review.js runs this across sources with a
 * concurrency limit.
 */
import fs from 'fs/promises';
import crypto from 'crypto';
import { config } from '../config.js';
import { runReviewAgent } from './backends.js';
import { gatherForReview, insertContextAnnotation, logCustody } from '../db/forensic.js';

function fmt(sec) {
  if (sec == null) return '?';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Build the per-video user prompt from its transcript + detected data points. */
function buildUserPrompt(data) {
  const lines = [`VIDEO: ${data.file_name}`, '', 'TRANSCRIPT (timestamp | speaker | text):'];
  for (const u of data.utterances) {
    lines.push(`[${fmt(u.start_sec)}] ${u.speaker_name || 'unidentified'}: ${u.text}`);
  }
  if (data.events.length) {
    lines.push('', 'DETECTED EVENTS:');
    for (const e of data.events) lines.push(`[${fmt(e.start_sec)}] ${e.kind} — ${e.detail || ''}`);
  }
  if (data.locations.length) {
    lines.push('', 'DETECTED LOCATIONS:');
    for (const l of data.locations) lines.push(`[${fmt(l.start_sec)}] ${l.location_name || 'unknown location'}`);
  }
  lines.push('', 'Analyze per your instructions and return ONLY the JSON object.');
  return lines.join('\n');
}

function parseResult(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** Review a single source. Returns { stored, summary } or { skipped }. */
export async function reviewSource(sourceId) {
  const cr = config.contextReview;
  if (cr.backend === 'none') return { skipped: true, reason: 'CONTEXT_REVIEW_BACKEND=none' };

  const data = await gatherForReview(sourceId);
  if (!data || !data.utterances?.length) return { skipped: true, reason: 'no transcript to review' };

  const system = await fs.readFile(cr.promptPath, 'utf-8');
  const promptHash = crypto.createHash('sha256').update(system).digest('hex').slice(0, 16);
  const user = buildUserPrompt(data);

  let raw;
  try {
    raw = await runReviewAgent({ backend: cr.backend, model: cr.model, system, user });
  } catch (err) {
    return { skipped: true, reason: `review agent failed: ${err.message}` };
  }
  const result = parseResult(raw);
  if (!result) return { skipped: true, reason: 'agent returned no parseable JSON' };

  const anns = result.annotations || [];
  for (const a of anns) {
    await insertContextAnnotation(sourceId, {
      ...a, significance: a.significance || result.overall_significance,
      backend: cr.backend, model_name: cr.model, prompt_hash: promptHash,
    });
  }
  await logCustody(sourceId, 'stage_run',
    `context review: ${anns.length} annotations (significance ${result.overall_significance})`,
    { actor: 'pipeline/context-review', model_name: cr.model, params: { backend: cr.backend, prompt_hash: promptHash } });
  return { stored: anns.length, summary: result.summary, significance: result.overall_significance };
}
