// Settings → Models responsive check: screenshots + geometry assertions at a
// fixed width sweep, run against a sandboxed scratch orchestrator.
//
//   node debug/check-models-responsive.mjs [--out DIR]   # default DIR: debug/screenshots
//   FORCE_SCROLLBAR_GUTTER=1 node debug/check-models-responsive.mjs
//     Makes the content column reserve a classic scrollbar gutter (this Chromium's
//     scrollbars are overlay/zero-width). Exercises `capture-perturbed-layout`,
//     which compares the column width before and after the screenshot unclip.
//
// Writes models-<width>.png per width and exits non-zero if any assertion fails.
// This is the reproducible form of the numbers quoted when the phone layout was
// fixed — re-run it on a clean checkout to re-measure. It lives here rather than
// in tests/ because it needs Chromium via the sibling code-playwright harness,
// which the gated `npm test` suite deliberately has no dependency on; the
// DOM-contract half of the same fix is covered deterministically by
// tests/settings-models-field-labels.test.mjs.
//
// The sweep straddles the 850px breakpoint on purpose: 849 is the widest the
// restacked card layout ever renders, 851 the narrowest the six-column grid
// does, so a discontinuity at the seam fails here rather than on someone's
// tablet. 719/721 stay in the narrow list too — both are inside the card range
// now, and 721 is the width where boxing the tier list in a fieldset pushed the
// grid's tracks past their row.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPage } from '../../code-playwright/browser.mjs';
import { bootOrch } from './boot-orch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 849/851 straddle the breakpoint; 719/721 are kept because they are real widths
// that used to straddle it and 721 is where the fieldset regression lived — the
// seam moving must not silently drop the spot the bug stood on.
const NARROW = [320, 360, 390, 719, 721, 849];
const WIDE = [851, 1024, 1280];
const WIDTHS = [...NARROW, ...WIDE];
const TAP_MIN = 44;        // the stylesheet's own floor (#review-header, .commit-row, …)
const SELECT_MIN_W = 100;  // a select narrower than this can't show a model name
const EPS = 0.5;

