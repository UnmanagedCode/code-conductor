// Render test for the #costs dashboard (public/costs.js).
//
// Ollama-backed models expose no summable per-turn token total, so the server
// marks their by_model entries `tokens_known:false`. The dashboard must render
// the four token columns as an em-dash `—` for such models (honest
// "unavailable"), NOT a fabricated 0 — while Anthropic models (tokens_known:
// true) still render formatted numbers. Turns/cost columns are unaffected.
//
// Same happy-dom harness style as tests/header-usage-popover.test.mjs; drives
// the exported render(data) directly against a mounted #costs-body.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';

async function setup() {
  const window = new Window({ url: 'http://localhost/' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Element = window.Element;
  globalThis.Node = window.Node;
  const body = window.document.createElement('div');
  body.id = 'costs-body';
  window.document.body.appendChild(body);
  return window.document;
}

test('costs dashboard: ollama token cells render em-dash, claude renders numbers', async () => {
  const document = await setup();
  const { render } = await import('../public/costs.js');

  const claudeModel = {
    model: 'claude-opus-4-8', cost_usd: 0.05, input_tokens: 1200, output_tokens: 300,
    cache_creation_tokens: 10, cache_read_tokens: 2000, turns: 2, sessions: 1,
    cache_misses: 0, duration_ms: 100, duration_api_ms: 80, tokens_known: true,
  };
  const ollamaModel = {
    model: 'llama3:8b', cost_usd: 0, input_tokens: 0, output_tokens: 0,
    cache_creation_tokens: 0, cache_read_tokens: 0, turns: 3, sessions: 1,
    cache_misses: 0, duration_ms: 50, duration_api_ms: 40, tokens_known: false,
  };

  render({
    total_usd: 0.05,
    row_count: 5,
    by_project: [{
      project: 'p', cost_usd: 0.05, duration_ms: 150, duration_api_ms: 120, turns: 5,
      cache_misses: 0, sessions: 2, tokens_known: true, by_model: [claudeModel, ollamaModel],
    }],
    by_model: [claudeModel, ollamaModel],
    daily_trend: [],
  });

  // The standalone "By model" table is the last .costs-table in document order
  // (project table, then its nested detail table, then the standalone one).
  const tables = document.querySelectorAll('table.costs-table');
  const byModel = tables[tables.length - 1];
  const cellsByModel = {};
  for (const tr of byModel.querySelectorAll('tbody tr')) {
    const tds = [...tr.querySelectorAll('td')].map(td => td.textContent);
    cellsByModel[tds[0]] = tds;
  }

  // Columns: [Model, Cost, Input, Output, Cache create, Cache read, Turns, ...]
  const claude = cellsByModel['claude-opus-4-8'];
  assert.equal(claude[2], '1.2k', 'claude input tokens formatted');
  assert.equal(claude[3], '300', 'claude output tokens formatted');
  assert.equal(claude[5], '2.0k', 'claude cache-read tokens formatted');

  const ollama = cellsByModel['llama3:8b'];
  assert.equal(ollama[2], '—', 'ollama input tokens unavailable');
  assert.equal(ollama[3], '—', 'ollama output tokens unavailable');
  assert.equal(ollama[4], '—', 'ollama cache-create tokens unavailable');
  assert.equal(ollama[5], '—', 'ollama cache-read tokens unavailable');
  assert.equal(ollama[6], '3', 'turns still shown for ollama');
});
