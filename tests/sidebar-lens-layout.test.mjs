// The lens, selection and control-height rules, run through the real
// public/index.html + public/styles.css cascade. happy-dom computes no layout,
// so these assert computed styles; rendered geometry is the headless pass's
// (harness/playwright/check-sidebar-lenses.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Window } from 'happy-dom';
import { PUB } from './sidebar-fixture.mjs';

// `lens` is baked into the markup before the stylesheet loads: happy-dom's
// computed-style cache does not see a later data-lens change.
async function renderIndex({ lens = 'missions' } = {}) {
  const [html, css] = await Promise.all([
    fs.readFile(path.join(PUB, 'index.html'), 'utf8'),
    fs.readFile(path.join(PUB, 'styles.css'), 'utf8'),
  ]);
  const window = new Window({
    url: 'http://localhost/',
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  const document = window.document;
  document.write(html.replace(/<script\b[\s\S]*?<\/script>/g, '')
    .replace('<aside id="sidebar" data-lens="missions">', `<aside id="sidebar" data-lens="${lens}">`));
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  return { window, document, css };
}

const cs = (window, el) => window.getComputedStyle(el);

// happy-dom neither computes nor serialises a border shorthand containing
// var(), so such a rule is read from the stylesheet text.
function ruleBody(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([\\s\\S]*?)\\}`))?.[1];
  assert.ok(body != null, `styles.css has a rule for ${selector}`);
  return body;
}

// A session row placed inside the real #project-list, so the real cascade
// reaches it.
function sessionRow(document, classes) {
  const ul = document.createElement('ul');
  ul.className = 'sessions-list';
  ul.innerHTML = `<li><div class="${classes}"><span class="dot idle"></span><span class="session-ago">1m ago</span><span class="session-preview">x</span></div></li>`;
  document.getElementById('project-list').appendChild(ul);
  return ul.querySelector('.session-row');
}

test('under data-lens=missions the Projects-only row and list compute display:none and #mission-list does not; under projects, the reverse', async () => {
  const shown = async (lens) => {
    const { window, document } = await renderIndex({ lens });
    const d = (el) => cs(window, el).display;
    return {
      row: d(document.querySelector('.projects-lens-row')),
      projects: d(document.getElementById('project-list')),
      missions: d(document.getElementById('mission-list')),
    };
  };
  const m = await shown('missions');
  assert.equal(m.row, 'none', 'the lens rule outranks .projects-lens-row\'s own display:flex');
  assert.equal(m.projects, 'none');
  assert.notEqual(m.missions, 'none');
  const p = await shown('projects');
  assert.equal(p.row, 'flex');
  assert.notEqual(p.projects, 'none');
  assert.equal(p.missions, 'none');
});

test('.session-row.active: panel-2 background, a 1px solid muted outline at -1px offset, and no accent border-left', async () => {
  const { window, document } = await renderIndex({ lens: 'projects' });
  const row = sessionRow(document, 'session-row active live has-unread');
  const s = cs(window, row);
  assert.match(s.backgroundColor + s.background, /var\(--panel-2\)|#1d2130|rgb\(29, 33, 48\)/);
  assert.equal(s.outlineStyle, 'solid');
  assert.equal(s.outlineWidth, '1px');
  assert.match(s.outlineColor, /var\(--muted\)|#8a90a3|rgb\(138, 144, 163\)/);
  assert.equal(s.outlineOffset, '-1px');
  assert.ok(['', '0px', 'none'].includes(s.borderLeftStyle) || s.borderLeftWidth === '0px' || s.borderLeftWidth === '',
    `no left border on a plain active row (got ${s.borderLeftWidth} ${s.borderLeftStyle})`);
  assert.equal(cs(window, row.querySelector('.session-preview')).fontWeight, '700', 'the selected label is bold, over the live and unread weights');
});

test('an owned active row keeps its 3px owner border-left under the outline', async () => {
  const { window, document, css } = await renderIndex({ lens: 'projects' });
  const row = sessionRow(document, 'session-row active owned');
  row.style.setProperty('--owner-color', 'hsl(30 70% 64%)');
  const s = cs(window, row);
  assert.match(ruleBody(css, '.session-row.owned'), /border-left:\s*3px solid var\(--owner-color\)/);
  assert.doesNotMatch(ruleBody(css, '.session-row.active, .mission-row.active'), /border|padding/,
    'the selected rule sets no border or padding, so it cannot override the owner bar');
  assert.equal(s.paddingLeft, '3px', 'the padding gives the bar\'s width back');
  assert.equal(s.outlineStyle, 'solid', 'and the selection outline is still drawn');
});

test('the filter select and #sidebar-overflow-toggle resolve the same height', async () => {
  const { window, document } = await renderIndex({ lens: 'projects' });
  const select = document.getElementById('conductor-filter-select');
  const toggle = document.getElementById('sidebar-overflow-toggle');
  const hs = cs(window, select).height;
  const ht = cs(window, toggle).height;
  assert.ok(hs && hs !== 'auto', `the select has an explicit height (got ${JSON.stringify(hs)})`);
  assert.equal(hs, ht);
  assert.equal(cs(window, select).boxSizing, 'border-box');
  assert.equal(cs(window, toggle).boxSizing, 'border-box');
});
