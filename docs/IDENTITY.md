# Identity & location naming — the knowledge base

The difference between a tool detectives ignore and one they use is whether it
speaks like a person. "Speaker 1 in a descriptive background" is AI-speak nobody
wants to decode. This system says **"Defendant at home, 0:14:32"** — and when it
can't, it says **"unidentified speaker, unknown location"** so the gap is obvious.

This is a **triage tool, not court evidence** — every item is verified by a human
at playback — so it should **conclude**, not hedge. Naming confidently is also how
we *measure* accuracy: if it names the defendant and is wrong, you see it instantly;
if it only ever says "a speaker," a 50%-miss rate is invisible.

## What you provide (the knowledge base)

In `config/taxonomy.json`:

- **entities** — each person/place/thing: canonical name, aliases, audience
  nicknames, descriptions, and **timeline anchors** (e.g. separation date, so
  "my ex … 4 months" resolves to the wife).
- **known_locations** — a name ("Defendant's home") + **reference_frames** (clean
  screenshots of that place you can confirm). The pipeline perceptual-hashes them;
  matching footage is auto-labeled with the place name + a confidence.
- **enrollment_clips** — clips you can confirm are the defendant *talking* (voice)
  or *on screen* (face). The native build extracts a **voice print** and **face
  print** and stores them so future videos are named automatically.

You confirm the ground truth once; the system applies it everywhere.

## How naming works (and where it's tested)

| Signal | Match against | Becomes | Status |
|---|---|---|---|
| location aHash (per shot) | `known_locations.reference_ahashes` (Hamming) | "Defendant's home" + conf | **implemented & tested** (`src/analyze/identify.js`, wired in `ingest.js`) |
| voice embedding (per cluster) | enrolled voice prints (cosine) | "Defendant" + conf | logic implemented & unit-tested; needs the native voice model to produce embeddings |
| face embedding (per on-screen face) | enrolled face prints (cosine) | names the on-screen person | native build (ArcFace via `ort`) |

When nothing clears the threshold, the label is a **stable** "unidentified
speaker N" / "unknown location" — never an opaque `spk_0`.

## The learning loop (`npm run consolidate`)

Run nightly or after a review session. It:

1. **Propagates** confirmed identities: when a reviewer binds a cluster to an
   entity (in the player), that name is applied to that person's utterances, and
   (native build) to matching voice/face clusters in every other video.
2. **Reports coverage** so accuracy is visible:
   ```
   === COVERAGE (92 videos) ===
     Defendant: recognized in 47/92 videos (51%)  ⚠ low — check enrollment/threshold
     unidentified: 310 utterances across 45 videos
     locations:
       Defendant's home: 38/92 videos
   ```
   A low percentage means a weak/missing enrollment or too-strict threshold — a
   concrete knob to turn, not a mystery. (Coverage + propagation are **implemented
   and tested** against Postgres; cross-video voice/face matching is the native
   build's job.)

## Tuning knobs
- `ASD_CONF_FLOOR` — visual speaker confidence floor.
- voice/face cosine floor (`matchIdentity`, default 0.5) — lower = more names,
  more false matches; raise if you see wrong names.
- `LOCATION_CHANGE_THRESHOLD` / location Hamming max (`matchLocation`, default 14)
  — how similar a background must be to count as the same place.

Tune by watching coverage + spot-checking named hits in the player. Because
verification is one click from the frame, you can move fast and aggressively name.

## Boundaries (unchanged)
- The tool **corroborates**; it never concludes *where* footage was shot for the
  record — `known_locations` is your confirmed input, and OSINT frame export is
  for the detective's own fixture matching.
- Every name is a **claim with a confidence and provenance**, reviewable and
  overridable. Detectives decide what's real and what goes to court.
