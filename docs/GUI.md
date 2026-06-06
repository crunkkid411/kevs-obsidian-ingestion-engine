# Investigator GUI — design & UX spec

The goal: **easy, obvious use for a non-technical investigator.** Type what you're
looking for in plain language; a list of matching quotes/moments appears on the
left; click one and the video on the right jumps there and plays; clip what
matters; queue several and stitch them — never touching the original file.

## Tech decision: a LOCAL web app (engine stays native)

The investigator UI is a **local web app** (served on `127.0.0.1`, opened in a
browser or a thin webview). The heavy compute — ASR, diarization, embeddings,
VLM, vector search — stays **native** (sherpa-onnx, llama.cpp, sqlite-vec). Only
the thin UI shell is web.

Why this, not native egui (revised after research):
- **The autonomous build can verify itself reliably.** Browser automation
  (Playwright MCP / browser-harness, accessibility-tree targeting) is mature and
  dependable. A native immediate-mode egui canvas exposes almost no accessibility
  tree, so even Windows-MCP / pywinauto can't target its controls — you're left
  with slow, brittle screenshot-vision. For "test its own work with real clicks,"
  a web UI is the right call. (Sources in `docs/MODELS-2026.md` references.)
- **Easy + obvious for the human**, cross-platform, trivial to style.
- **Negligible bloat**: one small local server + the OS browser/webview. The 8GB
  VRAM is spent on models, not the UI.
- Native shells remain an option later: **Tauri** (Rust backend + system webview)
  packages the exact same web UI as a desktop app; libmpv+egui is the fully-native
  fallback if ever needed. Default to the plain localhost web app for build/verify
  simplicity.

Stack: a small **Rust (axum) or Go** backend exposing a localhost JSON API over
the SQLite/sqlite-vec DB + the query agent + clip/stitch (shells to `auto-editor`).
Frontend: plain HTML/CSS/JS (or a light framework) — no heavy SPA needed.

## Layout (matches the requested design)

```
┌───────────────────────────────────────────────────────────────────────┐
│  🔎  [ natural-language search box — full width ........... ] [Search]  │  ← top
├──────────────────────────────────────┬────────────────────────────────┤
│  RESULTS (≈50% width, scrollable)     │  VIDEO (≈50% width)            │
│                                       │  ┌──────────────────────────┐  │
│  ▸ [0:14:32] Defendant · ⚠ verify     │  │                          │  │
│    "imagine if my ex was harass…"     │  │       video player       │  │
│    stream01.mp4 · at Defendant's home │  │   (only part of screen)  │  │
│  ───────────────────────────────────  │  └──────────────────────────┘  │
│  ▸ [1:02:10] Defendant                 │  ⏮  ◀┃ ▶  ┃▶  ⏭   0:14:32 / …  │
│    "it's been like 4 months…"          │  [◀ frame] [frame ▶]            │
│  ───────────────────────────────────  │                                │
│  ▸ [0:03:01] phone_call · ⚠            │  [ ✂ Clip this ]  [ + Queue ]  │
│    second voice ~10s                   │                                │
│  …                                     │  QUEUE: 3 clips  [ Stitch ⬇ ]   │
│                                        │   1. stream01 0:14:30–0:14:40   │
│                                        │   2. stream01 1:02:05–1:02:20   │
│                                        │   3. stream07 0:03:00–0:03:12   │
└──────────────────────────────────────┴────────────────────────────────┘
```

- **Top:** the natural-language search box (primary interaction) + Search button.
- **Left column (~50%):** scrollable result rows. Each row shows **timestamp ·
  speaker name · flags**, the **quote/snippet**, and **file · location**. Clicking
  a row (or its timestamp) **immediately seeks the player to that segment and
  plays it.** Switching rows switches clips fast.
- **Right (~50%):** the video player (part of the screen, not full-bleed),
  transport controls, optional frame-step, a prominent **"Clip this"** button, an
  **"+ Queue"** button, and the **queue list** with **"Stitch ⬇"**.

## Visual design (from the supplied reference)

Near-black background, a few **meaningfully distinct neon accents** used
semantically (not decoratively) so the eye reads state at a glance without being
overwhelmed:

| Token | Hex (approx) | Meaning |
|---|---|---|
| `--bg` | `#0a0b12` | near-black navy background |
| `--surface` | `#12141d` | cards / panels |
| `--text` | `#e6e8ef` | primary text |
| `--muted` | `#8b90a3` | secondary text (timestamps, file paths) |
| `--cyan` (primary) | `#2dd4ff` | primary actions, Search, selected row, Clip |
| `--magenta` | `#ff5cf0` | search/semantic accent, links |
| `--violet` | `#a78bfa` | secondary accent, headers |
| `--green` | `#34d399` | confirmed / verified |
| `--amber` | `#fbbf24` | needs-review |
| `--red` | `#f87171` | attribution conflict / warning |

