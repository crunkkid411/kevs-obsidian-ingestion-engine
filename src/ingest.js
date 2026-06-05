/**
 * Forensic ingestion orchestrator.
 *
 *   node src/ingest.js "D:\\path\\to\\footage"      (or set LOCAL_ROOT in .env)
 *
 * STAGE 0 (intake: hash + ffprobe + register + chain-of-custody) is fully
 * implemented and runs with only ffmpeg + Postgres. The model stages call the
 * adapters in src/adapters/models.js and DEGRADE GRACEFULLY: if a model isn't
 * wired yet they log a skip and the run continues, so you can enable the
 * pipeline piece by piece on the GPU machine.
 *
 * Evidence safety: source files are read-only. Nothing here ever writes to,
 * moves, or deletes an original. Only ./tmp/work scratch is written.
 */
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { config } from './config.js';
import * as local from './sources/local.js';
import * as M from './adapters/models.js';
import {
  connect, isIngested, registerSource, logCustody, logStage,
  insertWords, upsertSpeaker, insertUtterance, insertEmbedding,
} from './db/forensic.js';

async function timed(fn) {
  const t = Date.now();
  const out = await fn();
  return [out, Date.now() - t];
}

/** Deterministic: group ASR words into utterances using diarization turns. */
function buildUtterances(words, turns) {
  if (!words?.length) return [];
  if (turns?.length) {
    return turns.map((turn) => {
      const inTurn = words.filter((w) => {
        const mid = (w.start + w.end) / 2;
        return mid >= turn.start && mid < turn.end;
      });
      return {
        start: turn.start,
        end: turn.end,
        text: inTurn.map((w) => w.word).join(' ').replace(/\s+([,.!?])/g, '$1').trim(),
        audioSpeaker: turn.speaker,
      };
    }).filter((u) => u.text);
  }
  // No diarization: split on >0.8s silence gaps between words (deterministic).
  const out = [];
  let cur = null;
  for (const w of words) {
    if (!cur || w.start - cur.end > 0.8) {
      if (cur) out.push(cur);
      cur = { start: w.start, end: w.end, text: w.word, audioSpeaker: null };
    } else {
      cur.text += ' ' + w.word;
      cur.end = w.end;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function processSource(entry, idx, total) {
  console.log(`\n${'='.repeat(70)}\n[${idx + 1}/${total}] ${entry.name}\n${'='.repeat(70)}`);

  // ── STAGE 0 — intake (deterministic) ────────────────────────────────────
  console.log('[stage0] hashing + probing (immutable, read-only)…');
  let desc;
  try {
    desc = await local.describeSource(entry.path);
  } catch (err) {
    console.error(`[stage0] FAILED to read/probe: ${err.message}`);
    return;
  }
  const existing = await isIngested(desc.sha256);
  if (existing) { console.log(`[stage0] already ingested (${desc.sha256.slice(0, 12)}…) — skipping.`); return; }
  const sourceId = await registerSource(desc);
  console.log(`[stage0] registered ${desc.orientation} ${desc.width}x${desc.height} @ ${desc.fps?.toFixed?.(3)}fps, ` +
    `${desc.duration_sec ? (desc.duration_sec / 60).toFixed(1) : '?'}min`);

  const work = path.join(config.tempDir, desc.sha256.slice(0, 16));
  await fs.mkdir(work, { recursive: true });
  const wav = path.join(work, 'audio.wav');

  try {
    // ── STAGE 1 — audio + ASR ─────────────────────────────────────────────
    let words = [], asrMeta = null;
    const hasAudio = (desc.audio_streams || 0) > 0;
    if (!hasAudio) console.log('[stage1] no audio stream — skipping ASR + diarization');
    try {
      if (!hasAudio) throw Object.assign(new Error('no audio stream'), { soft: true });
      await M.demuxAudio(entry.path, wav);
      const [asr, ms] = await timed(() => M.runASR(wav));
      if (asr.skipped) { console.log(`[stage1] ASR skipped: ${asr.reason}`); }
      else {
        words = asr.words || [];
        asrMeta = { model: asr.model, version: asr.version };
        await insertWords(sourceId, words, asrMeta);
        await logStage(sourceId, 'asr', 'success', { determinism: 'deterministic', model_name: asr.model, model_version: asr.version, durationMs: ms });
        console.log(`[stage1] ASR: ${words.length} words`);
      }
    } catch (err) {
      if (!err.soft) { console.log(`[stage1] ASR error: ${err.message}`); await logStage(sourceId, 'asr', 'error', { error: err.message }); }
    }

    // ── STAGE 2 — audio diarization ───────────────────────────────────────
    let turns = [];
    try {
      if (!hasAudio) throw Object.assign(new Error('no audio'), { soft: true });
      const [diar, ms] = await timed(() => M.runDiarization(wav));
      if (diar.skipped) console.log(`[stage2] diarization skipped: ${diar.reason}`);
      else {
        turns = diar.turns || [];
        for (const label of new Set(turns.map((t) => t.speaker))) await upsertSpeaker(sourceId, label);
        await logStage(sourceId, 'diarization', 'success', { determinism: 'model_inference', model_name: diar.model, durationMs: ms });
        console.log(`[stage2] diarization: ${turns.length} turns, ${new Set(turns.map((t) => t.speaker)).size} speakers`);
      }
    } catch (err) { if (!err.soft) console.log(`[stage2] diarization error: ${err.message}`); }

    // ── STAGE 3 — visual active-speaker detection (misattribution fix) ─────
    let asd = null;
    try {
      const [res] = await timed(() => M.runASD(entry.path, turns));
      if (res.skipped) console.log(`[stage3] visual ASD skipped: ${res.reason} (utterances will be flagged needs_review)`);
      else { asd = res.results || []; console.log(`[stage3] visual ASD: ${asd.length} verified turns`); }
    } catch (err) { console.log(`[stage3] ASD error: ${err.message}`); }

    // ── STAGE 4 — utterances with attribution + confidence ────────────────
    const utterances = buildUtterances(words, turns);
    const floor = config.models.asd.confidenceFloor;
    const utterRows = [];
    for (const u of utterances) {
      let visualSpeaker = null, confidence = null, conflict = false;
      let method = u.audioSpeaker ? 'audio' : 'unresolved';
      if (asd) {
        const hit = asd.find((a) => a.start < u.end && a.end > u.start);
        if (hit) {
          visualSpeaker = hit.visible_speaker;
          confidence = hit.score;
          method = visualSpeaker ? 'both' : 'audio';
          conflict = !visualSpeaker && (hit.faces > 0); // faces present but none speaking → off-screen voice
        }
      }
      // Conservative: anything not visually confirmed above the floor needs review.
      const needsReview = !(visualSpeaker && confidence != null && confidence >= floor);
      const id = await insertUtterance(sourceId, {
        ...u, visualSpeaker, confidence, method, conflict, needsReview,
      });
      utterRows.push({ id, ...u });
    }
    if (utterances.length) {
      await logStage(sourceId, 'attribution', 'success', { determinism: 'model_inference', durationMs: 0, params: { asd: !!asd } });
      console.log(`[stage4] ${utterances.length} utterances (${utterRows.filter((_, i) => true).length} stored; low-confidence flagged for review)`);
    }

    // ── STAGE 5 — frame-accurate keyframes per shot (deterministic) ────────
    try {
      const framesDir = path.join(work, 'frames');
      const [fr] = await timed(() => M.extractFrames(entry.path, framesDir, { scene: config.pipeline.sceneThreshold, maxFrames: 200 }));
      await logCustody(sourceId, 'stage_run', `extracted ${fr.frames_extracted} keyframes (scene cuts, ${fr.seek_mode} seek)`, { actor: 'pipeline/stage5' });
      console.log(`[stage5] ${fr.frames_extracted} frame-accurate keyframes`);
    } catch (err) { console.log(`[stage5] frame extraction error: ${err.message}`); }

    // ── STAGE 6 — embeddings for semantic search ──────────────────────────
    try {
      const texts = utterRows.map((u) => u.text).filter(Boolean);
      if (texts.length) {
        const emb = await M.embedTexts(texts);
        if (emb.skipped) console.log(`[stage6] embeddings skipped: ${emb.reason}`);
        else {
          for (let i = 0; i < utterRows.length; i++) {
            if (!emb.vectors[i]) continue;
            await insertEmbedding(sourceId, {
              refKind: 'utterance', refId: utterRows[i].id, modality: 'text',
              space: emb.model, start: utterRows[i].start, end: utterRows[i].end,
              content: utterRows[i].text, vector: emb.vectors[i],
            });
          }
          console.log(`[stage6] embedded ${emb.vectors.length} utterances (${emb.model}, dim ${emb.dim})`);
        }
      }
    } catch (err) { console.log(`[stage6] embeddings error: ${err.message}`); }

    await logStage(sourceId, 'pipeline', 'success', { determinism: 'mixed' });
    console.log(`[done] ${entry.name}`);
  } finally {
    // Clean ONLY our scratch dir. Never the source.
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  console.log('Forensic Video Ingestion Engine');
  await connect();

  const root = process.argv[2] || config.localRoot;
  if (!root) { console.error('Usage: node src/ingest.js "<folder or drive to scan>"  (or set LOCAL_ROOT)'); process.exit(1); }

  console.log(`[scan] ${root}`);
  const videos = await local.listVideos(root);
  const totalGB = (videos.reduce((s, v) => s + v.size, 0) / 1e9).toFixed(1);
  console.log(`[scan] ${videos.length} videos, ${totalGB} GB total`);
  videos.sort((a, b) => a.size - b.size); // smallest first — fail fast

  for (let i = 0; i < videos.length; i++) {
    try { await processSource(videos[i], i, videos.length); }
    catch (err) { console.error(`[fatal-per-file] ${videos[i].name}: ${err.message}`); }
  }
  console.log('\nBatch complete.');
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
