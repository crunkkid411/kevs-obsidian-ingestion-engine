#!/usr/bin/env python3
"""
Visual Active-Speaker Detection — the misattribution fix. **STUB / WIRING GUIDE.**

This is the single highest-value stage to implement, and it is intentionally left
as a documented stub rather than a half-working heuristic: in a criminal matter,
a guessing speaker-attributor is worse than none. Until it is wired, the
orchestrator treats every utterance as `needs_review` (the safe default).

Contract the orchestrator expects (stdout JSON):
  { "model": str,
    "results": [{ "start": float, "end": float,
                  "visible_speaker": str|null,   # face/track id that is speaking
                  "score": float,                # 0..1 confidence
                  "faces": int }] }              # faces visible in the window

How to wire it (see docs/MODELS-2026.md §3.3):
  1. pip install mediapipe; clone LR-ASD (https://github.com/Junhua-Liao/LR-ASD)
     and download its weights.
  2. For each diarization turn passed in via --turns-b64:
       a. extract frames across [start,end] with scripts/extract_frames_precise.py
          (frame-accurate, true fps) — DO NOT use fast keyframe seeking here.
       b. MediaPipe FaceMesh -> detect + track each face, crop mouth region.
       c. LR-ASD -> per face, score lip-motion vs the turn's audio synchrony.
       d. visible_speaker = the single face whose score is highest AND above
          ASD_CONF_FLOOR; if none qualifies (off-screen voice, crowd, tiny face,
          >1 talking) -> visible_speaker=null so the turn is flagged.
  3. Maintain a small face gallery across videos so a confirmed identity stays
     consistent (turns "spk_0" into a real, human-confirmed name once).

Returning `skipped` here is correct and safe until the above is in place.

Usage: python asd_lr_asd.py <video> --turns-b64 <base64 json array of turns>
"""
import argparse, json, sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--turns-b64", default="")
    ap.parse_args()
    # Not implemented on purpose — see module docstring. Fail SAFE (skip).
    print(json.dumps({
        "skipped": True,
        "reason": "ASD not wired yet — utterances will be flagged needs_review. "
                  "See scripts/asd_lr_asd.py docstring + docs/MODELS-2026.md §3.3.",
    }))


if __name__ == "__main__":
    main()
