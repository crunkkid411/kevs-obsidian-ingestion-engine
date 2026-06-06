#!/usr/bin/env python3
"""
Voice enrollment — store a speaker voice-print in the forensic DB.

Uses sherpa-onnx SpeakerEmbeddingExtractor with the CAM++ model.

Usage:
    python scripts/enroll_voice.py <audio.wav> --name "Person Name" [--db-path ./forensic.db]

Output (stdout JSON):
    { "enrolled": true, "name": "...", "dim": 192 }
    { "enrolled": false, "reason": "..." }
"""
import argparse
import array
import json
import os
import struct
import sys
import uuid
import wave

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_EMBED_MODEL = os.path.join(
    REPO_ROOT, "models", "diarization",
    "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
)
DEFAULT_DB_PATH = os.path.join(REPO_ROOT, "forensic.db")


def extract_embedding(audio_path: str, model_path: str) -> list[float]:
    """Extract a single speaker embedding from a WAV file."""
    import sherpa_onnx

    config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
        model=model_path,
        num_threads=2,
        debug=False,
        provider="cpu",
    )
    extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)

    with wave.open(audio_path, "rb") as wf:
        sample_rate = wf.getframerate()
        num_frames = wf.getnframes()
        raw = wf.readframes(num_frames)
        samples_int = array.array("h", raw)
        samples = [s / 32768.0 for s in samples_int]

    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate, samples)
    stream.input_finished()

    if not extractor.is_ready(stream):
        raise RuntimeError("Extractor not ready after full audio input — audio may be too short")

    embedding = extractor.compute(stream)
    return embedding


def enroll(audio_path: str, name: str, db_path: str, model_path: str) -> dict:
    """Enroll a speaker voice-print in the SQLite DB."""
    # Extract embedding first (fail fast before touching DB)
    embedding = extract_embedding(audio_path, model_path)
    dim = len(embedding)

    # Pack as float32 blob
    blob = struct.pack(f"{dim}f", *embedding)

    import sqlite3
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Ensure the direct-blob enrollments table exists.
    # The schema.sqlite.sql identity_enrollments uses vec_rowid (requires
    # sqlite-vec extension) for the native build.  voice_enrollments stores
    # the blob directly so loadEnrollments() in forensic-sqlite.js can read
    # it without the extension.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS voice_enrollments (
            id          TEXT PRIMARY KEY,
            entity_name TEXT NOT NULL,
            modality    TEXT NOT NULL DEFAULT 'voice',
            embedding   BLOB NOT NULL,
            source_id   TEXT,
            enrolled_at TEXT DEFAULT (datetime('now'))
        )
    """)

    enrollment_id = str(uuid.uuid4()).replace("-", "")
    cur.execute(
        "INSERT INTO voice_enrollments (id, entity_name, modality, embedding) VALUES (?,?,?,?)",
        (enrollment_id, name, "voice", blob),
    )
    conn.commit()
    conn.close()

    return {"enrolled": True, "name": name, "dim": dim, "id": enrollment_id}


def main():
    ap = argparse.ArgumentParser(
        description="Enroll a voice-print in the forensic DB from a WAV clip."
    )
    ap.add_argument("audio", help="Path to WAV file (mono 16 kHz recommended)")
    ap.add_argument("--name", required=True, help='Person name, e.g. "Demo Speaker"')
    ap.add_argument(
        "--db-path",
        default=os.environ.get("SQLITE_DB_PATH", DEFAULT_DB_PATH),
        help="Path to forensic.db",
    )
    ap.add_argument(
        "--embed-model",
        default=os.environ.get("SHERPA_EMBED_MODEL", DEFAULT_EMBED_MODEL),
        help="CAM++ ONNX model path",
    )
    args = ap.parse_args()

    if not os.path.exists(args.audio):
        print(json.dumps({"enrolled": False, "reason": f"Audio file not found: {args.audio}"}))
        sys.exit(1)

    if not os.path.exists(args.embed_model):
        print(json.dumps({"enrolled": False, "reason": f"Model not found: {args.embed_model}"}))
        sys.exit(1)

    if not os.path.exists(args.db_path):
        print(json.dumps({
            "enrolled": False,
            "reason": f"DB not found: {args.db_path} — run npm run ingest first or pass --db-path",
        }))
        sys.exit(1)

    result = enroll(args.audio, args.name, args.db_path, args.embed_model)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"enrolled": False, "reason": f"{type(e).__name__}: {e}"}))
        sys.exit(1)
