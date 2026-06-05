/**
 * "20% nuance" event detection — the deviations from one-person-one-room that
 * make a segment worth a human's time. All deterministic, derived from data the
 * pipeline already produced (diarization turns, frame signatures).
 *
 * Kinds emitted:
 *   - second_speaker : a non-dominant voice appears (guest, caller). The single
 *                      brief second speaker is exactly the high-value case.
 *   - phone_call     : heuristic — a short second-speaker turn (candidate only;
 *                      confirm with the narrowband-audio check noted below).
 *   - location_change: the background/room changed (from frame signatures).
 *
 * These are CANDIDATES flagged for review, never conclusions.
 */

/**
 * From diarization turns, find the dominant speaker (most total time) and emit
 * an event for every turn that is NOT the dominant speaker.
 */
export function speakerEvents(turns, { phoneCallMaxSec = 20 } = {}) {
  if (!turns?.length) return [];
  const totals = new Map();
  for (const t of turns) totals.set(t.speaker, (totals.get(t.speaker) || 0) + (t.end - t.start));
  const dominant = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const events = [];
  for (const t of turns) {
    if (t.speaker === dominant) continue;
    const dur = t.end - t.start;
    events.push({
      kind: dur <= phoneCallMaxSec ? 'phone_call' : 'second_speaker',
      start_sec: t.start,
      end_sec: t.end,
      confidence: dur <= phoneCallMaxSec ? 0.4 : 0.6, // heuristic; review required
      detail: `non-dominant speaker "${t.speaker}" for ${dur.toFixed(1)}s` +
        (dur <= phoneCallMaxSec ? ' (possible phone/brief interjection)' : ''),
      evidence: { speaker: t.speaker, dominant },
    });
  }
  return events;
}

/** Turn location-change keyframes into location_change events. */
export function locationEvents(locationChanges) {
  return (locationChanges || []).map((lc) => ({
    kind: 'location_change',
    start_sec: lc.timestamp,
    end_sec: null,
    start_frame: lc.frame_index,
    confidence: 0.5,
    detail: `background changed (ahash ${lc.ahash})`,
    evidence: { ahash: lc.ahash, frame: lc.path },
  }));
}

/**
 * NOTE for the native port: phone audio is band-limited (~300–3400 Hz). A cheap
 * spectral check (energy above ~4 kHz ≈ 0) on a second-speaker turn upgrades
 * 'phone_call' confidence. Left as a documented enhancement; the heuristic above
 * is duration-based only.
 */
