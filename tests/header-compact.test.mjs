// The one-row phone header (header.js + index.html): below MOBILE_LAYOUT_QUERY
// (720px) Sync and Merge leave the bar for the ⋮ menu; the title block is two
// chip lines; the TEMP / DEBUG pills are gone at every width.
//
// Real index.html and real installHeader() in happy-dom at a chosen viewport
// width (tests/headerCompactHarness.mjs). happy-dom's matchMedia really
// evaluates the width query, but it computes no layout, so the one-row look
// itself is in the gated tests/header-compact-browser.test.mjs.
//
// happy-dom quirk the resize tests route around: a MediaQueryList's `change`
// listener starts from "did not match", so the FIRST resize from a narrow start
// to a wide one fires nothing. Tests that need the change begin wide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupHeader, session, WORKTREE, lineClasses } from './headerCompactHarness.mjs';

const hasOpen = (t) => !t.dom.overflowPanel.hidden;
const openMenu = (t) => t.dom.overflowToggle.click();
const visibleMenuItems = (t) => [...t.dom.overflowPanel.children].filter(b => !b.hidden).map(b => b.id);

// Invariant: Sync / Merge are in the bar from 721px up and in ⋮ from 720px
// down, one place at a time — the edge is exact on both sides.
test('at 720px Sync and Merge leave the bar and appear in ⋮; at 721px they are back in the bar', async (tt) => {
  for (const [width, where] of [[720, 'menu'], [721, 'bar']]) {
    await tt.test(`${width}px: Sync and Merge are in the ${where}`, async () => {
      const t = await setupHeader({ width });
      t.show(session('idle', { worktree: WORKTREE }));
      const { syncBtn, mergeBtn, syncMenuBtn, mergeMenuBtn } = t.dom;
      assert.equal(syncBtn.hidden, where === 'menu');
      assert.equal(mergeBtn.hidden, where === 'menu');
      assert.equal(syncMenuBtn.hidden, where === 'bar');
      assert.equal(mergeMenuBtn.hidden, where === 'bar');
      assert.equal(t.placement(syncMenuBtn), 'menu', 'the twin lives in the ⋮ panel');
      assert.equal(t.placement(syncBtn), 'bar');
    });
  }
});

// Invariant: the ⋮ items follow the same show/disable rules as the bar
// buttons — the menu item at 720px equals the bar button at 721px, for every
// status, with and without a worktree.
test('the ⋮ Sync/Merge items are shown and disabled exactly as the bar buttons are at desktop width', async (tt) => {
  for (const status of ['idle', 'turn', 'spawning', 'crashed', 'exited']) {
    for (const worktree of [WORKTREE, null]) {
      await tt.test(`${status}, ${worktree ? 'worktree' : 'no worktree'}`, async () => {
        const wide = await setupHeader({ width: 721 });
        const narrow = await setupHeader({ width: 720 });
        wide.show(session(status, { worktree }));
        narrow.show(session(status, { worktree }));
        assert.equal(narrow.dom.syncMenuBtn.hidden, wide.dom.syncBtn.hidden, 'Sync hidden');
        assert.equal(narrow.dom.syncMenuBtn.disabled, wide.dom.syncBtn.disabled, 'Sync disabled');
        assert.equal(narrow.dom.mergeMenuBtn.hidden, wide.dom.mergeBtn.hidden, 'Merge hidden');
        assert.equal(narrow.dom.mergeMenuBtn.disabled, wide.dom.mergeBtn.disabled, 'Merge disabled');
        assert.equal(wide.dom.syncBtn.hidden, !worktree, 'sanity: shown exactly with a worktree');
      });
    }
  }
});

// Invariant: a crashed worktree session keeps ⋮ below the breakpoint (Sync and
// Merge are its only visible items there), while at desktop width ⋮ stays
// hidden for it as before.
test('below the breakpoint ⋮ appears for a crashed worktree session with only Sync and Merge visible; at desktop width it stays hidden', async () => {
  const narrow = await setupHeader({ width: 720 });
  narrow.show(session('crashed', { worktree: WORKTREE }));
  assert.equal(narrow.dom.overflowMenu.hidden, false, '⋮ is reachable');
  assert.deepEqual(visibleMenuItems(narrow), ['sync-menu-btn', 'merge-menu-btn']);

  const wide = await setupHeader({ width: 721 });
  wide.show(session('crashed', { worktree: WORKTREE }));
  assert.equal(wide.dom.overflowMenu.hidden, true, 'desktop ⋮ rule unchanged');

  const noWt = await setupHeader({ width: 720 });
  noWt.show(session('crashed'));
  assert.equal(noWt.dom.overflowMenu.hidden, true, 'a dead session with no worktree has nothing in ⋮');
});

