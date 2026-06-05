/**
 * Local filesystem source — read-only, evidence-safe.
 *
 * Unlike the Dropbox source (which downloads then DELETES the local file), this
 * source treats the originals as immutable evidence:
 *   - it never writes to, moves, renames, or deletes a source file;
 *   - it computes a SHA-256 of every file for chain of custody;
 *   - it reads ffprobe metadata WITHOUT re-encoding.
 *
 * Designed for a Windows hard drive full of footage. Point it at the drive/folder
 * and it returns every video, recursively, with a stable hash-based identity.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv', '.ts', '.mts', '.m2ts', '.wmv',
]);

/**
 * Recursively list every video file under `root`.
 * Returns lightweight entries; hashing/probing happen on demand (they're slow).
 */
export async function listVideos(root) {
  const out = [];
  async function walk(dir) {
    let items;
    try {
      items = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`[local] cannot read dir ${dir}: ${err.message}`);
      return;
    }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        await walk(full);
      } else if (VIDEO_EXTS.has(path.extname(it.name).toLowerCase())) {
        const stat = await fsp.stat(full).catch(() => null);
        if (stat) {
          out.push({
            id: full,            // stable until we have the hash
            name: it.name,
            path: full,
            size: stat.size,
            createdTime: stat.birthtime?.toISOString?.() || null,
          });
        }
      }
    }
  }
  await walk(root);
  return out;
}

/**
 * Stream a SHA-256 of the file. This is the chain-of-custody anchor; every
 * derived row is keyed by this hash. Streaming so multi-GB files don't blow RAM.
 */
export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * Deterministic technical metadata via ffprobe — NO re-encode, NO modification.
 * Returns exact rational fps (num/den), frame count, dimensions, orientation.
 */
export async function probe(filePath) {
  const cmd =
    `ffprobe -v quiet -print_format json -show_format -show_streams ` +
    `"${filePath}"`;
  const { stdout } = await execAsync(cmd, { maxBuffer: 20 * 1024 * 1024 });
  const data = JSON.parse(stdout);

  const v = (data.streams || []).find((s) => s.codec_type === 'video') || {};
  const audioStreams = (data.streams || []).filter((s) => s.codec_type === 'audio').length;

  // Exact rational frame rate, e.g. "30000/1001"
  const [num, den] = (v.avg_frame_rate || v.r_frame_rate || '0/1')
    .split('/')
    .map((x) => parseInt(x, 10));
  const fps = den ? num / den : null;

  const width = v.width || null;
  const height = v.height || null;
  let orientation = 'unknown';
  if (width && height) {
    orientation = width > height ? 'horizontal' : width < height ? 'vertical' : 'square';
  }

  // Prefer container nb_frames; fall back to duration*fps (still deterministic).
  const duration = parseFloat(data.format?.duration ?? v.duration ?? '0') || null;
  let frameCount = v.nb_frames ? parseInt(v.nb_frames, 10) : null;
  if (!frameCount && duration && fps) frameCount = Math.round(duration * fps);

  return {
    container: (data.format?.format_name || '').split(',')[0] || path.extname(filePath).slice(1),
    duration_sec: duration,
    fps,
    fps_num: num || null,
    fps_den: den || null,
    frame_count: frameCount,
    width,
    height,
    orientation,
    audio_streams: audioStreams,
    ffprobe_json: data,
  };
}

/**
 * Build the full immutable source record (hash + probe). This is what STAGE 0
 * registers in the `sources` table.
 */
export async function describeSource(filePath) {
  const stat = await fsp.stat(filePath);
  const [sha256, meta] = await Promise.all([hashFile(filePath), probe(filePath)]);
  return {
    sha256,
    abs_path: path.resolve(filePath),
    file_name: path.basename(filePath),
    byte_size: stat.size,
    ...meta,
  };
}

// Local files don't need downloading; the "path" is the file itself.
// Kept for source-plugin interface compatibility with the batch runner.
export async function downloadVideo(entry) {
  return entry.path;
}

export async function getShareLink(entry) {
  return `file://${path.resolve(entry.path)}`;
}
