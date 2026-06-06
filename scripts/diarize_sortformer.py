#!/usr/bin/env python3
"""
Audio speaker diarization via sherpa-onnx OfflineSpeakerDiarization.

Uses pyannote segmentation-3-0 + CAM++ speaker embedding, no 4-speaker cap.

Contract (stdout JSON):
  { "model": "sherpa-onnx-diarization",
    "turns": [{"speaker": "spk_0", "start": float, "end": float}] }

With --output-embeddings:
  { "model": "sherpa-onnx-diarization",
    "turns": [...],
    "embeddings": {"spk_0": [float, ...], "spk_1": [float, ...]} }

On failure:
  { "skipped": true, "reason": "..." }  -- exit 0

Install: pip install sherpa-onnx
Models:
  - models/diarization/sherpa-onnx-pyannote-segmentation-3-0/model.onnx
  - models/diarization/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx

Usage: python diarize_sortformer.py <audio.wav> [--max-speakers N] [--output-embeddings]
"""
import argparse
import json
import os
import sys


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_SEG_MODEL = os.path.join(
    REPO_ROOT, "models", "diarization",
    "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx",
)
DEFAULT_EMBED_MODEL = os.path.join(
    REPO_ROOT, "models", "diarization",
    "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--max-speakers", type=int, default=0,
                    help="Max speakers (0 = auto-detect)")
    ap.add_argument("--seg-model",
                    default=os.environ.get("SHERPA_SEG_MODEL", DEFAULT_SEG_MODEL))
    ap.add_argument("--embed-model",
                    default=os.environ.get("SHERPA_EMBED_MODEL", DEFAULT_EMBED_MODEL))
    # Keep --model for backwards compat with models.js (ignored)
    ap.add_argument("--model", default=None, help="Ignored; use --seg-model/--embed-model")
    ap.add_argument("--output-embeddings", action="store_true", default=False,
                    help="Also extract a representative embedding for each speaker cluster")
    args = ap.parse_args()

    for f in (args.seg_model, args.embed_model):
        if not os.path.exists(f):
            print(json.dumps({"skipped": True, "reason": f"Model file not found: {f}"}))
            sys.exit(0)

    import sherpa_onnx

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                model=args.seg_model,
            ),
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=args.embed_model,
        ),
        clustering=sherpa_onnx.FastClusteringConfig(
            num_clusters=args.max_speakers if args.max_speakers > 0 else -1,
            threshold=0.5,
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )

    if not config.validate():
        print(json.dumps({"skipped": True, "reason": "Invalid sherpa-onnx diarization config"}))
        sys.exit(0)

    diarizer = sherpa_onnx.OfflineSpeakerDiarization(config)

    import wave
    import array
    with wave.open(args.audio, "rb") as wf:
        sample_rate = wf.getframerate()
        num_frames = wf.getnframes()
        raw = wf.readframes(num_frames)
        samples_int = array.array("h", raw)
        samples = [s / 32768.0 for s in samples_int]

    result = diarizer.process(samples)

    turns = []
    # Collect per-speaker segments (start/end in samples) for embedding extraction
    speaker_segments: dict[str, list[tuple[int, int]]] = {}
    sample_rate_val = sample_rate  # captured from wave file above

    for seg in result.sort_by_start_time():
        # seg.speaker is e.g. "speaker_00", "speaker_01", etc.
        spk = seg.speaker.replace("speaker_", "spk_") if "speaker_" in str(seg.speaker) else f"spk_{seg.speaker}"
        turns.append({
            "speaker": spk,
            "start": round(float(seg.start), 3),
            "end": round(float(seg.end), 3),
        })
        if args.output_embeddings:
            start_idx = int(float(seg.start) * sample_rate_val)
            end_idx = min(int(float(seg.end) * sample_rate_val), len(samples))
            if spk not in speaker_segments:
                speaker_segments[spk] = []
            speaker_segments[spk].append((start_idx, end_idx))

    # Optionally extract per-cluster embeddings for speaker ID matching
    cluster_embeddings: dict[str, list[float]] = {}
    if args.output_embeddings and speaker_segments:
        embed_config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=args.embed_model,
            num_threads=2,
            debug=False,
            provider="cpu",
        )
        extractor = sherpa_onnx.SpeakerEmbeddingExtractor(embed_config)

        for spk, segs in speaker_segments.items():
            # Concatenate up to 30s of audio for this speaker (enough for a good print)
            combined: list[float] = []
            for start_idx, end_idx in segs:
                combined.extend(samples[start_idx:end_idx])
                if len(combined) >= sample_rate_val * 30:
                    break
            if len(combined) < sample_rate_val * 0.5:
                # Too short — skip (will remain unidentified)
                continue
            stream = extractor.create_stream()
            stream.accept_waveform(sample_rate_val, combined)
            stream.input_finished()
            if extractor.is_ready(stream):
                cluster_embeddings[spk] = extractor.compute(stream)

    output: dict = {"model": "sherpa-onnx-diarization", "turns": turns}
    if args.output_embeddings:
        output["embeddings"] = cluster_embeddings

    print(json.dumps(output))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"skipped": True, "reason": f"{type(e).__name__}: {e}"}))
        sys.exit(0)