const FORCE_GUTTER = process.env.FORCE_SCROLLBAR_GUTTER === '1';
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

  // A `display: contents` element generates no box at all, so
  // getBoundingClientRect() returns zeros for it — which means `li.children` is
  // NOT a row's list of laid-out boxes. Above the breakpoint every control sits
  // inside a `display: contents` `label.sm-field` wrapper, so iterating
  // `li.children` there would silently measure the wrappers (all zero) and skip
  // every select, checkbox and radio the geometry loops exist to pin. Flatten
  // through contents-display children and drop `display: none` ones instead.
  const boxesOf = (el) => [...el.children].flatMap((c) => {
    const d = getComputedStyle(c).display;
    if (d === 'contents') return boxesOf(c);
    if (d === 'none') return [];
    return [c];
  });

  // 1. Whole-page overflow.
  if (de.scrollWidth > de.clientWidth) {
    fail('doc-overflow', `documentElement scrollWidth ${de.scrollWidth} > clientWidth ${de.clientWidth}`);
  }

  // 1b. The tier list is boxed in a `fieldset.sm-group` like Roles and Custom
  //     models are. Structural, at every width — the box is not a mobile
  //     affordance, and its 30px of padding + border is what sets the breakpoint
  //     below, so losing it silently would leave that value unexplained.
  if (!document.querySelector('#sm-tier-list')?.closest('fieldset.sm-tiers')) {
    fail('no-tier-fieldset', '#sm-tier-list is not inside a fieldset.sm-tiers — the tier group box is gone');
  }

  // 1c. Grid tracks must fit the box they are laid out in. `grid-template-columns`
  //     resolves to used px, and a grid whose tracks exceed its content box does
  //     NOT shrink them — it overflows, and only whichever item happens to reach
  //     its track's right edge shows it. That is why this needs its own check: the
  //     fieldset regression overflowed the header and all four tier rows by the
  //     same ~27px, but the rows' last item is a centre-justified radio, so only
  //     the header's last `.sm-col-header` span stuck out far enough for the
  //     containment check (#3) to notice. This catches it at the source instead.
  for (const el of [
    document.querySelector('.sm-family-header'),
    ...document.querySelectorAll('#sm-tier-list .sm-family-row'),
  ]) {
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const tracks = cs.gridTemplateColumns.split(/\s+/).map(parseFloat).filter(n => !Number.isNaN(n));
    if (tracks.length < 2) continue;
    const gap = parseFloat(cs.columnGap) || 0;
    const need = tracks.reduce((a, b) => a + b, 0) + gap * (tracks.length - 1);
    const have = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (need > have + EPS) {
      fail('grid-tracks-fit', `${name(el)}: ${tracks.length} tracks + gaps need ${round(need)}px but the content box is ${round(have)}px (over by ${round(need - have)})`);
    }
  }

  // The WIDE role row is a pre-existing no-wrap flex that this check does not own:
  // with a max-length custom role name its min-content is ~686px, so it overflows
  // whenever the content column is narrower than that — which at 851px it is (the
  // sidebar is back, leaving 561px). Measured identical on `main`, so it is not a
  // seam discontinuity introduced here; fixing it means changing the wide role row,
  // and it would take a ~1030px breakpoint, which would restack 1024px desktop.
  // Recorded loudly rather than silently skipped, and only above the breakpoint —
  // below it, the restacked role row IS owned and asserted.
  const exempt = (el) => !narrow && el.closest('#sm-role-list') !== null;
  if (!narrow) {
    const over = Math.max(0, ...[...document.querySelectorAll('#sm-role-list .sm-role-row')].map(li =>
      Math.max(0, ...boxesOf(li).map(k => rect(k).right)) - rect(li).right));
    known.push(over > EPS
      ? `wide role row overflows its own box by ${round(over)}px (content column ${content.clientWidth}px)` +
        ` — pre-existing no-wrap flex, not asserted above the breakpoint`
      : `wide role row fits (no overflow) — not asserted above the breakpoint either way`);
    // 4b. The `1fr` model column, ASSERTED above the breakpoint. This used to be a
    //     `[known]` line only: at 721px the column was squeezed to a 25px stub that
    //     no amount of `min-width: 0` could recover, because a select floors at a
    //     ~22px intrinsic UA minimum. The 850px breakpoint puts the grid's narrowest
    //     render at 851px, which clears the readable floor for any scrollbar gutter
    //     up to 25px — so the stub is gone and the measurement becomes an assertion.
    //     The gutter matters because it comes off the content column and its width is
    //     the host's, not ours: this must not fail on a machine with fatter
    //     scrollbars than the one it was tuned on.
    //     Catches: any future change that re-narrows the grid — another fixed
    //     column, wider padding on an ancestor, or the breakpoint drifting back down.
    //     Only the `1fr` column is measured: the backend (88px) and effort (76px)
    //     columns are fixed by design and their option text fits.
    const models = [...document.querySelectorAll('#sm-tier-list select.sm-version')].map(s => rect(s).width);
    if (models.length) {
      const min = round(Math.min(...models));
      if (min < SELECT_MIN_W) {
        fail('collapsed-select', `narrowest tier-grid model select ${min}px < ${SELECT_MIN_W} — the wide grid's 1fr column is squeezed at this width`);
      } else {
        known.push(`narrowest tier-grid model select ${min}px — readable`);
      }
    }
  }

  // 2. The scrolling container. `.settings-content` is `overflow-y: auto`, which
  //    computes to `auto` on both axes — it clips and scrolls sideways rather
  //    than pushing the document out, so check #1 alone cannot see this.
  //    Above the breakpoint the role list is exempt (see `exempt`), so measure the
  //    widest laid-out box in the TIER rows instead of the whole scroller: 851px is
  //    the narrowest the six-column grid ever renders, and it has to fit in the
  //    content column there. Measured through `boxesOf`, or the wrappers' zero
  //    rects would reduce this to the tier label's right edge and never fire.
  // Scrolling a container right shifts its children's viewport rects LEFT, so the
  // scroll origin is `rect.left - scrollLeft`. Currently unexercised: nothing
  // scrolls `.settings-content` horizontally at any width in this sweep, so
  // scrollLeft is always 0 — the term is here for correctness, not because a test
  // covers it. Don't read today's passing numbers as evidence it works.
  const contentLeft = rect(content).left - content.scrollLeft;
  const scrollW = narrow
    ? content.scrollWidth
    : Math.ceil(Math.max(0, ...[...document.querySelectorAll('#sm-tier-list .sm-family-row')]
        .flatMap(li => boxesOf(li).map(k => rect(k).right))) - contentLeft);
  if (scrollW > content.clientWidth + 1) {
    fail('container-overflow', `${narrow ? '.settings-content scrollWidth' : '#sm-tier-list rightmost box'} ${scrollW} > .settings-content clientWidth ${content.clientWidth}`);
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
    const kids = boxesOf(li); // laid-out boxes, not the contents-display wrappers
    const controls = [...li.querySelectorAll('select, button, input')];
    measured.push({ row: rowName(li), h: round(r.height), w: round(r.width) });

    // 3b. Self-check on `boxesOf`, because the geometry loops below are only as
    //     good as the box list they walk. A zero-rect entry means a box that gets
    //     silently skipped — which is exactly how a `display: contents` wrapper
    //     once made checks 6 and 8 vacuous — and above the breakpoint every
    //     control must be a direct box, not buried behind one.
    for (const k of kids) {
      const kr = rect(k);
      if (kr.width === 0 && kr.height === 0) {
        fail('zero-box', `${rowName(li)}: ${name(k)} has a zero rect — the loops below would skip it (display: contents?)`);
      }
    }
    if (!narrow) {
      for (const c of controls) {
        if (!kids.includes(c)) {
          fail('uncovered-control', `${rowName(li)}: ${name(c)} is not in the row's laid-out box list — the geometry loops would not see it`);
        }
      }
    }

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

    // 4b. The paired fields must actually be SIDE BY SIDE, narrow only. Nothing
    //     else here can tell: a pair that has silently re-stacked still gives two
    //     full-width selects that are wider than SELECT_MIN_W, are 44px tall, and
    //     do not overlap or overflow — every other check passes. The specific way
    //     it breaks is a descendant `grid-column: 1 / -1` from the row leaking into
    //     the pair and making each field span both halves, which is why
    //     `.sm-field-pair .sm-field { grid-column: auto }` exists.
    if (narrow) {
      for (const pair of li.querySelectorAll('.sm-field-pair')) {
        const fields = boxesOf(pair);
        if (fields.length !== 2) {
          fail('pair-not-paired', `${rowName(li)}: .sm-field-pair has ${fields.length} laid-out fields, expected 2`);
          continue;
        }
        const [a, b] = fields.map(rect);
        const sameBand = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > EPS;
        const sideBySide = Math.min(a.right, b.right) - Math.max(a.left, b.left) <= EPS;
        if (!sameBand || !sideBySide) {
          fail('pair-not-paired',
            `${rowName(li)}: ${name(fields[0])} [x ${round(a.left)}..${round(a.right)}, y ${round(a.top)}..${round(a.bottom)}] and ` +
            `${name(fields[1])} [x ${round(b.left)}..${round(b.right)}, y ${round(b.top)}..${round(b.bottom)}] ` +
            `are not side by side on one line`);
        }
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
      // WCAG 2.5.3 Label in Name (Level A): the visible caption has to appear in
      // the accessible name, or a speech-input user can't say what they see.
      const aria = (c.getAttribute('aria-label') || '').trim();
      if (text && aria && !aria.toLowerCase().includes(text.toLowerCase())) {
        fail('label-in-name', `${rowName(li)}: caption '${text}' is not contained in aria-label '${aria}' (WCAG 2.5.3)`);
      }
    }
    // 7b. …and EVERY caption in the row renders, not just the ones attached to a
    //     select. The loop above walks selects, so the `default` radio's caption —
    //     the one caption on the identity line, and the only label the radio has
    //     once `.sm-family-header` is hidden — had no visibility assertion at all
    //     and could be `display: none`-ed silently. Emptiness is already covered
    //     for every caption by the DOM test; this is the rendered half.
    if (narrow) {
      for (const cap of li.querySelectorAll('.sm-field-cap')) {
        const text = (cap.textContent || '').trim();
        if (getComputedStyle(cap).display === 'none' || rect(cap).width === 0) {
          const field = (cap.closest('.sm-field')?.className || '?').trim();
          fail('no-visible-caption', `${rowName(li)}: caption '${text || '(empty)'}' in [${field}] is not visible at this width`);
        }
      }
    }

    // 8. Wide layout: the row must still be ONE line, and the mobile rules must
    //    not have leaked up here.
    if (!narrow) {
      const mid = r.top + r.height / 2;
      for (const k of kids) {
        const kr = rect(k);
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
      // Opt-in: make `.settings-content` reserve a classic scrollbar gutter, so the
      // capture guard below can be exercised on a host whose scrollbars are overlay
      // (zero-width) — this Chromium's are. Injected BEFORE measuring, so the gutter
      // is part of the layout under test, not a capture-time perturbation.
      if (FORCE_GUTTER) {
        await page.addStyleTag({ content: '.settings-content { scrollbar-gutter: stable !important; }' });
      }
      const m = await page.evaluate(measure, { TAP_MIN, SELECT_MIN_W, EPS, narrow });

      // Capture AFTER measuring, and unclip the scroller first. `.settings-content`
      // is the `overflow-y: auto` scroller, so the document never grows past the
      // viewport: plain `fullPage` yields a <width>x<viewport-height> crop, and an
      // element screenshot of the panel yields a full-height PNG whose below-fold
      // area is blank. Either way the worst-case rows `seed()` exists to render
      // would be invisible. Letting the page grow instead is layout-neutral on the
      // horizontal axis, which is what every assertion above measures — but it does
      // run after them, never before.
      const out = path.join(outDir, `models-${width}.png`);
      // Vertical only, and on the ANCESTORS only — `.settings-content`'s own box is
      // left exactly as measured. Freeing its `overflow` too (the obvious thing to
      // do) is not width-neutral on a host with classic scrollbars: while a scrollbar
      // is reserved `clientWidth` is the padding box minus the gutter, and
      // `overflow: visible` reserves no gutter, so the column and every row in it
      // silently widen by the gutter between the measurement and the PNG. Measured
      // under FORCE_SCROLLBAR_GUTTER=1: freeing it gave 305 → 320 (rows 273 → 288);
      // leaving it alone holds 305/273 while the page still grows to full height.
      await page.addStyleTag({ content: `
        html, body, #app, #main, #settings-view {
          height: auto !important; max-height: none !important; overflow: visible !important;
        }
      ` });
      const shot = await page.evaluate(() => ({
        // clientWidth on BOTH sides of the comparison — `measure()` reports
        // clientWidth (padding box), and reading a border-box rect here instead
        // would make the guard fire on any host that reserves a gutter.
        w: document.querySelector('.settings-content').clientWidth,
        h: document.documentElement.scrollHeight,
      }));
      // Clip to the viewport width: unclipping lets the document grow sideways too
      // (the pre-existing wide role-row overflow does exactly that at 851px), and a
      // PNG wider than the viewport misrepresents what the layout is.
      await page.screenshot({ path: out, fullPage: true, clip: { x: 0, y: 0, width, height: shot.h } });

      // The unclip above must not have changed the axis every assertion measures.
      if (Math.abs(shot.w - m.content.cw) > 1) {
        m.fails.push({ check: 'capture-perturbed-layout',
          msg: `.settings-content clientWidth changed ${m.content.cw} → ${shot.w} when unclipped for the screenshot; the PNG does not show the measured layout` });
      }

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
