// Settings → Models responsive layout in the old UI: geometry assertions and a
// screenshot per width of a sweep straddling the view's 850px breakpoint, on
// worst-case content seeded once per worker.
//
//   FORCE_SCROLLBAR_GUTTER=1 makes `.settings-content` reserve a classic
//   scrollbar gutter (this Chromium's scrollbars are overlay/zero-width), which
//   exercises `capture-perturbed-layout`. Run the spec both ways: the gutter
//   comes off the content column, so the overlay run understates every
//   width-driven failure — on the same mutant (breakpoint at 720px)
//   `span.sm-col-header` escapes `#settings-models` by 10.3px on overlay
//   scrollbars and by 25.3px with a classic gutter.
//
// The breakpoint is not tuned to the narrowest value that passes here, because
// the gutter's width is the host's: `SELECT_MIN_W` binds at an effective width
// (viewport − sidebar − column padding − gutter) of 826px, and `max-width:
// 850px` puts the grid's narrowest render at 851px, clearing it for any gutter
// up to 25px. Tuned to 840 it would measure exactly 100px on a 15px-gutter host
// and 98px on a 17px one — a spurious red on a clean checkout.
//
// Two assertions exist because a weaker check passes through the bug they
// cover. `grid-tracks-fit` is separate from `containment` because a grid whose
// tracks exceed its content box does not shrink them — it overflows, and only
// whichever item reaches its track's right edge reveals it: with the tier list
// boxed in a fieldset at a 720px breakpoint, the header and all four tier rows
// overflow by the same ~27px, but a row's last item is a centre-justified
// radio, so only the header's last `.sm-col-header` sticks out far enough for
// containment to see. `pair-not-paired` exists because a `.sm-field-pair` that
// has silently re-stacked still yields two full-width selects that clear
// `SELECT_MIN_W`, are 44px tall, and neither overlap nor overflow. Both are
// mutation-checked: a 720px breakpoint fails `grid-tracks-fit` and
// `containment` at 721px; deleting `.sm-field-pair .sm-field { grid-column:
// auto }`, or collapsing the pair's `grid-template-columns` to one track, fails
// `pair-not-paired` at every narrow width and nothing else.
//
// Geometry loops walk `boxesOf(row)`, which flattens `display: contents`
// children, not `row.children`: such an element has a zero rect, and above the
// breakpoint every control sits inside one. `zero-box` and `uncovered-control`
// self-check that, so the loops cannot go vacuous unnoticed.
//
// Capture: `.settings-content` is an `overflow-y: auto` scroller, so the
// document never grows past the viewport — a plain `fullPage` shot crops to
// <width>×<viewport-height>, and an element shot of `#settings-models` is
// full-height but blank below the fold, because the scroller still clips it.
// After every measurement the scroller's ANCESTORS have their height/overflow
// freed so the page grows to full height, then `fullPage` + a clip to the
// viewport width (the document can also grow sideways, and a PNG wider than the
// viewport misrepresents the layout). `.settings-content`'s own box stays as
// measured: freeing its `overflow` is not width-neutral where scrollbars are
// classic — a reserved gutter makes `clientWidth` the padding box minus the
// gutter, `overflow: visible` reserves none, so the column and its rows widen
// by the gutter between measurement and PNG (305 → 320, rows 273 → 288, under
// FORCE_SCROLLBAR_GUTTER=1). `capture-perturbed-layout` compares the column's
// `clientWidth` either side of the unclip — `clientWidth` on both sides, since a
// border-box rect on one side would fire on any gutter-reserving host.
//
// The DOM contract this layout rests on is covered deterministically by
// tests/settings-models-field-labels.test.mjs.
import { test, expect } from '../harness/fixtures.ts';
import { api } from '../harness/api.ts';

// 849/851 straddle the breakpoint: 849 is the widest the restacked card layout
// renders, 851 the narrowest the six-column grid does. 719/721 are inside the
// card range; 721 is where boxing the tier list in a fieldset pushed the grid's
// tracks past their row, so the sweep keeps the spot that bug stood on.
const NARROW = [320, 360, 390, 719, 721, 849];
const WIDE = [851, 1024, 1280];
const TAP_MIN = 44;        // the stylesheet's own floor (#review-header, .commit-row, …)
const SELECT_MIN_W = 100;  // a select narrower than this can't show a model name
const EPS = 0.5;
const VIEWPORT_HEIGHT = 900;

