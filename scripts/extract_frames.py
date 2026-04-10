#!/usr/bin/env python3
"""
Extract key frames from a video using OpenCV scene detection.
Instead of blindly sampling at even intervals, this detects scene changes
and picks the most visually distinct frames.

Usage: python3 scripts/extract_frames.py <video_path> <output_dir> [--max-frames 6]
Output: JSON to stdout with frame metadata
"""

import cv2
import sys
import os
import json
import argparse
import numpy as np


def detect_scene_changes(video_path, threshold=30.0):
    """Detect scene changes by comparing frame histograms."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration = total_frames / fps if fps > 0 else 0

    prev_hist = None
    scene_changes = []
    frame_idx = 0

    # Sample every 0.5 seconds for efficiency
    sample_interval = max(1, int(fps * 0.5))

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % sample_interval == 0:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            hist = cv2.calcHist([gray], [0], None, [256], [0, 256])
            cv2.normalize(hist, hist)

            if prev_hist is not None:
                diff = cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CHISQR)
                if diff > threshold:
                    timestamp = frame_idx / fps
                    scene_changes.append({
                        "frame_idx": frame_idx,
                        "timestamp": round(timestamp, 2),
                        "diff_score": round(diff, 2),
                    })

            prev_hist = hist

        frame_idx += 1

    cap.release()
    return scene_changes, duration, fps, total_frames


def extract_key_frames(video_path, output_dir, max_frames=6):
    """Extract key frames using scene detection + even distribution fallback."""
    os.makedirs(output_dir, exist_ok=True)

    scene_changes, duration, fps, total_frames = detect_scene_changes(video_path)

    # If we found enough scene changes, use those; otherwise fall back to even spacing
    if len(scene_changes) >= max_frames:
        # Pick the top N most significant scene changes
        scene_changes.sort(key=lambda x: x["diff_score"], reverse=True)
        selected = sorted(scene_changes[:max_frames], key=lambda x: x["timestamp"])
    else:
        # Even spacing fallback, plus any detected scene changes
        interval = duration / (max_frames + 1)
        even_timestamps = [interval * (i + 1) for i in range(max_frames)]

        # Merge scene changes with even samples, deduplicate by proximity
        all_timestamps = []
        for sc in scene_changes:
            all_timestamps.append(sc["timestamp"])
        for ts in even_timestamps:
            if not any(abs(ts - existing) < 2.0 for existing in all_timestamps):
                all_timestamps.append(ts)

        all_timestamps.sort()
        selected = [{"timestamp": ts, "frame_idx": int(ts * fps)} for ts in all_timestamps[:max_frames]]

    # Extract the actual frames
    cap = cv2.VideoCapture(video_path)
    frames_out = []

    for i, scene in enumerate(selected):
        frame_idx = scene["frame_idx"]
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret:
            continue

        frame_path = os.path.join(output_dir, f"frame_{i+1}.jpg")
        cv2.imwrite(frame_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 90])

        # Basic frame analysis with OpenCV
        analysis = analyze_frame(frame)

        frames_out.append({
            "frame_number": i + 1,
            "timestamp": scene["timestamp"],
            "path": frame_path,
            "resolution": f"{frame.shape[1]}x{frame.shape[0]}",
            **analysis,
        })

    cap.release()

    return {
        "video_path": video_path,
        "duration": round(duration, 2),
        "fps": round(fps, 2),
        "total_frames": total_frames,
        "scene_changes_detected": len(scene_changes),
        "frames_extracted": len(frames_out),
        "frames": frames_out,
    }


def analyze_frame(frame):
    """Run basic OpenCV analysis on a single frame."""
    result = {}

    # Face detection using Haar cascades
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    face_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
    result["faces_detected"] = len(faces)

    # Upper body detection
    upper_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_upperbody.xml"
    )
    upper_bodies = upper_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=3, minSize=(50, 50))
    result["upper_bodies_detected"] = len(upper_bodies)

    # Dominant color (rough scene type indicator)
    avg_color = frame.mean(axis=(0, 1))
    result["avg_color_bgr"] = [round(c, 1) for c in avg_color.tolist()]

    # Brightness
    result["brightness"] = round(gray.mean(), 1)

    # Blur detection (low = sharp/detailed, high = blurry/motion)
    laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()
    result["sharpness"] = round(laplacian_var, 1)

    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract key frames from video")
    parser.add_argument("video_path", help="Path to video file")
    parser.add_argument("output_dir", help="Directory to save frames")
    parser.add_argument("--max-frames", type=int, default=6, help="Max frames to extract")
    args = parser.parse_args()

    result = extract_key_frames(args.video_path, args.output_dir, args.max_frames)
    print(json.dumps(result, indent=2))
