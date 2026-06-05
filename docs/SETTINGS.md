# Settings: what the investigator controls vs. what's set once

Principle (from the brief): **anything that may need regular adjustment by the
user belongs in the GUI; anything that just needs to be right once does not — but
the AI implementing/maintaining the system must still know it exists.**

The machine-readable source of truth is **`config/settings.schema.json`**. The
GUI renders every entry with `gui: true`; the maintaining AI reads the whole file.
Each entry has a `key`, `label`, `type`, `default`, `group`, and `help`.

## GUI-exposed (the investigator adjusts these)

| Setting | Why it's user-facing |
|---|---|
| **Case context & instructions** (`CONTEXT_REVIEW_SYSTEM_PROMPT`, the prompt file) | Updated constantly as the case develops — the single most-edited field |
| **Review backend / model** (`CONTEXT_REVIEW_BACKEND`, `_MODEL`) | Switch between the local (sensitive) instance and API test models |
| **Parallel files under review** (`CONTEXT_REVIEW_CONCURRENCY`) | Throughput vs. precision / rate limits |
| **Include unverified results** (`SEARCH_INCLUDE_UNREVIEWED`), **results per search** (`SEARCH_TOP_K`) | Everyday search behavior |
| **Accuracy (advanced):** speaker visual-confidence floor, voice/face match floor, new-location sensitivity | Tuned against the coverage report as the archive is reviewed |

## Set-once / maintainer-only (kept OUT of the GUI)

| Setting | Why it's not user-facing |
|---|---|
| Storage backend (`STORAGE`) | Install-time decision (sqlite vs central postgres) |
| Model ids & dims (`ASR_MODEL`, `TEXT_EMBED_MODEL`, `TEXT_EMBED_DIM`) | The implementing AI owns model choice; changing them needs re-embedding/migration |
| Pipeline internals (`SCENE_THRESHOLD`, `DIAR_MAX_SPEAKERS`) | Deterministic mechanics, set right once |
| Paths (`LOCAL_ROOT`, `OSINT_EXPORT_DIR`) | Install-time |

## For whoever builds the GUI
Render `gui: true` settings grouped by `group`; put the `Accuracy (advanced)`
group behind a disclosure. Write changes back to `.env` (or the settings store)
using the `key`. The `CONTEXT_REVIEW_SYSTEM_PROMPT` entry has a `file` field —
edit that file directly (it's long-form markdown), not an env var. Never surface
`gui: false` settings to the investigator; expose them only in a maintainer/admin
view or leave them to the implementing AI.
