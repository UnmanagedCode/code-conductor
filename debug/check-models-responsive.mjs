// Settings → Models responsive check: screenshots + geometry assertions at a
// fixed width sweep, run against a sandboxed scratch orchestrator.
//
//   node debug/check-models-responsive.mjs [--out DIR]   # default DIR: debug/screenshots
//
// Writes models-<width>.png per width and exits non-zero if any assertion fails.
// This is the reproducible form of the numbers quoted when the phone layout was
// fixed — re-run it on a clean checkout to re-measure. It lives here rather than
// in tests/ because it needs Chromium via the sibling code-playwright harness,
// which the gated `npm test` suite deliberately has no dependency on; the
// DOM-contract half of the same fix is covered deterministically by
// tests/settings-models-field-labels.test.mjs.
//
// The sweep straddles the 720px breakpoint on purpose: 719 is the widest the
// restacked card layout ever renders, 721 the narrowest the six-column grid
// does, so a discontinuity at the seam fails here rather than on someone's
// tablet.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPage } from '../../code-playwright/browser.mjs';
import { bootOrch } from './boot-orch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NARROW = [320, 360, 390, 719];
const WIDE = [721, 1024, 1280];
const WIDTHS = [...NARROW, ...WIDE];
const TAP_MIN = 44;        // the stylesheet's own floor (#review-header, .commit-row, …)
const SELECT_MIN_W = 100;  // a select narrower than this can't show a model name
const EPS = 0.5;

const args = process.argv.slice(2);
const outDir = (() => {
  const i = args.indexOf('--out');
  return i >= 0 ? path.resolve(args[i + 1]) : path.join(__dirname, 'screenshots');
})();

// Worst-case content, seeded through the real REST surface. The layout's failure
// mode is content-driven and `min-width: 0` only helps if nothing forces a wider
// min-content, so both of these are single unbreakable tokens: a 40-char custom
// role name (CUSTOM_ROLE_MAX, ^[A-Za-z][A-Za-z0-9-]*$ — user-supplied, no shorter
// bound to rely on) and a long model id bound to a tier.
const LONG_ROLE = 'Extremely-Long-Custom-Role-Name-For-Test';
const LONG_MODEL = 'qwen3-coder-480b-a35b-instruct-fp8:cloud-preview-20260101';
const LONG_LABEL = 'MyVeryLongLocalModelLabelForLayoutTesting';