const FORCE_GUTTER = process.env.FORCE_SCROLLBAR_GUTTER === '1';

// Every check `measure()` and the capture guard can fail; each is its own
// assertion per width.
const CHECKS = [
  'doc-overflow', 'no-tier-fieldset', 'grid-tracks-fit', 'collapsed-select',
  'container-overflow', 'containment', 'zero-box', 'uncovered-control',
  'pair-not-paired', 'tap-target', 'overlap', 'no-accessible-name',
  'no-visible-caption', 'label-in-name', 'wide-stacked', 'mobile-rule-leaked',
  'no-rows', 'capture-perturbed-layout',
];

// Worst-case content. The layout's failure mode is content-driven and
// `min-width: 0` only helps if nothing forces a wider min-content, so both are
// single unbreakable tokens: a 40-char custom role name (CUSTOM_ROLE_MAX,
// ^[A-Za-z][A-Za-z0-9-]*$ — user-supplied, no shorter bound to rely on) and a
// long model id bound to a tier.
const LONG_ROLE = 'Extremely-Long-Custom-Role-Name-For-Test';
const LONG_MODEL = 'qwen3-coder-480b-a35b-instruct-fp8:cloud-preview-20260101';
const LONG_LABEL = 'MyVeryLongLocalModelLabelForLayoutTesting';

test.use({ ccOptions: { server: 'models-responsive' } });

