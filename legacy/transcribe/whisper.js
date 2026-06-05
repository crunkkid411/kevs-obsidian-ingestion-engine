import OpenAI from 'openai';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts');

/**
 * Transcribe a video file.
 * Uses local Whisper by default. Falls back to OpenAI Whisper API if needed.
 */
export async function transcribe(videoPath) {
  const mode = config.whisper.mode;

  if (mode === 'api') {
    return transcribeAPI(videoPath);
  }

  try {
    return await transcribeLocal(videoPath);
  } catch (err) {
    console.warn(`[Whisper] Local transcription failed: ${err.message}`);
    if (config.whisper.apiKey) {
      console.log('[Whisper] Falling back to API...');
      return transcribeAPI(videoPath);
    }
    throw err;
  }
}

async function transcribeLocal(videoPath) {
  const model = config.whisper.model;
  const scriptPath = path.join(SCRIPTS_DIR, 'transcribe_local.py');

  console.log(`[Whisper] Local transcription (model: ${model}): ${path.basename(videoPath)}`);

  const { stdout, stderr } = await execAsync(
    `python3 "${scriptPath}" "${videoPath}" --model ${model}`,
    { maxBuffer: 50 * 1024 * 1024, timeout: 600_000 },
  );

  if (stderr) {
    for (const line of stderr.split('\n').filter(Boolean)) {
      console.log(`[Whisper] ${line}`);
    }
  }

  const result = JSON.parse(stdout);
  console.log(`[Whisper] Got ${result.segments.length} segments, ${result.text.length} chars (local)`);
  return result;
}

async function transcribeAPI(videoPath) {
  const openai = new OpenAI({ apiKey: config.whisper.apiKey });

  console.log(`[Whisper] API transcription: ${path.basename(videoPath)}`);

  const response = await openai.audio.transcriptions.create({
    model: 'whisper-1',
    file: fs.createReadStream(videoPath),
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  });

  const segments = (response.segments || []).map((seg) => ({
    start: seg.start,
    end: seg.end,
    text: seg.text.trim(),
  }));

  console.log(`[Whisper] Got ${segments.length} segments, ${response.text.length} chars (API)`);

  return {
    text: response.text,
    segments,
    language: response.language,
    duration: response.duration,
    source: 'api',
  };
}