// Invariant: the ⋮ items run the very actions the bar buttons run — once each —
// and the menu closes behind them.
test('the ⋮ Sync and Merge items run the same worktree actions and close the menu', async (tt) => {
  for (const [btn, action] of [['syncMenuBtn', 'sync'], ['mergeMenuBtn', 'merge']]) {
    await tt.test(`${action}`, async () => {
      const t = await setupHeader({ width: 720 });
      t.show(session('idle', { worktree: WORKTREE }));
      openMenu(t);
      assert.ok(hasOpen(t), 'precondition: the menu is open');
      t.dom[btn].click();
      assert.deepEqual(t.actions, [action], 'one call to the matching session action');
      assert.equal(hasOpen(t), false, 'the menu closed');
    });
  }
});

// Invariant: Plan | Code and 📋 stay in the bar at every width — not in ⋮ —
// and still send their frames from there.
test('Plan/Code and 📋 stay in the bar at every width', async (tt) => {
  for (const width of [720, 721, 1024]) {
    await tt.test(`${width}px`, async () => {
      const t = await setupHeader({ width });
      t.show(session('idle', { mode: 'plan' }));
      assert.equal(t.dom.autoApprovePlanBtn.hidden, false, '📋 shown in plan mode');
      assert.equal(t.placement(t.dom.autoApprovePlanBtn), 'bar');
      assert.equal(t.placement(t.dom.modeToggle), 'bar');

      t.dom.autoApprovePlanBtn.click();
      await new Promise(r => setImmediate(r));
      const approve = t.framesOf('auto_approve_plan');
      assert.equal(approve.length, 1, '📋 sends its frame');
      assert.equal(approve[0].enabled, true);

      t.dom.modeToggle.querySelector('[data-mode="bypassPermissions"]').click();
      await new Promise(r => setImmediate(r));
      assert.equal(t.framesOf('mode').length, 1, 'Code sends its frame');
    });
  }
});

// Invariant: the breakpoint is live — crossing it re-places Sync / Merge from
// the matchMedia change alone (no status frame), and widening past it closes a
// ⋮ that was open only for them.
test('crossing the breakpoint re-places Sync and Merge without a status frame', async (tt) => {
  await tt.test('narrowing moves them into ⋮, widening moves them back', async () => {
    const t = await setupHeader({ width: 721 });
    t.show(session('idle', { worktree: WORKTREE }));
    assert.equal(t.dom.syncBtn.hidden, false);
    await t.resize(720);
    assert.equal(t.dom.syncBtn.hidden, true, 'left the bar');
    assert.equal(t.dom.syncMenuBtn.hidden, false, 'appeared in ⋮');
    await t.resize(721);
    assert.equal(t.dom.syncBtn.hidden, false, 'back in the bar');
    assert.equal(t.dom.syncMenuBtn.hidden, true);
  });
  await tt.test('widening with a dead worktree session open in ⋮ closes the menu', async () => {
    const t = await setupHeader({ width: 721 });
    t.show(session('crashed', { worktree: WORKTREE }));
    await t.resize(720);
    assert.equal(t.dom.overflowMenu.hidden, false, '⋮ appeared on narrow');
    openMenu(t);
    assert.ok(hasOpen(t));
    await t.resize(721);
    assert.equal(t.dom.overflowMenu.hidden, true, '⋮ hidden again');
    assert.equal(hasOpen(t), false, 'and its panel closed with it');
  });
});

// Invariant: on narrow, an open ⋮ on a crashed worktree session survives the
// re-render the way it does for a live session — the close rule keys on whether
// the menu is shown, not on whether the session can use the menu.
test('on narrow an open ⋮ on a crashed worktree session survives a re-render', async () => {
  const t = await setupHeader({ width: 720 });
  const inst = session('crashed', { worktree: WORKTREE });
  t.show(inst);
  openMenu(t);
  assert.ok(hasOpen(t), 'precondition: open');
  t.show(inst);
  assert.ok(hasOpen(t), 'still open after the render');
});

