#!/usr/bin/env python3
"""
ASR with Parakeet-TDT-0.6B-v3 (ONNX) via sherpa-onnx, with word-level timestamps.

Contract (stdout JSON):
  { "model": str, "version": str, "language": str, "text": str,
    "words": [{"word": str, "start": float, "end": float, "confidence": float|null}] }

On failure:
  { "skipped": true, "reason": "..." }  -- exit 0

Install: pip install sherpa-onnx
Model dir: models/asr/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/

Usage: python asr_parakeet.py <audio.wav> [--model-dir <path>]
"""
import argparse
import json
import os
import sys


DEFAULT_MODEL_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "models", "asr", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument(
        "--model-dir",
        default=os.environ.get("SHERPA_ASR_MODEL_DIR", DEFAULT_MODEL_DIR),
        help="Path to the sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8 directory",
    )
    # Keep --model for backwards compat with models.js (it passes --model but we ignore it)
    ap.add_argument("--model", default=None, help="Ignored; use --model-dir")
    args = ap.parse_args()

    import sherpa_onnx

    model_dir = args.model_dir
    encoder = os.path.join(model_dir, "encoder.int8.onnx")
    decoder = os.path.join(model_dir, "decoder.int8.onnx")
    joiner = os.path.join(model_dir, "joiner.int8.onnx")
    tokens = os.path.join(model_dir, "tokens.txt")

    for f in (encoder, decoder, joiner, tokens):
        if not os.path.exists(f):
            print(json.dumps({"skipped": True, "reason": f"Model file not found: {f}"}))
            sys.exit(0)

    recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=encoder,
        decoder=decoder,
        joiner=joiner,
        tokens=tokens,
        num_threads=4,
        decoding_method="greedy_search",
        model_type="nemo_transducer",  # required for NeMo Parakeet ONNX export
    )

    # Read WAV and run recognition
    import wave
    import array
    with wave.open(args.audio, "rb") as wf:
        sample_rate = wf.getframerate()
        num_frames = wf.getnframes()
        raw = wf.readframes(num_frames)
        samples_int = array.array("h", raw)
        samples = [s / 32768.0 for s in samples_int]

    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, samples)
    recognizer.decode_stream(stream)
    result = stream.result

    text = result.text.strip()

    words = []
    if hasattr(result, "tokens") and result.tokens:
        # sherpa-onnx NeMo transducer returns BPE tokens where word boundaries are
        # indicated by a leading space (e.g. " I", " want", " ch", "allen", "ge").
        # Tokens without a leading space are sub-word continuations of the previous word.
        timestamps = getattr(result, "timestamps", None) or []
        tokens_list = result.tokens

        current_word = ""
        current_start = None
        current_end = None

        for i, tok in enumerate(tokens_list):
            ts = float(timestamps[i]) if i < len(timestamps) else 0.0
            is_new_word = tok.startswith(" ") or tok.startswith("▁")
            tok_clean = tok.lstrip(" ▁")

            if is_new_word and current_word:
                if current_word.strip():
                    words.append({
                        "word": current_word.strip(),
                        "start": round(float(current_start), 3),
                        "end": round(float(current_end), 3),
                        "confidence": None,
                    })
                current_word = tok_clean
                current_start = ts
                current_end = ts
            elif is_new_word:
                current_word = tok_clean
                current_start = ts
                current_end = ts
            else:
                current_word = (current_word or "") + tok_clean
                current_end = ts

        if current_word and current_word.strip():
            words.append({
                "word": current_word.strip(),
                "start": round(float(current_start or 0.0), 3),
                "end": round(float(current_end or 0.0), 3),
                "confidence": None,
            })

    # If no word-level timestamps available, create a single word entry
    if not words and text:
        words = [{
            "word": text,
            "start": 0.0,
            "end": 0.0,
            "confidence": None,
        }]

    print(json.dumps({
        "model": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        "version": "v3",
        "language": "en",
        "text": text,
        "words": words,
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"skipped": True, "reason": f"{type(e).__name__}: {e}"}))
        sys.exit(0)
