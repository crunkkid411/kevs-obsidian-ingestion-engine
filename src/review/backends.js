/**
 * Context-review agent backends. ONE call per media file (the orchestrator
 * enforces concurrency). Each backend takes a system prompt (your case context)
 * + a user prompt (this video's transcript + data points) and returns the raw
 * model text, which the stage parses as JSON.
 *
 *   claude-code : your LOCAL Claude Code instance, headless. The sensitive case
 *                 context and transcripts never leave the machine. Uses the
 *                 `claude -p` print mode with --append-system-prompt + --model.
 *   openrouter  : an API model (use only because nothing in THIS project is
 *                 confidential — good for testing which model is best at nuance).
 *   mock        : returns a canned empty result; for pipeline testing offline.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

/** Local Claude Code, headless. System prompt carries the (sensitive) case context. */
async function claudeCode(system, user, model) {
  const bin = process.env.CLAUDE_BIN || 'claude';
  // -p / --print: non-interactive. --append-system-prompt injects the case
  // context. --output-format json wraps the reply with metadata; we read .result.
  const args = ['-p', user, '--append-system-prompt', system, '--model', model, '--output-format', 'json'];
  const { stdout } = await execFileAsync(bin, args, { maxBuffer: 50 * 1024 * 1024, timeout: 1_800_000 });
  try {
    const env = JSON.parse(stdout);
    return env.result ?? env.text ?? stdout;   // tolerate format differences
  } catch {
    return stdout; // plain text mode
  }
}

/** OpenRouter chat completions (testing API models; not for sensitive context). */
async function openrouter(system, user, model) {
  const key = config.api.openrouterKey;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');
  const res = await fetch(`${config.api.openrouterBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.2,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function mock(system, user) {
  // Dev/offline backend: emits one representative annotation so the store path
  // and GUI can be exercised without a real model. Looks for an "ex" mention.
  const m = /(my ex|the ex|it'?s been .* months)/i.exec(user);
  const anns = m ? [{
    kind: 'reference_resolution', start_sec: 0, end_sec: 0, surface_text: m[0],
    linked_entity: 'The Wife', note: '(mock) oblique reference appears to point to the wife',
    rationale: '(mock) timeline + alias heuristic', confidence: 0.55,
  }] : [];
  return JSON.stringify({ summary: '(mock) representative review output', annotations: anns, overall_significance: anns.length ? 'medium' : 'none' });
}

/** Dispatch to the configured backend. Returns raw model text. */
export async function runReviewAgent({ backend, model, system, user }) {
  switch (backend) {
    case 'claude-code': return claudeCode(system, user, model);
    case 'openrouter': return openrouter(system, user, model);
    case 'mock': return mock(system, user);
    case 'none': return null;
    default: throw new Error(`unknown review backend: ${backend}`);
  }
}