// Invariant: TEMP and DEBUG are not header content at any width. (Temp stays in
// the sidebar; debug stays in the ⋮ item.)
test('no TEMP or DEBUG badge in the header at any width', async (tt) => {
  for (const width of [720, 1024]) {
    await tt.test(`${width}px`, async () => {
      const t = await setupHeader({ width });
      t.show(session('idle', { temp: true, debug: true, debugDir: '/tmp/d' }));
      assert.ok(t.dom.instanceTitle.querySelector('.ih-temp, .ih-debug') === null, 'no temp/debug chip');
      const chips = [...t.dom.instanceTitle.querySelectorAll('.ih-chip')].map(c => c.textContent.toLowerCase());
      assert.ok(!chips.includes('temp') && !chips.includes('debug'), `chips: ${chips}`);
      assert.equal(t.dom.debugBtn.textContent, '🐛 capturing', 'debug still shows in ⋮');
    });
  }
});

// Invariant: the title block's DOM shape — line 1 leads with the custom title
// (else the project) and carries the status chips; line 2 holds the project
// (marked secondary only when a title leads) and the worktree; no empty line 2.
test('title line leads with the custom title (or the project) and its status chips; the subline holds project/worktree', async (tt) => {
  await tt.test('title + worktree', async () => {
    const t = await setupHeader();
    t.show(session('turn', { title: 'My task', worktree: WORKTREE }));
    assert.deepEqual(lineClasses(t.dom, 'main'), ['ih-chip ih-title', 'ih-chip ih-status ih-status-turn']);
    assert.deepEqual(lineClasses(t.dom, 'sub'), ['ih-chip ih-project ih-secondary', 'ih-chip ih-worktree']);
  });
  await tt.test('no title + worktree', async () => {
    const t = await setupHeader();
    t.show(session('idle', { worktree: WORKTREE }));
    assert.deepEqual(lineClasses(t.dom, 'main'), ['ih-chip ih-project']);
    assert.deepEqual(lineClasses(t.dom, 'sub'), ['ih-chip ih-worktree']);
  });
  await tt.test('no title, no worktree: no subline at all', async () => {
    const t = await setupHeader();
    t.show(session('idle'));
    assert.deepEqual(lineClasses(t.dom, 'main'), ['ih-chip ih-project']);
    assert.ok(lineClasses(t.dom, 'sub') === null, 'no empty subline');
  });
  await tt.test('title, no worktree: the subline is the secondary project alone', async () => {
    const t = await setupHeader();
    t.show(session('idle', { title: 'My task' }));
    assert.deepEqual(lineClasses(t.dom, 'sub'), ['ih-chip ih-project ih-secondary']);
  });
  await tt.test('stopping… and the overage auto-resume chip follow the status on line 1', async () => {
    const t = await setupHeader();
    t.show(session('turn', { title: 'My task', interrupting: true, overageActive: true }));
    assert.deepEqual(lineClasses(t.dom, 'main'), [
      'ih-chip ih-title', 'ih-chip ih-status ih-status-interrupting', 'ih-chip ih-status ih-auto-resume',
    ]);
  });
});

// Invariant: width changes only where the controls sit — the title DOM is
// byte-identical either side of the breakpoint (layout is CSS-only).
test('the title DOM is identical at 720 and 1024', async () => {
  const inst = () => session('turn', { title: 'My task', worktree: WORKTREE, overageActive: true });
  const narrow = await setupHeader({ width: 720 });
  narrow.show(inst());
  const wide = await setupHeader({ width: 1024 });
  wide.show(inst());
  assert.equal(narrow.dom.instanceTitle.innerHTML, wide.dom.instanceTitle.innerHTML);
});

// Invariant: with no instance selected, Sync and Merge are hidden in both
// placements (bar and ⋮) at every width — a worktree session selected just
// before leaves neither behind.
test('deselecting a worktree session hides Sync and Merge in the bar and in ⋮', async (tt) => {
  for (const width of [720, 721, 1024]) {
    await tt.test(`${width}px`, async () => {
      const t = await setupHeader({ width });
      t.show(session('idle', { worktree: WORKTREE }));
      const { syncBtn, mergeBtn, syncMenuBtn, mergeMenuBtn } = t.dom;
      const shown = width <= 720 ? syncMenuBtn : syncBtn;
      assert.equal(shown.hidden, false, 'precondition: Sync is visible for the worktree session');
      t.deselect();
      assert.equal(t.dom.instanceTitle.textContent, 'no instance selected', 'precondition: no-instance branch ran');
      for (const [name, el] of Object.entries({ syncBtn, mergeBtn, syncMenuBtn, mergeMenuBtn })) {
        assert.equal(el.hidden, true, `${name} hidden with no instance`);
      }
    });
  }
});
