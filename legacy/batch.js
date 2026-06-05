import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { config } from './config.js';
import { transcribe } from './transcribe/whisper.js';
import { extractFrames, analyzeFrames } from './vision/frames.js';
import { classifyVideo } from './classify/agent.js';
import { writeToVault } from './markdown/writer.js';
import { connect, insertVideo, isProcessed } from './db/postgres.js';
import * as dropboxSource from './sources/dropbox.js';

async function processVideo(entry, index, total) {
  const sizeMB = (entry.size / 1024 / 1024).toFixed(1);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`[${index + 1}/${total}] ${entry.name} (${sizeMB} MB)`);
  console.log(`Path: ${entry.path}`);
  console.log('='.repeat(70));

  if (entry.size > config.maxFileSize) {
    console.log(`[SKIP] File too large (${sizeMB} MB > ${(config.maxFileSize / 1024 / 1024).toFixed(0)} MB limit).`);
    return;
  }

  if (await isProcessed(entry.id)) {
    console.log(`[SKIP] Already processed.`);
    return;
  }

  const localPath = path.join(config.tempDir, entry.name);
  const framesDir = path.join(config.tempDir, 'frames', path.basename(entry.name, path.extname(entry.name)));

  try {
    console.log(`[Download] Fetching ${sizeMB} MB...`);
    const dlStart = Date.now();
    await dropboxSource.downloadVideo(entry);
    console.log(`[Download] Done in ${((Date.now() - dlStart) / 1000).toFixed(1)}s`);

    const sourceLink = await dropboxSource.getShareLink(entry);
    console.log(`[Link] ${sourceLink}`);

    console.log('[Process] Running Whisper + OpenCV in parallel...');
    const [transcript, frames] = await Promise.all([
      transcribe(localPath),
      extractFrames(localPath),
    ]);

    console.log('[Process] Analyzing frames with Claude Vision...');
    const visionAnalysis = await analyzeFrames(frames);

    console.log('[Process] Running classification...');
    const file = {
      id: entry.id,
      name: entry.name,
      createdTime: entry.createdTime,
    };
    const classification = await classifyVideo({
      transcript,
      visionAnalysis,
      fileName: entry.name,
    });

    console.log(`[Result] ${classification.content_type} | ${(classification.topic_areas || []).join(', ') || 'none'}`);

    await Promise.all([
      writeToVault({ file, classification, transcript, sourceLink, frames }),
      insertVideo({ file, classification, transcript, visionAnalysis, sourceLink }),
    ]);

    console.log(`[${index + 1}/${total}] DONE: ${entry.name}`);

  } catch (err) {
    console.error(`[${index + 1}/${total}] FAILED: ${entry.name}`);
    console.error(`  Error: ${err.message}`);
  } finally {
    try { await fs.unlink(localPath); console.log(`[Cleanup] Deleted local video`); } catch {}
    try {
      const frameFiles = await fs.readdir(framesDir).catch(() => []);
      for (const f of frameFiles) await fs.unlink(path.join(framesDir, f)).catch(() => {});
      await fs.rmdir(framesDir).catch(() => {});
    } catch {}
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Kevs Obsidian Ingestion Engine             ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  await connect();

  const folder = process.argv[2] || config.dropbox.folder;
  if (!folder && folder !== '') {
    console.error('Usage: node src/batch.js "<dropbox-folder-path>"');
    process.exit(1);
  }

  console.log(`[Source] Scanning Dropbox: ${folder || '(root)'}`);
  const videos = await dropboxSource.listVideos(folder);

  console.log(`Found ${videos.length} videos`);
  const totalSize = videos.reduce((s, v) => s + v.size, 0);
  console.log(`Total size: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB\n`);

  videos.sort((a, b) => a.size - b.size);

  const startTime = Date.now();
  let processed = 0;
  let failed = 0;

  for (let i = 0; i < videos.length; i++) {
    try {
      await processVideo(videos[i], i, videos.length);
      processed++;
    } catch {
      failed++;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n${'='.repeat(70)}`);
  console.log(`BATCH COMPLETE`);
  console.log(`  Processed: ${processed}/${videos.length}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Time: ${elapsed} minutes`);
  console.log('='.repeat(70));

  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