async function seed(url) {
  const post = async (p, body) => {
    const r = await fetch(url + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${p} → ${r.status} ${JSON.stringify(await r.json())}`);
    return r.json();
  };
  // `ollama` is the built-in substitution backend, so no backend row to add.
  await post('/api/settings/models/custom', {
    label: LONG_LABEL, model: LONG_MODEL, backend: 'ollama', contextWindow: 256000,
  });
  await post('/api/settings/models/prefs', {
    tierBackend: { tier: 'frontier', backend: { backend: 'ollama', model: LONG_MODEL } },
  });
  await post('/api/settings/models/roles', { role: LONG_ROLE });
  // Put the long role on a Custom binding so its row renders the full field set
  // (name + binds-to + backend + model + effort + remove) — the widest role row.
  await post('/api/settings/models/prefs', {
    roleBackend: { role: LONG_ROLE, backend: { backend: 'ollama', model: LONG_MODEL } },
  });
}

// Everything below runs in the page. Returns raw measurements + failures; the
// node side only formats.
function measure({ TAP_MIN, SELECT_MIN_W, EPS, narrow }) {
  const fails = [];
  const known = [];
  const fail = (check, msg) => fails.push({ check, msg });
  const de = document.documentElement;
  const rect = (el) => el.getBoundingClientRect();
  const round = (n) => Math.round(n * 10) / 10;
  const name = (el) => {
    const cls = (el.className || '').toString().trim().split(/\s+/)[0];
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
  };
  const panel = document.getElementById('settings-models');
  const content = document.querySelector('.settings-content');
  const rows = [
    ...document.querySelectorAll('#sm-tier-list .sm-family-row'),
    ...document.querySelectorAll('#sm-role-list .sm-role-row'),
  ];
  const rowName = (li) =>
    (li.querySelector('.sm-family-label')?.textContent || '?').slice(0, 24);

  // 1. Whole-page overflow.
  if (de.scrollWidth > de.clientWidth) {
    fail('doc-overflow', `documentElement scrollWidth ${de.scrollWidth} > clientWidth ${de.clientWidth}`);
  }

  // The WIDE role row is a pre-existing no-wrap flex that this check does not own:
  // with a max-length custom role name its min-content is ~686px, so it overflows
  // whenever the content column is narrower than that — which at 721px it is (the
  // sidebar is back, leaving 441px). Measured identical on `main`, so it is not a
  // seam discontinuity introduced here; fixing it means changing the wide role row,
  // which is out of scope. Recorded loudly rather than silently skipped, and only
  // above the breakpoint — below it, the restacked role row IS owned and asserted.
  const exempt = (el) => !narrow && el.closest('#sm-role-list') !== null;
  if (!narrow) {
    const over = Math.max(0, ...[...document.querySelectorAll('#sm-role-list .sm-role-row')].map(li =>
      Math.max(0, ...[...li.children].map(k => rect(k).right)) - rect(li).right));
    known.push(over > EPS
      ? `wide role row overflows its own box by ${round(over)}px (content column ${content.clientWidth}px)` +
        ` — pre-existing no-wrap flex, not asserted above the breakpoint`
      : `wide role row fits (no overflow) — not asserted above the breakpoint either way`);
    // The six-column grid FITS at 721px but its `1fr` model column is squeezed to
    // a stub, so "no overflow" alone would read as "fine" when it isn't. Recorded
    // for every wide width: pre-existing (identical on `main`), and raising the
    // breakpoint to cover it would mean a second breakpoint value, which is a
    // scope decision rather than part of the phone fix.
    // Only the `1fr` model column is measured: the backend (88px) and effort (76px)
    // columns are fixed by design and their option text fits.
    const models = [...document.querySelectorAll('#sm-tier-list select.sm-version')].map(s => rect(s).width);
    if (models.length) {
      const min = round(Math.min(...models));
      known.push(`narrowest tier-grid model select ${min}px` +
        (min < SELECT_MIN_W ? ` — below the ${SELECT_MIN_W}px readable floor; the wide grid's 1fr column squeezed at this width (pre-existing)` : ' — readable'));
    }
  }

  // 2. The scrolling container. `.settings-content` is `overflow-y: auto`, which
  //    computes to `auto` on both axes — it clips and scrolls sideways rather
  //    than pushing the document out, so check #1 alone cannot see this.
  //    Above the breakpoint, measure the tier list alone (see `exempt`): 721px is
  //    the narrowest the six-column grid ever renders and its ~420px min-content
  //    has to actually fit there.
  const scrollW = narrow
    ? content.scrollWidth
    : Math.ceil(Math.max(0, ...[...document.querySelectorAll('#sm-tier-list .sm-family-row')]
        .flatMap(li => [...li.children].map(k => rect(k).right)))) - Math.floor(rect(content).left);
  if (scrollW > content.clientWidth + 1) {
    fail('container-overflow', `${narrow ? '.settings-content' : '#sm-tier-list'} scrollWidth ${scrollW} > .settings-content clientWidth ${content.clientWidth}`);
  }

  // 3. Containment: nothing in the panel may stick out of the panel box. Catches
  //    a control clipped away even when an ancestor hides the overflow.
  const pr = rect(panel);
  for (const el of panel.querySelectorAll('*')) {
    if (el.offsetParent === null && el.getClientRects().length === 0) continue; // hidden
    if (exempt(el)) continue;
    const r = rect(el);
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > pr.right + EPS || r.left < pr.left - EPS) {
      fail('containment', `${name(el)} [${round(r.left)}..${round(r.right)}] escapes #settings-models [${round(pr.left)}..${round(pr.right)}]`);
    }
  }

  // 4/5/6, per row.
  const measured = [];
  for (const li of rows) {
    const r = rect(li);
    const kids = [...li.children];
    const controls = [...li.querySelectorAll('select, button, input')];
    measured.push({ row: rowName(li), h: round(r.height), w: round(r.width) });

    // 4. Non-collapse: a select starved to a stub is unreadable, not merely ugly.
    //    The width floor is narrow-only — the wide grid's backend (88px) and
    //    effort (76px) columns are deliberately narrower than this, and that
    //    layout is not what is being changed.
    for (const c of li.querySelectorAll('select')) {
      const cr = rect(c);
      if (narrow && cr.width < SELECT_MIN_W) {
        fail('collapsed-select', `${rowName(li)}: ${name(c)} width ${round(cr.width)} < ${SELECT_MIN_W}`);
      }
      if (cr.width <= 0 || cr.height <= 0) {
        fail('collapsed-select', `${rowName(li)}: ${name(c)} is ${round(cr.width)}x${round(cr.height)}`);
      }
    }

    // 5. Tap targets, narrow only. A select/button measures itself; the two bare
    //    boxes (enable checkbox, default radio) measure their `.sm-field` wrapper.
    if (narrow) {
      const targets = [
        ...li.querySelectorAll('select, button'),
        ...li.querySelectorAll('.sm-field--enable, .sm-field--default'),
      ];
      for (const t of targets) {
        const h = rect(t).height;
        if (h < TAP_MIN - EPS) {
          fail('tap-target', `${rowName(li)}: ${name(t)} height ${round(h)} < ${TAP_MIN}`);
        }
      }
    }

    // 6. No overlap between a row's own children (a stacked row with a fixed
    //    height would collide here).
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = rect(kids[i]), b = rect(kids[j]);
        if (a.width === 0 || b.width === 0) continue;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > EPS && oy > EPS) {
          fail('overlap', `${rowName(li)}: ${name(kids[i])} overlaps ${name(kids[j])} by ${round(ox)}x${round(oy)}`);
        }
      }
    }

    // 7. Every control names what it configures. Two independent requirements:
    //    an aria-label (the accessible name, which the removed column header used
    //    to stand in for), and — for the selects — a visible `.sm-field-cap` in
    //    the enclosing label, which is what a sighted phone user reads. A caption
    //    deleted, emptied, or left `display: none` at narrow width fails here.
    for (const c of controls) {
      const aria = (c.getAttribute('aria-label') || '').trim();
      if (!aria) fail('no-accessible-name', `${rowName(li)}: ${name(c)} has no aria-label`);
    }
    for (const c of li.querySelectorAll('select')) {
      const cap = c.closest('label')?.querySelector('.sm-field-cap');
      const text = (cap?.textContent || '').trim();
      if (!text) {
        fail('no-visible-caption', `${rowName(li)}: ${name(c)} has no captioned label.sm-field ancestor`);
      } else if (narrow && (getComputedStyle(cap).display === 'none' || rect(cap).width === 0)) {
        fail('no-visible-caption', `${rowName(li)}: caption '${text}' is not visible at this width`);
      }
    }

    // 8. Wide layout: the row must still be ONE line, and the mobile rules must
    //    not have leaked up here.
    if (!narrow) {
      const mid = r.top + r.height / 2;
      for (const k of kids) {
        const kr = rect(k);
        if (kr.width === 0 && kr.height === 0) continue;
        if (kr.top > mid || kr.bottom < mid) {
          fail('wide-stacked', `${rowName(li)}: ${name(k)} [${round(kr.top)}..${round(kr.bottom)}] misses the row centre ${round(mid)} — the row has stacked`);
        }
      }
      if (r.height > 60) fail('wide-stacked', `${rowName(li)}: row height ${round(r.height)} > 60`);
      for (const c of li.querySelectorAll('select, button')) {
        if (rect(c).height >= TAP_MIN) {
          fail('mobile-rule-leaked', `${rowName(li)}: ${name(c)} height ${round(rect(c).height)} >= ${TAP_MIN} — the mobile tap-target rule applies at this width`);
        }
      }
      for (const cap of li.querySelectorAll('.sm-field-cap')) {
        const d = getComputedStyle(cap).display;
        if (d !== 'none') fail('mobile-rule-leaked', `${rowName(li)}: .sm-field-cap display is '${d}', expected none`);
      }
    }
  }

  if (rows.length === 0) fail('no-rows', 'no tier or role rows rendered — the fixture did not load');

  return {
    doc: { sw: de.scrollWidth, cw: de.clientWidth },
    content: { sw: content.scrollWidth, cw: content.clientWidth },
    rows: measured,
    fails,
    known,
  };
}

