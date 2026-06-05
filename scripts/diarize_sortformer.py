#!/usr/bin/env python3
"""
Audio speaker diarization with NVIDIA Sortformer (<=4 speakers).

Contract (stdout JSON):
  { "model", "turns":[{"speaker":"spk_0","start":float,"end":float}] }

NOTE: Written against the model card, NOT executed here. Validate on the GPU box.
Install: pip install -U nemo_toolkit[asr]
Model: nvidia/diar_streaming_sortformer_4spk-v2.1

IMPORTANT (evidence): Sortformer caps at 4 speakers. Livestreams with guests,
callers, or crowds WILL exceed that and mislabel on audio alone — which is why
the visual active-speaker stage (asd_lr_asd.py) is mandatory, not optional.

Usage: python diarize_sortformer.py <audio.wav> [--max-speakers 4]
"""
import argparse, json, sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--max-speakers", type=int, default=4)
    ap.add_argument("--model", default="nvidia/diar_streaming_sortformer_4spk-v2.1")
    args = ap.parse_args()

    from nemo.collections.asr.models import SortformerEncLabelModel
    diar = SortformerEncLabelModel.from_pretrained(args.model)
    diar.eval()

    # Returns segments like "start end speaker" per the model card's predict API.
    preds = diar.diarize(audio=[args.audio], batch_size=1)

    turns = []
    for seg in preds[0]:
        # seg may be "start end spk" string or a tuple depending on NeMo version
        if isinstance(seg, str):
            start, end, spk = seg.split()
        else:
            start, end, spk = seg
        turns.append({
            "speaker": f"spk_{spk}" if not str(spk).startswith("spk") else str(spk),
            "start": round(float(start), 3),
            "end": round(float(end), 3),
        })

    print(json.dumps({"model": args.model, "turns": turns}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"skipped": True, "reason": f"{type(e).__name__}: {e}"}))
        sys.exit(0)
