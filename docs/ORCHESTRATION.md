# Agents, tools, and orchestration (terminology + how this build delegates)

The words get used loosely across vendors. Here's the precise spectrum this
project uses, then how the build may delegate to *other* agents (Qwen-CLI,
a WSL Hermes instance, ShowUI) — not just Claude's own subagents.

## The spectrum (least → most autonomous)

| Term | What it is | The test | Examples here |
|---|---|---|---|
| **Tool** (deterministic) | fixed function/script, same in → same out | no model involved | `ffmpeg`, `auto-editor`, `click.ps1 x y`, the SQL queries |
| **Model-as-tool** (single-shot) | a *model* called once: input → output. **No loop, no goal, no autonomy.** | one prompt → one answer | **ShowUI-2B** (screenshot+"click Search" → `CLICK x,y`); an embedding model; a one-shot classifier |
| **Agent** | takes a goal, **plans, acts in a loop, observes, adapts** | runs an autonomous loop toward a goal | Claude Code, Qwen-CLI, Hermes, the per-media context-review call |
| **Subagent** | an agent spawned by another agent, same family, scoped task | a child agent with its own fresh context | Claude Code's phase subagents |
| **Orchestrator / supervisor** | an agent whose job is to break work up and route it to specialists | decides *who* does *what*, then integrates results | the lead build agent |

**Deciding line:** runs an autonomous loop toward a goal → **agent**; returns one
answer to one prompt → **tool / model-as-tool**. So ShowUI is a tool, not an
"agent driving the mouse." Claude handing a whole task to another looping agent
*is* agent-to-agent.

## Two protocols (you'll see both)

- **MCP = agent → tools.** A standard adapter so an agent can call tools/data.
  Useful for reusing maintained tools or reaching tools the agent can't shell to
  (remote/sandboxed). **For a local box the agent fully controls, you usually
  don't need MCP — just call the script from the shell.** (This is why this repo
  controls the mouse/screenshot directly, not via an MCP server.)
- **A2A = agent → agent.** Delegation/handoff between autonomous agents. (ACP =
  orchestrating multi-agent workflows.) When you want "my manager agent hands work
  to my other agents," that's the A2A idea.

## The pattern you want: heterogeneous orchestrator-worker

One **orchestrator** agent routes each subtask to the **specialist** best at it —
where the specialists are *different* agents/models, not all Claude. You talk only
to the orchestrator; it micromanages the workers.

**Lightweight, CLI-native way (preferred here — no heavy framework):** the
orchestrator just **shells out to each agent's CLI** and reads the result. The
shell is the bus:
- `qwen -p "<bulk or specialized task>"` — cheap/bulk work, or things Claude lacks;
  also a way to dodge Claude rate limits on simple tasks (**cost/capability routing**).
- `wsl bash -lc "hermes '<question>'"` — run things by the **WSL Hermes** advisor
  that has read access + memories of your past failure patterns; an ideal
  **critic/advisor** in the loop ("does this plan match where I usually go wrong?").
- ShowUI-2B as a **tool** for precise click coordinates (not an agent).

Pre-built options if you ever want them (heavier): AWS **CLI Agent Orchestrator
(CAO)** (a supervisor coordinating Claude Code + other CLIs in tmux), **AgentPipe**
(Claude/Gemini/Qwen in shared rooms), **ntm** (tmux multi-agent), Claude Code
**agent teams**. Not required — shell delegation covers it.

## How this build is allowed to delegate

The build agent (orchestrator) MAY delegate to external specialist agents via
their CLIs, and SHOULD when another agent is better/cheaper:
- **Bulk / cheap / rate-limit-prone** subtasks → a cheaper CLI agent (e.g. Qwen-CLI).
- **Plan/risk review** → the WSL Hermes advisor ("review this approach against my
  failure patterns"), and the per-media nuance pass already supports a configurable
  backend (`docs/CONTEXT-REVIEW.md`).
- **UI driving** during verification → a specialist, if available.

## Guardrails (this is an evidence tool)

Delegation is great for *thinking, bulk work, and review*. But:
1. **Keep evidence-touching, deterministic steps controlled and logged.** Hashing,
   extraction, DB writes, attribution — these run in this pipeline with provenance,
   not handed off to a black-box agent.
2. **The lead agent stays accountable.** Record which agent/model produced each
   non-deterministic output (the schema's `model_name`/`backend`/provenance fields
   already do this). "Another agent said so" is not provenance.
3. **Mind the security surface.** A WSL agent with unrestricted read access, or any
   "YOLO mode," is powerful and dangerous near case files. Use such agents to
   *advise/route/do bulk*, not to autonomously act on the originals. Sources stay
   read-only regardless of who's driving.
4. **No unaccountable agent-driving-agent-driving-mouse.** If you delegate UI
   driving, you still verify the outcome by screenshot and own the result.
