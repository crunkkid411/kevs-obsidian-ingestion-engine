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
  insertEvent, insertFrameSignature, insertLocationOfInterest,
} from './db/forensic.js';
import { analyzeFrames as analyzeSignatures, aHash } from './analyze/signatures.js';
import { speakerEvents, locationEvents } from './analyze/events.js';
import { matchLocation, matchIdentity, speakerLabel, locationLabel, describeMoment } from './analyze/identify.js';

/**
 * Load the case knowledge base (known locations) for natural-language naming.
 * Sources, in order: precomputed reference_ahashes in the taxonomy, or
 * reference_frames we aHash now. Returns [{ name, reference_ahashes }].
 */
async function loadKnownLocations() {
  const defs = config.taxonomy.known_locations || [];
  const out = [];
  for (const d of defs) {
    const hashes = [...(d.reference_ahashes || [])];
    for (const f of d.reference_frames || []) {
      try { hashes.push(await aHash(f)); } catch { /* missing reference frame */ }
    }
    if (hashes.length) out.push({ name: d.name, reference_ahashes: hashes });
  }
  return out;
}

// Case knowledge base, loaded once in main().
let KNOWN_LOCATIONS = [];     // [{ name, reference_ahashes }]
let ENROLLMENTS = [];         // [{ entity_name, modality, embedding }] voice/face prints

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

/**
 * Export a clean, full-resolution location frame + a provenance sidecar for the
 * detective's OSINT frame-matching. We never assert WHERE it was filmed — we
 * hand over the frame + exact source/time so they can match fixtures themselves.
 */
