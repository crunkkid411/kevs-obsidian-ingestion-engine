#!/usr/bin/env python3
"""
Local Whisper transcription using openai-whisper.
Runs on-device — no API calls, no cost.

Usage: python3 scripts/transcribe_local.py <video_path> [--model base] [--language en]
Output: JSON to stdout with transcript + segments
"""

import whisper
import sys
import json
import argparse
import os
import io
import contextlib


def transcribe(video_path, model_name="base", language=None):
    """Transcribe a video/audio file using local Whisper model."""
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"Video not found: {video_path}")

    print(f"Loading Whisper model: {model_name}", file=sys.stderr)
    model = whisper.load_model(model_name)

    print(f"Transcribing: {video_path}", file=sys.stderr)
    options = {"verbose": False}
    if language:
        options["language"] = language

    # Capture any stray stdout from whisper (e.g. "Detected language: ...")
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        result = model.transcribe(video_path, **options)

    # Forward captured output to stderr
    stray = captured.getvalue().strip()
    if stray:
        print(stray, file=sys.stderr)

    segments = []
    for seg in result.get("segments", []):
        segments.append({
            "start": round(seg["start"], 2),
            "end": round(seg["end"], 2),
            "text": seg["text"].strip(),
        })

    output = {
        "text": result["text"],
        "language": result.get("language", "unknown"),
        "segments": segments,
        "duration": segments[-1]["end"] if segments else 0,
        "model": model_name,
        "source": "local",
    }

    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Local Whisper transcription")
    parser.add_argument("video_path", help="Path to video/audio file")
    parser.add_argument("--model", default="base",
                        choices=["tiny", "base", "small", "medium", "large"],
                        help="Whisper model size (default: base)")
    parser.add_argument("--language", default=None, help="Language code (e.g., en)")
    args = parser.parse_args()

    result = transcribe(args.video_path, args.model, args.language)
    print(json.dumps(result, indent=2))