fs.mkdirSync(outDir, { recursive: true });

const orch = await bootOrch({ sandbox: true, silent: true });
let bad = 0;
try {
  console.log(`[boot] ${orch.url}`);
  await seed(orch.url);
  console.log(`[seed] custom model '${LONG_MODEL}' on frontier; custom role '${LONG_ROLE}' on a Custom binding`);

  for (const width of WIDTHS) {
    const narrow = NARROW.includes(width);
    await withPage(async (page) => {
      await page.goto(orch.url + '#settings', { waitUntil: 'networkidle' });
      await page.selectOption('#settings-group-select', 'models');
      await page.waitForSelector(`#sm-role-list .sm-role-row .sm-field--model select`);
      const out = path.join(outDir, `models-${width}.png`);
      await page.screenshot({ path: out, fullPage: true });
      const m = await page.evaluate(measure, { TAP_MIN, SELECT_MIN_W, EPS, narrow });

      const tag = narrow ? 'narrow' : 'wide  ';
      const rowH = [...new Set(m.rows.map(r => r.h))].join('/');
      console.log(
        `${String(width).padStart(4)}px ${tag}  doc ${m.doc.sw}/${m.doc.cw}` +
        `  .settings-content ${m.content.sw}/${m.content.cw}` +
        `  rowH ${rowH}  ${m.fails.length ? `FAIL x${m.fails.length}` : 'ok'}  → ${out}`,
      );
      for (const k of m.known) console.log(`        [known] ${k}`);
      for (const f of m.fails) console.log(`        [${f.check}] ${f.msg}`);
      bad += m.fails.length;
    }, { viewport: { width, height: 900 } });
  }
} finally {
  await orch.close();
}

console.log(bad ? `\n${bad} assertion failure(s)` : '\nall widths pass');
process.exit(bad ? 1 : 0);
