#!/usr/bin/env python3
"""
Frame-accurate frame extraction.

The complaint this fixes: "one frame of ffmpeg is not one frame of a video."
Naive `ffmpeg -ss <t> -i input` does a FAST (keyframe) seek and hands you the
nearest I-frame, not the frame you asked for. And OpenCV's
`cap.set(CAP_PROP_POS_FRAMES, n)` is unreliable on many codecs. This script
computes exact timestamps from the video's TRUE rational frame rate and uses
ffmpeg ACCURATE (decode) seeking so the frame you get is the frame you asked for.

It never modifies the source. It writes JPEGs + a JSON manifest mapping each
image to its exact frame index and timestamp.

Modes:
  --frames "100,250,999"     extract these exact frame indices
  --timestamps "12.5,90.0"   extract the exact frame at/just-before each time
  --interval 5               one exact frame every 5 seconds
  --scene 0.4                detect shot cuts (scene score > threshold) and
                             extract one exact frame per shot
  --fps 30                   (with --interval style) sample at a uniform rate by
                             frame stride = round(true_fps / target_fps)

Usage:
  python3 extract_frames_precise.py <video> <out_dir> [mode...] [--accurate/--fast]

Requires ffmpeg + ffprobe on PATH. No Python deps beyond the stdlib.
"""
import argparse
import json
import os
import subprocess
import sys
from fractions import Fraction


def ffprobe(video):
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", video,
    ]
    data = json.loads(subprocess.check_output(cmd))
    v = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
    rate = v.get("avg_frame_rate") or v.get("r_frame_rate") or "0/1"
    fps = Fraction(rate) if rate and rate != "0/0" else Fraction(0)
    duration = float(data.get("format", {}).get("duration") or v.get("duration") or 0.0)
    nb = v.get("nb_frames")
    frame_count = int(nb) if nb and nb.isdigit() else (
        int(round(duration * float(fps))) if fps and duration else None
    )
    return {
        "fps": fps,
        "fps_float": float(fps) if fps else None,
        "duration": duration,
        "frame_count": frame_count,
        "width": v.get("width"),
        "height": v.get("height"),
    }


def frame_to_timestamp(frame_idx, fps):
    """Exact midpoint timestamp of a frame index given a rational fps."""
    # midpoint avoids landing exactly on a boundary between two frames
    return float((Fraction(frame_idx) + Fraction(1, 2)) / fps)


def extract_one(video, timestamp, out_path, accurate=True, quality=2):
    """
    Extract a single frame at `timestamp`.
    accurate=True -> output seek (-ss AFTER -i): decodes to the exact frame.
    accurate=False -> input seek (-ss BEFORE -i): fast, keyframe-snapped.
    """
    if accurate:
        cmd = ["ffmpeg", "-nostdin", "-y", "-i", video,
               "-ss", f"{timestamp:.6f}", "-frames:v", "1",
               "-q:v", str(quality), out_path]
    else:
        cmd = ["ffmpeg", "-nostdin", "-y", "-ss", f"{timestamp:.6f}", "-i", video,
               "-frames:v", "1", "-q:v", str(quality), out_path]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def detect_scene_cuts(video, threshold):
    """
    Deterministic shot-cut detection via ffmpeg's scene score.
    Returns a sorted list of (frame_idx, timestamp) for detected cuts.
    """
    # showinfo prints pts_time + n for frames passing the scene filter
    cmd = [
        "ffmpeg", "-nostdin", "-i", video,
        "-vf", f"select='gt(scene,{threshold})',showinfo",
        "-f", "null", "-",
    ]
    proc = subprocess.run(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL)
    cuts = []
    for line in proc.stderr.decode(errors="ignore").splitlines():
        if "showinfo" in line and "pts_time" in line:
            ts = None
            for tok in line.split():
                if tok.startswith("pts_time:"):
                    try:
                        ts = float(tok.split(":", 1)[1])
                    except ValueError:
                        pass
            if ts is not None:
                cuts.append(ts)
    return cuts


def main():
    ap = argparse.ArgumentParser(description="Frame-accurate frame extraction")
    ap.add_argument("video")
    ap.add_argument("out_dir")
    ap.add_argument("--frames", help="comma-separated exact frame indices")
    ap.add_argument("--timestamps", help="comma-separated seconds")
    ap.add_argument("--interval", type=float, help="one frame every N seconds")
    ap.add_argument("--fps", type=float, help="uniform sample rate (frames/sec)")
    ap.add_argument("--scene", type=float, help="scene-cut threshold (e.g. 0.4)")
    ap.add_argument("--max-frames", type=int, default=0, help="cap output (0 = no cap)")
    ap.add_argument("--fast", action="store_true", help="fast keyframe seek (less precise)")
    args = ap.parse_args()

    if not os.path.exists(args.video):
        print(json.dumps({"error": f"not found: {args.video}"}))
        sys.exit(1)
    os.makedirs(args.out_dir, exist_ok=True)

    meta = ffprobe(args.video)
    fps = meta["fps"]
    accurate = not args.fast

    # Resolve the set of (frame_idx, timestamp) targets ---------------------
    targets = []  # list of dicts: {frame, timestamp}
    if args.frames:
        for f in args.frames.split(","):
            f = int(f.strip())
            targets.append({"frame": f, "timestamp": frame_to_timestamp(f, fps)})
    elif args.timestamps:
        for t in args.timestamps.split(","):
            t = float(t.strip())
            fr = int(t * float(fps)) if fps else None
            targets.append({"frame": fr, "timestamp": t})
    elif args.scene is not None:
        for ts in detect_scene_cuts(args.video, args.scene):
            fr = int(ts * float(fps)) if fps else None
            targets.append({"frame": fr, "timestamp": ts})
    elif args.interval or args.fps:
        step = args.interval if args.interval else (1.0 / args.fps)
        t = 0.0
        dur = meta["duration"] or 0.0
        while t < dur:
            fr = int(t * float(fps)) if fps else None
            targets.append({"frame": fr, "timestamp": t})
            t += step
    else:
        print(json.dumps({"error": "pick a mode: --frames/--timestamps/--interval/--fps/--scene"}))
        sys.exit(2)

    if args.max_frames and len(targets) > args.max_frames:
        # even subsample, keep deterministic
        stride = len(targets) / args.max_frames
        targets = [targets[int(i * stride)] for i in range(args.max_frames)]

    # Extract ---------------------------------------------------------------
    frames_out = []
    for i, tgt in enumerate(targets):
        name = f"f{tgt['frame'] if tgt['frame'] is not None else i:08d}.jpg"
        out_path = os.path.join(args.out_dir, name)
        try:
            extract_one(args.video, tgt["timestamp"], out_path, accurate=accurate)
            frames_out.append({
                "frame_index": tgt["frame"],
                "timestamp": round(tgt["timestamp"], 4),
                "path": out_path,
            })
        except subprocess.CalledProcessError as e:
            print(f"[warn] failed frame {tgt}: {e}", file=sys.stderr)

    print(json.dumps({
        "video": args.video,
        "fps_exact": str(fps),
        "fps_float": meta["fps_float"],
        "duration": meta["duration"],
        "frame_count": meta["frame_count"],
        "width": meta["width"],
        "height": meta["height"],
        "seek_mode": "accurate" if accurate else "fast",
        "frames_extracted": len(frames_out),
        "frames": frames_out,
    }, indent=2))


if __name__ == "__main__":
    main()
