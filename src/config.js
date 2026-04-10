import 'dotenv/config';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load taxonomy from config/taxonomy.json (or fall back to example)
const taxonomyPath = path.join(ROOT, 'config', 'taxonomy.json');
const examplePath = path.join(ROOT, 'config', 'taxonomy.example.json');

let taxonomy;
if (fs.existsSync(taxonomyPath)) {
  taxonomy = JSON.parse(fs.readFileSync(taxonomyPath, 'utf-8'));
} else if (fs.existsSync(examplePath)) {
  console.warn('[Config] Using taxonomy.example.json — copy to taxonomy.json and customize.');
  taxonomy = JSON.parse(fs.readFileSync(examplePath, 'utf-8'));
} else {
  throw new Error('No taxonomy file found at config/taxonomy.json');
}

export const config = {
  source: process.env.SOURCE || 'dropbox',

  dropbox: {
    accessToken: process.env.DROPBOX_ACCESS_TOKEN,
    appKey: process.env.DROPBOX_APP_KEY,
    appSecret: process.env.DROPBOX_APP_SECRET,
    folder: process.env.DROPBOX_FOLDER || '',
  },

  googleDrive: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback',
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID,
    tokenPath: path.join(ROOT, 'config', 'google-token.json'),
  },

  whisper: {
    mode: process.env.WHISPER_MODE || 'local',
    model: process.env.WHISPER_MODEL || 'base',
    apiKey: process.env.OPENAI_API_KEY,
  },

  ai: {
    provider: process.env.AI_PROVIDER || 'anthropic',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    model: process.env.AI_MODEL || 'claude-sonnet-4-6',
  },

  db: {
    url: process.env.DATABASE_URL,
  },

  obsidian: {
    vaultPath: process.env.OBSIDIAN_VAULT_PATH || path.join(ROOT, 'vault'),
    notesFolder: process.env.OBSIDIAN_NOTES_FOLDER || 'Videos',
  },

  cron: {
    schedule: process.env.CRON_SCHEDULE || '*/15 * * * *',
  },

  tempDir: process.env.TEMP_DIR || path.join(ROOT, 'tmp', 'downloads'),

  maxFileSize: parseInt(process.env.MAX_FILE_SIZE_BYTES || (2 * 1024 * 1024 * 1024)),

  taxonomy,
};