test.beforeAll(async ({ cc }) => {
  const post = async (route: string, body: unknown) => {
    const r = await api(cc, 'POST', route, body);
    expect(r.status, `${route} → ${r.status} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  };
  // `ollama` is the built-in substitution backend, so no backend row to add.
  await post('/api/settings/models/custom', {
    label: LONG_LABEL, model: LONG_MODEL, backend: 'ollama', contextWindow: 256000,
  });
  await post('/api/settings/models/prefs', {
    tierBackend: { tier: 'frontier', backend: { backend: 'ollama', model: LONG_MODEL } },
  });
  await post('/api/settings/models/roles', { role: LONG_ROLE });
  // On a Custom binding the role row renders its full field set (name + binds-to
  // + backend + model + effort + remove) — the widest role row.
  await post('/api/settings/models/prefs', {
    roleBackend: { role: LONG_ROLE, backend: { backend: 'ollama', model: LONG_MODEL } },
  });
});

// Runs in the page; returns raw measurements, failures and informational lines.
function measure({ TAP_MIN, SELECT_MIN_W, EPS, narrow }: {
  TAP_MIN: number; SELECT_MIN_W: number; EPS: number; narrow: boolean;
}) {
  const fails: { check: string; msg: string }[] = [];
  const known: string[] = [];
  const fail = (check: string, msg: string) => fails.push({ check, msg });
  const de = document.documentElement;
  const rect = (el: Element) => el.getBoundingClientRect();
  const round = (n: number) => Math.round(n * 10) / 10;
  const name = (el: Element) => {
    const cls = (el.className || '').toString().trim().split(/\s+/)[0];
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
  };
  const panel = document.getElementById('settings-models')!;
  const content = document.querySelector('.settings-content')!;
  const rows = [
    ...document.querySelectorAll('#sm-tier-list .sm-family-row'),
    ...document.querySelectorAll('#sm-role-list .sm-role-row'),
  ];
  const rowName = (li: Element) =>
    (li.querySelector('.sm-family-label')?.textContent || '?').slice(0, 24);

  // A `display: contents` element generates no box, so `li.children` is not a
  // row's list of laid-out boxes: flatten through contents-display children and
  // drop `display: none` ones.
  const boxesOf = (el: Element): Element[] => [...el.children].flatMap((c) => {
    const d = getComputedStyle(c).display;
    if (d === 'contents') return boxesOf(c);
    if (d === 'none') return [];
    return [c];
  });

  // Whole-page overflow.
  if (de.scrollWidth > de.clientWidth) {
    fail('doc-overflow', `documentElement scrollWidth ${de.scrollWidth} > clientWidth ${de.clientWidth}`);
  }

  // The tier list is boxed in a fieldset at every width — the box is not a
  // mobile affordance, and its 30px of padding + border is what sets the
  // breakpoint, so losing it silently would leave that value unexplained.
  if (!document.querySelector('#sm-tier-list')?.closest('fieldset.sm-tiers')) {
    fail('no-tier-fieldset', '#sm-tier-list is not inside a fieldset.sm-tiers — the tier group box is gone');
  }

  // Grid tracks (resolved to used px) plus gaps must fit the content box.
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

  // The WIDE role row is a no-wrap flex this check does not own: with a
  // max-length custom role name its min-content is ~686px, so it overflows
  // whenever the content column is narrower (561px at 851). Fixing it would take
  // a ~1030px breakpoint, which would restack 1024px desktop. Reported as a
  // `[known]` line, never asserted, and only above the breakpoint — below it the
  // restacked role row is owned and asserted.
  const exempt = (el: Element) => !narrow && el.closest('#sm-role-list') !== null;
  if (!narrow) {
    const over = Math.max(0, ...[...document.querySelectorAll('#sm-role-list .sm-role-row')].map(li =>
      Math.max(0, ...boxesOf(li).map(k => rect(k).right)) - rect(li).right));
    known.push(over > EPS
      ? `wide role row overflows its own box by ${round(over)}px (content column ${content.clientWidth}px)` +
        ` — pre-existing no-wrap flex, not asserted above the breakpoint`
      : `wide role row fits (no overflow) — not asserted above the breakpoint either way`);
    // The tier grid's `1fr` model column must stay readable above the
    // breakpoint, for any scrollbar gutter up to 25px. Catches a change that
    // re-narrows the grid — another fixed column, wider ancestor padding, the
    // breakpoint drifting down. The backend (88px) and effort (76px) columns are
    // fixed by design and their option text fits.
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

  // `.settings-content` is `overflow-y: auto`, which computes to `auto` on both
  // axes — it scrolls sideways rather than pushing the document out, so
  // `doc-overflow` cannot see this. Above the breakpoint the role list is exempt,
  // so measure the tier rows' rightmost laid-out box instead of the scroller.
  // Scrolling a container right shifts its children's rects left, hence
  // `- scrollLeft`; nothing in this sweep scrolls it sideways, so that term is
  // unexercised.
  const contentLeft = rect(content).left - content.scrollLeft;
  const scrollW = narrow
    ? content.scrollWidth
    : Math.ceil(Math.max(0, ...[...document.querySelectorAll('#sm-tier-list .sm-family-row')]
        .flatMap(li => boxesOf(li).map(k => rect(k).right))) - contentLeft);
  if (scrollW > content.clientWidth + 1) {
    fail('container-overflow', `${narrow ? '.settings-content scrollWidth' : '#sm-tier-list rightmost box'} ${scrollW} > .settings-content clientWidth ${content.clientWidth}`);
  }

  // Containment: nothing in the panel sticks out of the panel box, even where an
  // ancestor hides the overflow.
  const pr = rect(panel);
  for (const el of panel.querySelectorAll('*')) {
    if ((el as HTMLElement).offsetParent === null && el.getClientRects().length === 0) continue; // hidden
    if (exempt(el)) continue;
    const r = rect(el);
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > pr.right + EPS || r.left < pr.left - EPS) {
      fail('containment', `${name(el)} [${round(r.left)}..${round(r.right)}] escapes #settings-models [${round(pr.left)}..${round(pr.right)}]`);
    }
  }

  const measured: { row: string; h: number; w: number }[] = [];
  for (const li of rows) {
    const r = rect(li);
    const kids = boxesOf(li);
    const controls = [...li.querySelectorAll('select, button, input')];
    measured.push({ row: rowName(li), h: round(r.height), w: round(r.width) });

    // Self-check on `boxesOf`: a zero-rect box is silently skipped by the loops
    // below, and above the breakpoint every control must be a direct box.
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

    // A select starved to a stub is unreadable. The width floor is narrow-only:
    // the wide grid's backend and effort columns are deliberately narrower.
    for (const c of li.querySelectorAll('select')) {
      const cr = rect(c);
      if (narrow && cr.width < SELECT_MIN_W) {
        fail('collapsed-select', `${rowName(li)}: ${name(c)} width ${round(cr.width)} < ${SELECT_MIN_W}`);
      }
      if (cr.width <= 0 || cr.height <= 0) {
        fail('collapsed-select', `${rowName(li)}: ${name(c)} is ${round(cr.width)}x${round(cr.height)}`);
      }
    }

    // Paired fields sit side by side, narrow only. The way it breaks is the
    // row's descendant `grid-column: 1 / -1` leaking into the pair, which
    // `.sm-field-pair .sm-field { grid-column: auto }` prevents.
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

    // Tap targets, narrow only. A select/button measures itself; the two bare
    // boxes (enable checkbox, default radio) measure their `.sm-field` wrapper.
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

    // No overlap between a row's own boxes (a stacked row with a fixed height
    // would collide here).
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

    // Every control names what it configures: an aria-label (the accessible
    // name), and for selects a visible `.sm-field-cap` in the enclosing label,
    // which is what a sighted phone user reads.
    for (const c of controls) {
      const aria = (c.getAttribute('aria-label') || '').trim();
      if (!aria) fail('no-accessible-name', `${rowName(li)}: ${name(c)} has no aria-label`);
    }
    for (const c of li.querySelectorAll('select')) {
      const cap = c.closest('label')?.querySelector('.sm-field-cap');
      const text = (cap?.textContent || '').trim();
      if (!cap || !text) {
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
    // Every caption in the row renders, not only those on a select: the
    // `default` radio's caption is the only label the radio has once
    // `.sm-family-header` is hidden. Emptiness is the DOM test's half.
    if (narrow) {
      for (const cap of li.querySelectorAll('.sm-field-cap')) {
        const text = (cap.textContent || '').trim();
        if (getComputedStyle(cap).display === 'none' || rect(cap).width === 0) {
          const field = (cap.closest('.sm-field')?.className || '?').trim();
          fail('no-visible-caption', `${rowName(li)}: caption '${text || '(empty)'}' in [${field}] is not visible at this width`);
        }
      }
    }

    // Wide layout: the row is still ONE line, and the mobile rules have not
    // leaked up here.
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

for (const width of [...NARROW, ...WIDE]) {
  const narrow = NARROW.includes(width);
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: VIEWPORT_HEIGHT } });

    test(`Settings → Models layout at ${width}px (${narrow ? 'narrow' : 'wide'})`, async ({ page }, testInfo) => {
      await page.goto('/legacy/#settings', { waitUntil: 'networkidle' });
      await page.selectOption('#settings-group-select', 'models');
      await page.waitForSelector('#sm-role-list .sm-role-row .sm-field--model select');
      // Injected BEFORE measuring, so the gutter is part of the layout under
      // test, not a capture-time perturbation.
      if (FORCE_GUTTER) {
        await page.addStyleTag({ content: '.settings-content { scrollbar-gutter: stable !important; }' });
      }
      const m = await page.evaluate(measure, { TAP_MIN, SELECT_MIN_W, EPS, narrow });
      const { fails } = m;

      // Capture after measuring: free the scroller's ancestors only (see header).
      await page.addStyleTag({ content: `
        html, body, #app, #main, #settings-view {
          height: auto !important; max-height: none !important; overflow: visible !important;
        }
      ` });
      const shot = await page.evaluate(() => ({
        // clientWidth, as `measure()` reports it.
        w: document.querySelector('.settings-content')!.clientWidth,
        h: document.documentElement.scrollHeight,
      }));
      await testInfo.attach(`models-${width}.png`, {
        body: await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width, height: shot.h } }),
        contentType: 'image/png',
      });
      if (Math.abs(shot.w - m.content.cw) > 1) {
        fails.push({ check: 'capture-perturbed-layout',
          msg: `.settings-content clientWidth changed ${m.content.cw} → ${shot.w} when unclipped for the screenshot; the PNG does not show the measured layout` });
      }

      const rowH = [...new Set(m.rows.map(r => r.h))].join('/');
      testInfo.annotations.push({
        type: 'measured',
        description: `doc ${m.doc.sw}/${m.doc.cw}  .settings-content ${m.content.sw}/${m.content.cw}  rowH ${rowH}` +
          (FORCE_GUTTER ? '  (FORCE_SCROLLBAR_GUTTER=1)' : ''),
      });
      for (const k of m.known) testInfo.annotations.push({ type: 'known', description: k });

      expect(fails.filter(f => !CHECKS.includes(f.check)), 'failures under an unlisted check id').toEqual([]);
      for (const check of CHECKS) {
        expect.soft(fails.filter(f => f.check === check).map(f => f.msg), `[${check}] at ${width}px`).toEqual([]);
      }
    });
  });
}
