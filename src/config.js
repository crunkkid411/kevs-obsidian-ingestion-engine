import 'dotenv/config';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load taxonomy: prefer an investigation taxonomy, then generic, then example.
function loadTaxonomy() {
  const candidates = [
    process.env.TAXONOMY_PATH && path.resolve(process.env.TAXONOMY_PATH),
    path.join(ROOT, 'config', 'taxonomy.json'),
    path.join(ROOT, 'config', 'taxonomy.investigation.example.json'),
    path.join(ROOT, 'config', 'taxonomy.example.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      if (p.endsWith('.example.json')) {
        console.warn(`[Config] Using ${path.basename(p)} — copy to config/taxonomy.json and customize.`);
      }
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    }
  }
  throw new Error('No taxonomy file found at config/taxonomy.json');
}

export const config = {
  // 'local' = evidence-safe local hard drive (recommended). 'dropbox' = legacy.
  source: process.env.SOURCE || 'local',

  // Root folder/drive to scan for the local source (read-only, never modified).
  localRoot: process.env.LOCAL_ROOT || '',

  dropbox: {
    accessToken: process.env.DROPBOX_ACCESS_TOKEN,
    appKey: process.env.DROPBOX_APP_KEY,
    appSecret: process.env.DROPBOX_APP_SECRET,
    folder: process.env.DROPBOX_FOLDER || '',
  },

  // ── Model stack (June 2026 — see docs/MODELS-2026.md) ───────────────────
  models: {
    // ASR: local NVIDIA Parakeet v3 (NeMo) by default.
    asr: {
      backend: process.env.ASR_BACKEND || 'parakeet',          // parakeet|whisper|api
      model: process.env.ASR_MODEL || 'nvidia/parakeet-tdt-0.6b-v3',
      version: process.env.ASR_VERSION || 'v3',
    },
    // Audio diarization: NVIDIA Sortformer (<=4 speakers).
    diarization: {
      backend: process.env.DIAR_BACKEND || 'sortformer',       // sortformer|pyannote|none
      model: process.env.DIAR_MODEL || 'nvidia/diar_streaming_sortformer_4spk-v2.1',
      maxSpeakers: parseInt(process.env.DIAR_MAX_SPEAKERS || '4'),
    },
    // Visual active-speaker detection (the misattribution fix).
    asd: {
      backend: process.env.ASD_BACKEND || 'lr-asd',            // lr-asd|none
      confidenceFloor: parseFloat(process.env.ASD_CONF_FLOOR || '0.6'),
    },
    // Video understanding (used on flagged/queried segments only).
    video: {
      backend: process.env.VIDEO_BACKEND || 'qwen3-vl-local',  // qwen3-vl-local|openrouter|gemini|none
      model: process.env.VIDEO_MODEL || 'Qwen/Qwen3-VL-8B-Instruct-GGUF',
      apiModel: process.env.VIDEO_API_MODEL || 'qwen/qwen3-vl-8b-instruct',
    },
    // Text embeddings for semantic transcript search.
    textEmbed: {
      model: process.env.TEXT_EMBED_MODEL || 'Qwen/Qwen3-Embedding-0.6B',
      dim: parseInt(process.env.TEXT_EMBED_DIM || '1024'),     // MUST match schema vector(N)
    },
    // Multimodal (frame+text) embeddings for scenery search.
    mmEmbed: {
      model: process.env.MM_EMBED_MODEL || 'Qwen/Qwen3-VL-Embedding-2B',
      enabled: (process.env.MM_EMBED_ENABLED || 'false') === 'true',
    },
  },

  // ── API keys ────────────────────────────────────────────────────────────
  api: {
    openrouterKey: process.env.OPENROUTER_API_KEY,
    openrouterBase: process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1',
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    geminiKey: process.env.GEMINI_API_KEY,
    openaiKey: process.env.OPENAI_API_KEY,
  },

  db: {
    url: process.env.DATABASE_URL,
  },

  obsidian: {
    vaultPath: process.env.OBSIDIAN_VAULT_PATH || path.join(ROOT, 'vault'),
    notesFolder: process.env.OBSIDIAN_NOTES_FOLDER || 'Cases',
  },

  // ── Pipeline behaviour ──────────────────────────────────────────────────
  pipeline: {
    // Frame extraction precision (deterministic). See scripts/extract_frames_precise.py
    sceneThreshold: parseFloat(process.env.SCENE_THRESHOLD || '0.4'),
    keyframesPerShot: parseInt(process.env.KEYFRAMES_PER_SHOT || '1'),
    // Hamming distance (of 64-bit aHash) above which a shot is a new location.
    locationChangeThreshold: parseInt(process.env.LOCATION_CHANGE_THRESHOLD || '18'),
    // Triage: only send segments to the VLM if flagged or queried (see docs).
    understandFlaggedOnly: (process.env.UNDERSTAND_FLAGGED_ONLY || 'true') === 'true',
  },

  // ── OSINT handoff: exported location frames for the detective ────────────
  osint: {
    exportDir: process.env.OSINT_EXPORT_DIR || path.join(ROOT, 'osint-export'),
  },

  // ── Per-media context-review agent (the "nuance" pass) ──────────────────
  // ONE agent per media file. The system prompt (case context) and model are
  // GUI-editable (see config/settings.schema.json). claude-code keeps sensitive
  // context local; openrouter is for testing API models on non-sensitive data.
  contextReview: {
    backend: process.env.CONTEXT_REVIEW_BACKEND || 'claude-code', // claude-code|openrouter|mock|none
    model: process.env.CONTEXT_REVIEW_MODEL || 'claude-opus-4-8',
    concurrency: parseInt(process.env.CONTEXT_REVIEW_CONCURRENCY || '2'),
    promptPath: process.env.CONTEXT_REVIEW_PROMPT
      ? path.resolve(process.env.CONTEXT_REVIEW_PROMPT)
      : path.join(ROOT, 'config', 'context-review.prompt.md'),
  },

  // Storage backend the NATIVE port targets (the JS prototype uses Postgres).
  storage: process.env.STORAGE || 'sqlite',   // sqlite (recommended) | postgres

  // Scratch space for extracted audio/frames. Source files are NEVER written here.
  tempDir: process.env.TEMP_DIR || path.join(ROOT, 'tmp', 'work'),

  // Evidence safety: refuse to ever delete source files.
  neverDeleteSources: true,

  taxonomy: loadTaxonomy(),
};
