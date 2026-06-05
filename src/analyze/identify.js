/**
 * Identification & natural-language naming.
 *
 * Turns clusters/signatures into NAMES using the case knowledge base:
 *   - a diarization/voice embedding -> the enrolled person ("Defendant")
 *   - a face embedding -> the enrolled person on screen
 *   - a location aHash -> the known place ("Defendant's home")
 *
 * Philosophy (see docs/ARCHITECTURE.md): conclude in plain language with a
 * confidence; fall back to a neutral description only when there is genuinely no
 * match. Naming is what makes accuracy measurable.
 */
import { hamming } from './signatures.js';

/** Cosine similarity of two equal-length numeric vectors. */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Match an identity embedding (voice or face) against enrolled prints.
 * enrollments: [{ entity_name, modality, embedding }]
 * Returns { name, confidence, modality } or null if nothing clears `floor`.
 */
export function matchIdentity(embedding, enrollments, { floor = 0.5, modality = null } = {}) {
  let best = null;
  for (const e of enrollments) {
    if (modality && e.modality !== modality) continue;
    const sim = cosine(embedding, e.embedding);
    if (!best || sim > best.confidence) best = { name: e.entity_name, confidence: sim, modality: e.modality };
  }
  return best && best.confidence >= floor ? best : null;
}

/**
 * Match a location aHash against known places.
 * knownLocations: [{ name, reference_ahashes: [hex,...] }]
 * Returns { name, confidence } or null. Confidence = 1 - (minHamming / 64).
 */
export function matchLocation(ahash, knownLocations, { maxHamming = 14 } = {}) {
  let best = null;
  for (const loc of knownLocations) {
    for (const ref of loc.reference_ahashes || []) {
      const d = hamming(ahash, ref);
      if (!best || d < best.dist) best = { name: loc.name, dist: d };
    }
  }
  if (!best || best.dist > maxHamming) return null;
  return { name: best.name, confidence: +(1 - best.dist / 64).toFixed(3) };
}

/**
 * Natural-language speaker label. Named when matched; otherwise a STABLE
 * "unidentified speaker N" (per source) rather than an opaque cluster id — and
 * such fall-backs are the accuracy to-do list, not the norm.
 */
export function speakerLabel(match, clusterFallbackIndex) {
  if (match) return { name: match.name, confidence: match.confidence, identified: true };
  return {
    name: clusterFallbackIndex != null ? `unidentified speaker ${clusterFallbackIndex}` : 'unidentified speaker',
    confidence: null,
    identified: false,
  };
}

/** Natural-language location label. */
export function locationLabel(match) {
  if (match) return { name: match.name, confidence: match.confidence, identified: true };
  return { name: 'unknown location', confidence: null, identified: false };
}

/**
 * One-line natural-language summary for a moment, the way a human would say it:
 *   "Defendant at home" / "Defendant, unknown location" /
 *   "unidentified speaker 2 at Defendant's home".
 */
export function describeMoment({ speaker, location } = {}) {
  const who = speaker?.name || 'unidentified speaker';
  if (location?.identified) return `${who} at ${location.name}`;
  if (location && !location.identified) return `${who}, unknown location`;
  return who;
}
