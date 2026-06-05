/**
 * Perceptual hashing for the OSINT / location layer.
 *
 * A 64-bit average hash (aHash) per keyframe gives us a cheap, deterministic
 * fingerprint of "what the room looks like." We use it two ways:
 *   1. LOCATION CHANGE: when consecutive shots' hashes differ by more than a
 *      Hamming threshold, the background changed → a location-of-interest.
 *   2. CROSS-VIDEO RECURRENCE: the same background appearing in other videos
 *      (small Hamming distance) — supports the detective's fixture matching
 *      without ever asserting WHERE something was filmed.
 *
 * Computed via ffmpeg (scale to 8x8 gray, read raw bytes) — no image libraries.
 * In the native port this becomes a tiny Rust/C function or ffmpeg's built-in
 * `signature` (MPEG-7) filter; the contract (hex hash + Hamming distance) is the
 * same. See docs/NATIVE-STACK.md.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

/** 64-bit average hash of an image file, as a 16-char hex string. */
export async function aHash(imagePath) {
  // 8x8 grayscale raw bytes = 64 pixels.
  const { stdout } = await execFileAsync(
    'ffmpeg',
    ['-nostdin', '-v', 'error', '-i', imagePath, '-vf', 'scale=8:8,format=gray', '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 20 },
  );
  const px = stdout; // Buffer of 64 bytes
  if (px.length < 64) throw new Error(`aHash: expected 64 bytes, got ${px.length}`);
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += px[i];
  const mean = sum / 64;
  let hash = 0n;
  for (let i = 0; i < 64; i++) hash = (hash << 1n) | (px[i] > mean ? 1n : 0n);
  return hash.toString(16).padStart(16, '0');
}

/** Hamming distance between two hex aHashes (0 = identical, 64 = opposite). */
export function hamming(a, b) {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
}

/**
 * Given ordered keyframes [{timestamp, frame_index, path}], compute each frame's
 * aHash and mark LOCATION CHANGES where the hash jumps by >= threshold Hamming
 * bits vs the previous kept location. Returns { signatures, locationChanges }.
 */
export async function analyzeFrames(frames, threshold = 18) {
  const signatures = [];
  const locationChanges = [];
  let lastLocHash = null;
  for (const f of frames) {
    let h;
    try { h = await aHash(f.path); } catch { continue; }
    signatures.push({ timestamp: f.timestamp, frame_index: f.frame_index, ahash: h, path: f.path });
    if (lastLocHash === null || hamming(h, lastLocHash) >= threshold) {
      locationChanges.push({ timestamp: f.timestamp, frame_index: f.frame_index, ahash: h, path: f.path });
      lastLocHash = h;
    }
  }
  return { signatures, locationChanges };
}