Use a subtle outer glow on the active/primary element only. Confidence shown as a
small inline chip (e.g. `92%`). Flags render as colored pills (`⚠ verify` amber,
`conflict` red, `confirmed` green). Keep it calm: one accent (cyan) drives the eye
to the current action; the rest are status colors used sparingly. The reference
icons are illustrative — don't copy them; copy the *restraint* and the
meaning-bearing color use.

## Natural-language search — yes, there's a query agent

The investigator types plain language ("every stream where he talks about his
wife", "phone calls at his home", "threats in March"). The search box POSTs to a
**query-agent endpoint** that turns that into real DB queries. How it works:

1. **Semantic retrieval** — embed the query with Qwen3-Embedding and ANN-search
   the `embeddings` table (this is `src/search/query.js`, already built).
2. **Alias/nickname expansion** — fold in known aliases & nicknames from the
   `entities` table so "his wife" also matches "my ex" etc. (already built,
   `--expand`).
3. **Intent parsing (LLM, optional but recommended)** — a small LLM call (the
   same backend as the context-review agent, or a cheap model) parses structured
   filters from the query: which **entity** (speaker_name / linked_entity), **time
   range**, **event kind** (`phone_call`, `location_change`), **location**, and a
   "verified only vs include unreviewed" intent. These become SQL filters layered
   on top of the semantic ranking.
4. **Rank + return** — merge structured filters with semantic similarity, return
   ranked segments with **file · exact timestamp · speaker · location · flags ·
   confidence**, plus the matching `context_annotations`. Every hit carries its
   provenance so the investigator verifies on the spot.

So the investigator never learns a query syntax — they talk; the agent routes. If
the LLM intent-parse is disabled, it gracefully degrades to semantic + alias
search (still natural-language-ish, just less precise on filters like dates).

This endpoint is GUI-configurable: `QUERY_AGENT_BACKEND` / `QUERY_AGENT_MODEL`
(see `config/settings.schema.json`). For sensitive deployments use the local
backend; for testing, an API model.

## Clipping & stitching (never touches the original)

- **"Clip this"** cuts the currently-playing/selected segment using **`auto-editor`**
  (frame-accurate, the tool you already run) reading the **original as input** and
  writing a NEW file to an exports dir. The DB stores a `clips` row (source, in/out,
  label, exported_path). The original is never modified.
- **"+ Queue"** adds the segment to a clip queue (can span multiple source files).
- **"Stitch ⬇"** exports each queued segment (auto-editor) and concatenates them
  **in queue order** into one file (ffmpeg concat / auto-editor). Output to the
  exports dir; queue order = playback order.
- Exact in/out come from the DB timestamps (produced by frame-accurate extraction),
  so the *output* clip is frame-accurate regardless of the preview player.

## Frame accuracy in the preview (honest note)

HTML5 `<video>` seeking is best-effort, not guaranteed frame-exact — fine for
"jump here and play." Where frame accuracy actually matters — the **exported
clip** — it comes from auto-editor cutting at exact DB timestamps, not from the
preview. If true in-UI frame-stepping is wanted, implement the frame-step buttons
with the **WebCodecs API** (real frame accuracy in the browser); otherwise the
`,`/`.` buttons nudge by `1/fps` seconds, which is close enough for review.

## How the investigator uses it (the whole loop)

1. Type a question in plain language → press Search.
2. Read the left column; colored flags show what's verified vs. needs a look.
3. Click a quote/timestamp → it plays on the right. Click another → instant switch.
4. Hit **Clip this** for a single moment, or **+ Queue** several across files then
   **Stitch** them into one sequential reel.
5. Use the review actions (confirm / reject / set speaker) as you verify — that
   feeds the learning/coverage loop (`docs/IDENTITY.md`).

No terminal, no query syntax, no touching the originals.

## Build & self-verification method (corrected)

- **Build** the UI as the local web app above.
- **Self-verify (BUILD.md Phase 6) with browser automation**, not pyautogui:
  **Playwright MCP** (or browser-harness) drives a real browser against the local
  URL — accessibility-tree targeting, reliable clicks/typing, screenshots, and the
  agent fixes its own failures from what it sees. This is why the UI is web.
- *If* a fully-native shell is ever required, the verification fallback is
  **Windows-MCP + pywinauto (UI Automation)** — still far better than coordinate-
  based pyautogui — but expect weak control over an egui canvas, which is the
  reason the default is web.
