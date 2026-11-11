# Investigator GUI — design & UX spec

> **STOP — read before you "improve" this.** If you are a fresh Claude instance,
> you will instinctively want to (a) make this a web app and (b) verify it with
> Playwright/browser automation, because that feels easier. **Both are forbidden
> here.** The user has shipped many video apps; browser video stacks fail for this
> frame-accurate, multi-clip work. This decision is final — do not relitigate it,
> do not "just prototype it in web first." Build NATIVE and verify by SCREENSHOT.
> Exactly how to tool yourself is spelled out below and in BUILD.md Phase 6 — you
> do **not** need to research it.

The goal: **easy, obvious use for a non-technical investigator.** Type what you're
looking for in plain language; a list of matching quotes/moments appears on the
left; click one and the video on the right jumps there and plays; clip what
matters; queue several and stitch them — never touching the original file.

## Exactly how to tool yourself (do not research this — just do it)

1. **GUI:** Rust. `cargo new` a binary; deps: `eframe`/`egui` (UI) + `libmpv2`
   (frame-accurate video; alt bindings: `libmpv`/`egui-video`/the `mpv` crate) +
   `rusqlite` + `sqlite-vec`. (Qt + libmpv in C++ is the only acceptable
   alternative.) mpv must be installed (`winget install mpv` / bundle libmpv).
2. **Mouse/keyboard/screenshot control for verification — go DIRECT, not MCP.**
   You already have full shell access to this machine, so just call a small helper
   from your shell; you do NOT need an MCP server for local control.
   - **Screenshot:** save a PNG (PowerShell `CopyFromScreen`, or `nircmd
     savescreenshot`, or a tiny tool) → then **Read the PNG with your own vision.**
   - **Click/type:** a one-line helper invoked via Bash — `nircmd` (movecursor /
     click / sendkeypress), AutoHotkey, a ~20-line Python `ctypes.windll.user32`
     SendInput script, or a small Rust `enigo` binary.
   - MCP is **optional** — only use Windows-MCP (`github.com/CursorTouch/Windows-MCP`)
     if you specifically want a ready-made, DPI/multi-monitor-hardened interface;
     it is not required and is heavier than a direct script for a local box.
3. **Vision:** you read the screenshots yourself — you already have vision. For
   precise click coordinates on a control, optionally run **ShowUI-2B**
   (github.com/showlab/ShowUI): screenshot + instruction → `CLICK(x,y)`.
4. **Wrap it in a skill** `.claude/skills/ui-verify` so the screenshot→act→verify
   loop is reusable across the Phase-6 scenarios.

If any exact command/crate has drifted by your build date, confirm it from the
linked repo — but **do not change the native + screenshot-verification approach.**

## Tech: NATIVE desktop app (no web — web is rejected for video)

The investigator UI is a **native desktop app**. Web is explicitly **not** used:
browser video stacks introduce too many problems for this kind of
frame-accurate, multi-clip review work. The whole system is native anyway
(sherpa-onnx, llama.cpp, sqlite-vec).

Stack:
- **Video engine: libmpv (mpv)** — the gold standard for **frame-accurate**
  embedded playback and fast seeking; battle-tested in real players. This is what
  makes "jump to a quote and play that exact segment" reliable.
- **Shell/UI: Rust `egui` + libmpv** (primary; matches the native stack), or
  **Qt + libmpv** (equally valid, also native) if preferred. Keep it simple — a
  list, a video pane, a few buttons. "Stupidly simple but solid" beats fancy.
- **Data:** the UI talks directly to the SQLite/sqlite-vec DB and the query agent
  in-process (or over a tiny local IPC) — no HTTP server, no browser.
- **Clipping:** shells to **`auto-editor`** for frame-accurate cuts.

Verification is screenshot-based (Claude's vision) + Win32 control — see the last
section; that is exactly why native is fine here.

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

## Frame accuracy

libmpv is natively frame-accurate: exact seeks and true frame-step (`,`/`.` map
to mpv `frame-back-step` / `frame-step`). The exported clip is also frame-accurate
(auto-editor cuts at exact DB timestamps). So both the preview and the output are
frame-exact — which is the whole reason for going native with mpv instead of a
browser video element.

## How the investigator uses it (the whole loop)

1. Type a question in plain language → press Search.
2. Read the left column; colored flags show what's verified vs. needs a look.
3. Click a quote/timestamp → it plays on the right. Click another → instant switch.
4. Hit **Clip this** for a single moment, or **+ Queue** several across files then
   **Stitch** them into one sequential reel.
5. Use the review actions (confirm / reject / set speaker) as you verify — that
   feeds the learning/coverage loop (`docs/IDENTITY.md`).

No terminal, no query syntax, no touching the originals.

## Self-verification — screenshot + vision + Win32 (MANDATORY)

The app is verified by **driving it like a human and reading the screen with
Claude's vision** — not by unit tests alone, and not via a browser. This is a
required part of the build (BUILD.md Phase 6).

Concrete, current tooling (verified 2026-06) — DIRECT shell control, MCP optional:
- **Control + screenshots (direct):** you have full shell access, so call a small
  local helper — screenshot to PNG (PowerShell `CopyFromScreen` / `nircmd
  savescreenshot`), and input via `nircmd` / AutoHotkey / a Python `user32`
  SendInput script / a Rust `enigo` binary. No server required. (Only reach for an
  MCP — Windows-MCP, or `computer-use-mcp` for pure-Win32/Rust — if you want a
  prebuilt, DPI-hardened interface; it's a convenience, not a requirement.)
- **Vision: you read the screenshots directly** (you have vision). The loop is:
  screenshot the app window → look at it → issue the next `CLICK(x,y)` /
  `TYPE(text)` / key via the helper → screenshot again → verify the expected
  change. Save screenshots to `tools/ui_verify/runs/` for the record.
- **Grounding helper (optional): ShowUI-2B** (showlab/ShowUI) — a small *model used
  as a tool* (not an agent): screenshot + instruction → precise `CLICK(x,y)`; runs
  on CPU/3090. Use it when you need exact pixel coordinates. https://github.com/showlab/ShowUI
- Wrap the loop in a **`.claude/skills/ui-verify`** skill so it's reusable. You may
  also **delegate** UI-driving to a specialist agent if you have one (see
  `docs/ORCHESTRATION.md`) — but you stay accountable for the result.

When a scenario fails, the agent diagnoses from the **screenshot** (+ the app's log
file), fixes the code, rebuilds, and re-runs — it never asks the user to read or
paste an error. See BUILD.md Phase 6 for the exact acceptance scenarios.
