#!/usr/bin/env python3
"""
ASR with NVIDIA Parakeet-TDT-0.6B-v3 (NeMo), with word-level timestamps.

Contract (stdout JSON):
  { "model","version","language","text",
    "words":[{"word","start","end","confidence"}] }

NOTE: Written against the model card but NOT executed in the authoring
environment (no GPU/footage there). Validate on the Windows GPU box.
Install: pip install -U nemo_toolkit[asr]   (or use parakeet.cpp for a
lighter, C++ path that also bundles Sortformer diarization).

Usage: python asr_parakeet.py <audio.wav> [--model nvidia/parakeet-tdt-0.6b-v3]
"""
import argparse, json, sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default="nvidia/parakeet-tdt-0.6b-v3")
    args = ap.parse_args()

    import nemo.collections.asr as nemo_asr
    asr = nemo_asr.models.ASRModel.from_pretrained(model_name=args.model)

    # timestamps=True yields char/word/segment timings on the TDT models.
    out = asr.transcribe([args.audio], timestamps=True)
    hyp = out[0]
    text = hyp.text if hasattr(hyp, "text") else str(hyp)

    words = []
    ts = getattr(hyp, "timestamp", None) or {}
    for w in ts.get("word", []):
        words.append({
            "word": w.get("word") or w.get("char") or "",
            "start": round(float(w.get("start", 0.0)), 3),
            "end": round(float(w.get("end", 0.0)), 3),
            "confidence": w.get("confidence"),
        })

    print(json.dumps({
        "model": args.model,
        "version": "v3",
        "language": getattr(hyp, "langs", None) or "auto",
        "text": text,
        "words": words,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # surface as JSON so the JS adapter degrades gracefully
        print(json.dumps({"skipped": True, "reason": f"{type(e).__name__}: {e}"}))
        sys.exit(0)
