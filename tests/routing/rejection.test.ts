import { describe, expect, it } from 'vitest';
import { activeRejections, findRejection, parseRejections, withRejection } from '../../src/routing/rejection.js';

// What each agent CLI printed when launched with a model it lacks (Orca terminals and print mode, Nov 2026).
const SEEN = {
  codex: ['■ The \'claude-opus-5-5\' model is not supported when using Codex with a ChatGPT account.', 'claude-opus-5-5'],
  codexExec: ['ERROR: The \'claude-opus-5-5\' model is not supported when using Codex with a ChatGPT account.', 'claude-opus-5-5'],
  claude: ['● There\'s an issue with the selected model (gpt-6-terra). It may not exist or you may not have access to it. Run', 'gpt-6-terra'],
  cursor: ['Cannot use this model: claude-opus-9-9. Available models: auto, gpt-5.3-codex-low, gpt-5.3-codex', 'claude-opus-9-9'],
  grok: ['Error: Couldn\'t set model \'grok-9-fake\': Invalid params: "unknown model id". Run \'grok models\' to see available models.', 'grok-9-fake'],
  agy: ['Error: invalid model selection (--model "gemini-9-fake" --effort ""): model gemini-9-fake is not recognized as a known model or custom model in settings', 'gemini-9-fake'],
  // Pi 1.5.0's resolver error for an unknown --model (synthetic id).
  pi: ['Error: Model "anthropic/claude-opus-9-9" not found. Use --list-models to see available models.', 'anthropic/claude-opus-9-9'],
} as const;

describe('findRejection', () => {
  it('recognizes every agent\'s refusal and trims its decoration', () => {
    expect(findRejection(SEEN.codex[1], ['prompt', SEEN.codex[0], '› Ask Codex to do anything']))
      .toBe('The \'claude-opus-5-5\' model is not supported when using Codex with a ChatGPT account.');
    expect(findRejection(SEEN.codexExec[1], [SEEN.codexExec[0]])).toMatch(/^The 'claude-opus-5-5' model/);
    expect(findRejection(SEEN.claude[1], [SEEN.claude[0], '  /model to pick a different model.']))
      .toMatch(/^There's an issue with the selected model \(gpt-6-terra\)/);
    expect(findRejection(SEEN.cursor[1], [SEEN.cursor[0]])).toBe('Cannot use this model: claude-opus-9-9.');
    expect(findRejection(SEEN.grok[1], [SEEN.grok[0]])).toMatch(/^Couldn't set model 'grok-9-fake'/);
    expect(findRejection(SEEN.agy[1], [SEEN.agy[0]])).toMatch(/^invalid model selection/);
    expect(findRejection('openrouter/fake/nonexistent-9', ['Error: Model unavailable: openrouter/fake/nonexistent-9']))
      .toBe('Model unavailable: openrouter/fake/nonexistent-9');
    expect(findRejection(SEEN.pi[1], [SEEN.pi[0]])).toBe('Model "anthropic/claude-opus-9-9" not found. Use --list-models to see available models.');
  });

  it('needs the line to name the routed model', () => {
    expect(findRejection('gpt-6-luna', [SEEN.codex[0]])).toBeUndefined();
    expect(findRejection('claude-opus-5-5', ['the model is not supported here'])).toBeUndefined();
  });

  it('ignores the agents\' warnings about models they do not know but still run', () => {
    expect(findRejection('claude-opus-5-5', ['warning: Model metadata for `claude-opus-5-5` not found. Defaulting to fallback metadata'])).toBeUndefined();
    expect(findRejection('gpt-6-terra', ['Claude Code doesn\'t recognize the model "gpt-6-terra", so it assumes a context window of 200k tokens.'])).toBeUndefined();
    // Pi keeps running with an unknown id of a known provider; the API reports any failure later.
    expect(findRejection('anthropic/claude-opus-9-9', ['Warning: Model "anthropic/claude-opus-9-9" not found for provider "anthropic". Using custom model id.'])).toBeUndefined();
    expect(findRejection('claude-opus-9-9', ['Model "claude-opus-9-9" not found'])).toBeUndefined();
  });

  it('finds a refusal whose model id wrapped onto the next row', () => {
    expect(findRejection('claude-opus-9-9', ['Cannot use this model: claude-op', 'us-9-9. Available models: auto'])).toBe('Cannot use this model: claude-opus-9-9.');
  });
});

describe('saved rejections', () => {
  const r = { agent: 'codex', model: 'claude-opus-5-5', message: 'not supported', at: 1_000_000 };

  it('keep only entries younger than the TTL', () => {
    expect(activeRejections([r], r.at + 23 * 3_600_000, 24)).toEqual([r]);
    expect(activeRejections([r], r.at + 24 * 3_600_000, 24)).toEqual([]);
  });

  it('parse tolerantly and replace an older entry for the same agent and model', () => {
    expect(parseRejections(undefined)).toEqual([]);
    expect(parseRejections('{bad')).toEqual([]);
    expect(parseRejections(JSON.stringify({ rejections: [r, { agent: 'x' }, null] }))).toEqual([r]);
    const newer = { ...r, at: r.at + 1, message: 'again' };
    expect(withRejection([r, { ...r, agent: 'cursor' }], newer)).toEqual([{ ...r, agent: 'cursor' }, newer]);
  });
});