async function exportOsintFrame(lc, osintDir, desc) {
  await fs.mkdir(osintDir, { recursive: true });
  const base = `loc_${String(Math.round(lc.timestamp)).padStart(6, '0')}s_f${lc.frame_index}`;
  const dest = path.join(osintDir, `${base}.jpg`);
  await fs.copyFile(lc.path, dest);
  const sidecar = {
    source_file: desc.file_name,
    source_path: desc.abs_path,
    sha256: desc.sha256,
    timestamp_sec: lc.timestamp,
    frame_index: lc.frame_index,
    fps_exact: desc.fps_num && desc.fps_den ? `${desc.fps_num}/${desc.fps_den}` : desc.fps,
    recording_date: desc.recorded_at || null,
    ahash: lc.ahash,
    note: 'Candidate location frame for OSINT fixture matching. Not a geolocation conclusion.',
  };
  await fs.writeFile(path.join(osintDir, `${base}.json`), JSON.stringify(sidecar, null, 2));
  return dest;
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
    let turns = [], clusterEmbeddings = null;
    try {
      if (!hasAudio) throw Object.assign(new Error('no audio'), { soft: true });
      const [diar, ms] = await timed(() => M.runDiarization(wav));
      if (diar.skipped) console.log(`[stage2] diarization skipped: ${diar.reason}`);
      else {
        turns = diar.turns || [];
        clusterEmbeddings = diar.embeddings || null; // {cluster: [..]} when the native diarizer provides voice prints
        for (const label of new Set(turns.map((t) => t.speaker))) await upsertSpeaker(sourceId, label);
        await logStage(sourceId, 'diarization', 'success', { determinism: 'model_inference', model_name: diar.model, durationMs: ms });
        console.log(`[stage2] diarization: ${turns.length} turns, ${new Set(turns.map((t) => t.speaker)).size} speakers`);
      }
    } catch (err) { if (!err.soft) console.log(`[stage2] diarization error: ${err.message}`); }

    // ── STAGE 2b — "20% nuance" speaker events (second speaker / phone) ────
    try {
      const sev = speakerEvents(turns);
      for (const e of sev) await insertEvent(sourceId, e);
      if (sev.length) console.log(`[stage2b] events: ${sev.filter((e) => e.kind === 'phone_call').length} phone-call, ` +
        `${sev.filter((e) => e.kind === 'second_speaker').length} second-speaker (flagged for review)`);
    } catch (err) { console.log(`[stage2b] event error: ${err.message}`); }

    // ── STAGE 3 — visual active-speaker detection (misattribution fix) ─────
    let asd = null;
    try {
      const [res] = await timed(() => M.runASD(entry.path, turns));
      if (res.skipped) console.log(`[stage3] visual ASD skipped: ${res.reason} (utterances will be flagged needs_review)`);
      else { asd = res.results || []; console.log(`[stage3] visual ASD: ${asd.length} verified turns`); }
    } catch (err) { console.log(`[stage3] ASD error: ${err.message}`); }

    // ── STAGE 4 — utterances: attribution + NATURAL-LANGUAGE speaker name ──
    const utterances = buildUtterances(words, turns);
    const floor = config.models.asd.confidenceFloor;
    // Stable per-source index so unmatched speakers read "unidentified speaker 1",
    // not "spk_0". Real names come from voice/face enrollment (model-gated).
    const clusterIndex = new Map();
    for (const lbl of new Set(turns.map((t) => t.speaker))) clusterIndex.set(lbl, clusterIndex.size + 1);
    const utterRows = [];
    let namedCount = 0;
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
      // Name the speaker. If diarization supplied a per-cluster embedding and we
      // have enrollments, match it; otherwise a stable "unidentified speaker N".
      let idMatch = null;
      const emb = u.audioSpeaker ? clusterEmbeddings?.[u.audioSpeaker] : null;
      if (emb && ENROLLMENTS.length) idMatch = matchIdentity(emb, ENROLLMENTS, { floor: 0.5, modality: 'voice' });
      const spk = speakerLabel(idMatch, u.audioSpeaker ? clusterIndex.get(u.audioSpeaker) : null);
      if (spk.identified) namedCount++;
      // Needs review unless the name is visually confirmed above the floor.
      const needsReview = !(visualSpeaker && confidence != null && confidence >= floor) && !spk.identified;
      const id = await insertUtterance(sourceId, {
        ...u, visualSpeaker, confidence, method, conflict, needsReview,
        speakerName: spk.name, speakerConfidence: spk.confidence,
      });
      utterRows.push({ id, ...u, speakerName: spk.name });
    }
    if (utterances.length) {
      await logStage(sourceId, 'attribution', 'success', { determinism: 'model_inference', durationMs: 0, params: { asd: !!asd } });
      console.log(`[stage4] ${utterances.length} utterances; ${namedCount} name-matched, ` +
        `${utterances.length - namedCount} unidentified (review/enrollment to-do)`);
    }

    // ── STAGE 5 — keyframes + perceptual signatures + OSINT location export ─
    // Frame-accurate keyframes per shot -> aHash signatures -> detect location
    // changes -> export clean full-res frames + metadata for detective OSINT.
    try {
      const framesDir = path.join(work, 'frames');
      const [fr] = await timed(() => M.extractFrames(entry.path, framesDir, { scene: config.pipeline.sceneThreshold, maxFrames: 400 }));
      const frames = fr.frames || [];
      const { signatures, locationChanges } = await analyzeSignatures(frames, config.pipeline.locationChangeThreshold);
      for (const s of signatures) await insertFrameSignature(sourceId, s);

      // Location-of-interest export: persist representative frames OUTSIDE the
      // scratch dir (scratch is deleted) so the detective can frame-match them.
      const osintDir = path.join(config.osint.exportDir, desc.sha256.slice(0, 16));
      const locEvents = locationEvents(locationChanges);
      let namedLoc = 0;
      for (let i = 0; i < locationChanges.length; i++) {
        const lc = locationChanges[i];
        // Name the place from the knowledge base: "Defendant's home" vs unknown.
        const locMatch = matchLocation(lc.ahash, KNOWN_LOCATIONS);
        const loc = locationLabel(locMatch);
        if (loc.identified) {
          namedLoc++;
          locEvents[i].detail = `at ${loc.name}`;
          locEvents[i].confidence = loc.confidence;
        }
        await insertEvent(sourceId, locEvents[i]);
        const exported = await exportOsintFrame(lc, osintDir, desc);
        await insertLocationOfInterest(sourceId, {
          start_sec: lc.timestamp, representative_frame: exported, ahash: lc.ahash,
          location_name: locMatch?.name || null, location_confidence: locMatch?.confidence ?? null,
          recording_date: desc.recorded_at || null, exported_dir: osintDir,
        });
      }
      await logCustody(sourceId, 'stage_run',
        `${frames.length} keyframes, ${locationChanges.length} location-of-interest exported (${fr.seek_mode} seek)`,
        { actor: 'pipeline/stage5' });
      console.log(`[stage5] ${frames.length} keyframes, ${signatures.length} signatures, ` +
        `${locationChanges.length} locations-of-interest (${namedLoc} named from knowledge base) exported for OSINT`);
    } catch (err) { console.log(`[stage5] frame/signature error: ${err.message}`); }

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

  // Load the case knowledge base for natural-language naming.
  KNOWN_LOCATIONS = await loadKnownLocations();
  if (KNOWN_LOCATIONS.length) console.log(`[kb] ${KNOWN_LOCATIONS.length} known locations loaded (${KNOWN_LOCATIONS.map((l) => l.name).join(', ')})`);
  // ENROLLMENTS (voice/face prints) are loaded by the native build from the DB;
  // the JS prototype leaves them empty unless wired, so speakers read
  // "unidentified speaker N" until enrollment + a voice/face model are present.

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
