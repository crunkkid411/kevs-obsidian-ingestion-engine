# ASD-SETUP.md — LR-ASD ONNX Export & Integration

Active Speaker Detection (ASD) is the misattribution fix: it resolves which
on-screen face is actually speaking when multiple faces are visible.  Without
it, every utterance that comes from a speaker not visually confirmed is flagged
`needs_review = 1`.

## Current status

`ASD_BACKEND=none` in `.env`.  The pipeline runs correctly — utterances are
flagged `needs_review` rather than silently mis-attributed.  This is the safe
default until ASD is wired.

## Model: Light-ASD (LR-ASD)

- Repo: https://github.com/Junhua-Liao/Light-ASD
- Architecture: lightweight MobileNet-based temporal model; ~2 MB.
- Input: video frames (25 fps, face crop) + audio (MFCC, 25 fps aligned).
- Output: per-face per-frame binary active/silent score.

## Export to ONNX

### 1. Clone and install

```bash
git clone https://github.com/Junhua-Liao/Light-ASD.git
cd Light-ASD
pip install -e .
# Download pretrained checkpoint from the repo releases
```

### 2. Export script

```python
# export_light_asd.py
import torch
from model.ASD import ASD  # Light-ASD module

model = ASD()
model.load_state_dict(torch.load("path/to/checkpoint.pt", map_location="cpu"))
model.eval()

# Dummy inputs matching the model's expected shape:
#   audio: (batch=1, T=100, 13 MFCCs)
#   video: (batch=1, T=100, 1, 112, 112) face crops, grayscale
audio_dummy = torch.zeros(1, 100, 13)
video_dummy = torch.zeros(1, 100, 1, 112, 112)

torch.onnx.export(
    model,
    (audio_dummy, video_dummy),
    "models/asd/light_asd.onnx",
    input_names=["audio", "video"],
    output_names=["score"],
    dynamic_axes={"audio": {1: "T"}, "video": {1: "T"}},
    opset_version=17,
)
print("Exported: models/asd/light_asd.onnx")
```

### 3. Verify

```bash
python -c "
import onnxruntime as ort
s = ort.InferenceSession('models/asd/light_asd.onnx')
print([i.name for i in s.get_inputs()])
"
```

### 4. Face detector: SCRFD

LR-ASD needs face crops.  Use SCRFD (scrfd_500m_bnkps.onnx from InsightFace):

```bash
# Download buffalo_l pack (contains det_500m.onnx)
# https://github.com/deepinsight/insightface/releases
# Place det_500m.onnx at models/asd/scrfd_500m.onnx
```

## Wiring into the pipeline

1. Place `light_asd.onnx` at `models/asd/light_asd.onnx`
2. Place SCRFD model at `models/asd/scrfd_500m.onnx`
3. Set `ASD_BACKEND=light_asd` in `.env`
4. Implement `scripts/asd_lr_asd.py`:
   - Accept `<video.mp4> --turns-b64 <base64-json-turns>`
   - For each turn: extract frames at 25 fps via ffmpeg, run SCRFD to get face
     crops, compute MFCC on the aligned audio window, feed both into
     `light_asd.onnx` via `onnxruntime`
   - Output JSON:
     ```json
     { "model": "light-asd",
       "results": [
         {"start": 0.0, "end": 3.5, "visible_speaker": "spk_0", "score": 0.91, "faces": 1}
       ]
     }
     ```
5. The skeleton already exists at `scripts/asd_lr_asd.py`

## Why it matters

Without ASD (current state):
- All utterances have `needs_review = 1`
- The investigator must manually verify each one

With ASD:
- On-screen monologue: utterance flips to `needs_review = 0` automatically
- Off-screen/phone voice: flagged `attribution_conflict = 1` + `needs_review = 1`
- Multi-face scene: the speaking face is identified by name if enrolled

## Acceptance test (post-wire)

```bash
ASD_BACKEND=light_asd node src/ingest.js .
# Then query:
node -e "
import('./src/db/index.js').then(async ({connect,getPool}) => {
  await connect();
  const r = getPool().prepare(
    'SELECT needs_review, count(*) n FROM utterances GROUP BY needs_review'
  ).all();
  console.log(r);
  process.exit(0);
});
"
# Expect: needs_review=0 for single-speaker on-screen utterances
```
