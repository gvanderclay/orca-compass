import type { AgentId } from '../types.js';

/** An agent refused a model at launch (unknown id, or not on this account), so routing skips it for a while. */
export interface Rejection {
  agent: AgentId;
  model: string;
  /** The agent's own words, trimmed. */
  message: string;
  /** When it was seen, epoch ms. */
  at: number;
}

// Each agent CLI's words for "cannot use this model", as printed when launched with a model it lacks:
//   codex        The 'claude-opus-5-5' model is not supported when using Codex with a ChatGPT account.
//   claude       There's an issue with the selected model (gpt-6-terra). It may not exist or you may not have access to it.
//   cursor       Cannot use this model: claude-opus-9-9. Available models: auto, ...
//   grok         Couldn't set model 'grok-9-fake': Invalid params: "unknown model id".
//   antigravity  invalid model selection (--model "gemini-9-fake" ...): model gemini-9-fake is not recognized as a known model ...
//   opencode     Error: Model unavailable: openrouter/fake/nonexistent-9
const REFUSAL =
  /model is not supported|issue with the selected model|cannot use this model|couldn'?t set model|unknown model id|invalid model selection|not recognized as a known model|model unavailable/i;

/**
 * The agent's line refusing `model`, if the output has one. The line must name the model, so a worker's
 * own output about other models never counts. Long lines wrap, so each line is also tried joined with the next.
 */
export function findRejection(model: string, lines: readonly string[]): string | undefined {
  const id = model.toLowerCase();
  const rows = lines.map((l) => l.trim());
  const refuses = (text: string) => text.toLowerCase().includes(id) && REFUSAL.test(text);
  const single = rows.find(refuses);
  if (single) return clean(single);
  for (let i = 0; i + 1 < rows.length; i++) {
    for (const text of [`${rows[i]}${rows[i + 1]}`, `${rows[i]} ${rows[i + 1]}`]) if (refuses(text)) return clean(text);
  }
  return undefined;
}

/** Drops the agent's decoration ("■ ", "ERROR: "), Cursor's list of available models and a sentence cut off by wrapping. */
function clean(line: string): string {
  const text = line
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/^(error|warning):\s*/i, '')
    .split(/\s*Available models:/i)[0]
    .trim()
    .replace(/([.!?]["')\]]?)\s+[^.!?]*$/, '$1');
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

/** Rejections seen less than `ttlHours` ago. */
export function activeRejections(list: readonly Rejection[], now: number, ttlHours: number): Rejection[] {
  return list.filter((r) => now - r.at < ttlHours * 3_600_000);
}

/** Parses the saved rejections file, dropping malformed entries; empty when missing or invalid. */
export function parseRejections(text: string | undefined): Rejection[] {
  let data: unknown;
  try {
    data = text === undefined ? undefined : JSON.parse(text);
  } catch {
    return [];
  }
  const list = (data as { rejections?: unknown } | undefined)?.rejections;
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is Rejection =>
    typeof r?.agent === 'string' && typeof r?.model === 'string' && typeof r?.message === 'string' && Number.isFinite(r?.at));
}

/** The list with `r` added, replacing an older entry for the same agent and model. */
export function withRejection(list: readonly Rejection[], r: Rejection): Rejection[] {
  return [...list.filter((x) => x.agent !== r.agent || x.model !== r.model), r];
}
