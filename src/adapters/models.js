/**
 * Model adapters — thin JS wrappers that shell out to the Python/CLI tools that
 * actually run the models, and return structured, provenance-friendly data.
 *
 * Design: every adapter returns either a result object or `{ skipped, reason }`.
 * The orchestrator treats "skipped" as a soft failure so the DETERMINISTIC
 * intake (STAGE 0) and any wired stages still run even before every model is
 * installed. This is what lets a non-developer enable the pipeline piece by
 * piece on the Windows machine.
 *
 * Contracts (what each Python script must print to stdout as JSON) are documented
 * at each function. The Python scripts under scripts/ are REAL but UNTESTED in
 * this environment (no GPU / no footage here) — validate them on the GPU box.
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(__dirname, '../../scripts');
const PY = process.env.PYTHON_BIN || 'python';

async function runJson(cmd, { timeout = 3_600_000 } = {}) {
  const { stdout, stderr } = await execAsync(cmd, { maxBuffer: 200 * 1024 * 1024, timeout });
  if (stderr) for (const l of stderr.split('\n').filter(Boolean)) console.log(`   ${l}`);
  // Grab the last JSON object in stdout (greedy to last brace; tolerant of
  // trailing whitespace and any leading log lines the tool may print).
  const m = stdout.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('adapter produced no JSON');
  return JSON.parse(m[0]);
}

/**
 * Deterministic: demux audio to 16k mono wav (input for ASR + diarization).
 * Never touches the source file.
 */
export async function demuxAudio(videoPath, outWav) {
  await fs.mkdir(path.dirname(outWav), { recursive: true });
  await execAsync(
    `ffmpeg -nostdin -y -i "${videoPath}" -vn -ac 1 -ar 16000 -f wav "${outWav}"`,
    { timeout: 1_800_000 },
  );
  return outWav;
}

/**
 * ASR. Contract (scripts/asr_parakeet.py):
 *   { "model": str, "version": str, "language": str,
 *     "words": [{ "word": str, "start": float, "end": float, "confidence": float }],
 *     "text": str }
 */
export async function runASR(wavPath) {
  const { backend, model, version } = config.models.asr;
  if (backend === 'none') return { skipped: true, reason: 'ASR_BACKEND=none' };
  try {
    const script = backend === 'parakeet' ? 'asr_parakeet.py' : 'transcribe_local.py';
    const out = await runJson(`${PY} "${path.join(SCRIPTS, script)}" "${wavPath}" --model "${model}"`);
    return { ...out, model: out.model || model, version: out.version || version };
  } catch (err) {
    return { skipped: true, reason: `ASR not wired/failed: ${err.message}` };
  }
}

/**
 * Audio diarization. Contract (scripts/diarize_sortformer.py):
 *   { "model": str, "turns": [{ "speaker": "spk_0", "start": float, "end": float }] }
 */
export async function runDiarization(wavPath) {
  const { backend, model, maxSpeakers } = config.models.diarization;
  if (backend === 'none') return { skipped: true, reason: 'DIAR_BACKEND=none' };
  try {
    const out = await runJson(
      `${PY} "${path.join(SCRIPTS, 'diarize_sortformer.py')}" "${wavPath}" --max-speakers ${maxSpeakers}`,
    );
    return { ...out, model: out.model || model };
  } catch (err) {
    return { skipped: true, reason: `diarization not wired/failed: ${err.message}` };
  }
}

/**
 * Visual active-speaker detection — the misattribution fix. Contract
 * (scripts/asd_lr_asd.py): per turn, which on-screen face is speaking + score.
 *   { "model": str, "results": [{ "start": float, "end": float,
 *       "visible_speaker": str|null, "score": float, "faces": int }] }
 * This is the highest-value stage to wire; see docs/MODELS-2026.md §3.3.
 */
export async function runASD(videoPath, turns) {
  if (config.models.asd.backend === 'none') return { skipped: true, reason: 'ASD_BACKEND=none' };
  try {
    const turnsArg = Buffer.from(JSON.stringify(turns || [])).toString('base64');
    const out = await runJson(
      `${PY} "${path.join(SCRIPTS, 'asd_lr_asd.py')}" "${videoPath}" --turns-b64 ${turnsArg}`,
    );
    return out;
  } catch (err) {
    return { skipped: true, reason: `ASD not wired/failed: ${err.message}` };
  }
}

/**
 * Frame-accurate extraction (DETERMINISTIC, confident). Modes documented in
 * scripts/extract_frames_precise.py. Returns the script's JSON manifest.
 */
export async function extractFrames(videoPath, outDir, mode) {
  // mode e.g. { scene: 0.4 } | { timestamps: [12.5, 90] } | { frames: [100,250] } | { fps: 1 }
  const args = [];
  if (mode?.scene != null) args.push(`--scene ${mode.scene}`);
  if (mode?.timestamps) args.push(`--timestamps "${mode.timestamps.join(',')}"`);
  if (mode?.frames) args.push(`--frames "${mode.frames.join(',')}"`);
  if (mode?.fps != null) args.push(`--fps ${mode.fps}`);
  if (mode?.interval != null) args.push(`--interval ${mode.interval}`);
  if (mode?.maxFrames != null) args.push(`--max-frames ${mode.maxFrames}`);
  return runJson(`${PY} "${path.join(SCRIPTS, 'extract_frames_precise.py')}" "${videoPath}" "${outDir}" ${args.join(' ')}`);
}

/**
 * Text embeddings. Contract (scripts/embed_text.py):
 *   { "model": str, "dim": int, "vectors": [[float,...], ...] }
 */
export async function embedTexts(texts) {
  if (!texts?.length) return { vectors: [] };
  try {
    const b64 = Buffer.from(JSON.stringify(texts)).toString('base64');
    return await runJson(
      `${PY} "${path.join(SCRIPTS, 'embed_text.py')}" --texts-b64 ${b64} --model "${config.models.textEmbed.model}"`,
    );
  } catch (err) {
    return { skipped: true, reason: `embeddings not wired/failed: ${err.message}` };
  }
}
