#!/usr/bin/env node
/**
 * PreToolUse guard for Claude Code (and any agent that honors Claude Code hooks).
 *
 * Deterministic enforcement of the rules that prose kept failing to enforce.
 * It reads the tool call on stdin; if a Bash command matches a banned pattern it
 * writes a reason to stderr and exits 2 (a hard block — the command never runs).
 * Everything else is allowed. This is intentionally narrow: it bans the SPECIFIC
 * slop behaviors, not normal work.
 *
 * Wired in .claude/settings.json (PreToolUse → Bash → `node .claude/hooks/guard.mjs`).
 * It's your repo — if a rule is wrong, edit the list below.
 */
import { readFileSync } from 'node:fs';

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }

let cmd = '';
try {
  const j = JSON.parse(raw || '{}');
  if ((j.tool_name || '') === 'Bash') cmd = j.tool_input?.command || '';
} catch { /* not JSON; allow */ }

if (!cmd) process.exit(0);

const BANS = [
  // Popup / external media players used INSTEAD of the native app.
  [/\b(ffplay|vlc)\b/i, 'Popup media players are banned. The player is the NATIVE egui + libmpv app (docs/GUI.md). Embed libmpv; do not pop a window.'],
  [/\bmpv\s+[^\n]*\.(mp4|mkv|mov|avi|webm|m4v)\b/i, 'Launching the mpv CLI on a video is banned. Use the libmpv LIBRARY inside the Rust app, not the mpv command.'],
  [/\b(start|open|xdg-open)\b[^\n]*\.(mp4|mkv|mov|avi|webm|m4v)\b/i, 'Opening a video in an external viewer is banned. Play it INSIDE the app.'],
  // Web / Electron / Tauri UIs — the GUI is native. Do not relitigate.
  [/\b(vite|webpack|parcel|rollup|nuxt|astro|streamlit|gradio|electron|tauri)\b/i, 'Web/Electron/Tauri UIs are BANNED. The GUI is NATIVE Rust egui + libmpv (docs/GUI.md). This decision is final.'],
  [/\bnext\s+(dev|build|start)\b/i, 'Next.js / web UI is banned. Native Rust GUI only.'],
  [/create-(react|next|vite|vue|svelte)-app/i, 'Web frontend scaffolds are banned. Native Rust GUI only.'],
  // Local web servers standing in for the app.
  [/python\s+-m\s+http\.server|\bhttp-server\b|\bnpx?\s+serve\b|\b(flask|uvicorn|gunicorn|fastapi)\b/i, 'Local web servers are banned. The app is a native desktop binary, not a web page.'],
  // Browser automation for "verification" — verify by screenshot + vision.
  [/\b(playwright|puppeteer|selenium)\b/i, 'Browser automation is banned. Verify the NATIVE app by SCREENSHOT + your own vision (docs/GUI.md, BUILD.md Phase 6).'],
];

for (const [re, msg] of BANS) {
  if (re.test(cmd)) {
    process.stderr.write(
      `\n⛔ BLOCKED by .claude/hooks/guard.mjs\n${msg}\n` +
      `If you hit this, you drifted from the spec — comply, do NOT work around it.\n` +
      `Command was: ${cmd}\n`,
    );
    process.exit(2); // hard block
  }
}
process.exit(0);
