// The old UI's sidebar Conductors / Projects lenses and conductor ownership
// colour, in a real browser: what happy-dom cannot compute — rendered boxes,
// resolved colours, the lens switch surviving a reload, the phone drawer.
//
// Seeds three conductors — A titled + temp, B untitled + non-temp, C temp (the
// Conduct button's own shape) — with workers in a single-owner worktree
// (`solo-a`), a mixed worktree (`mixed`, plus a hand-spawned session) and the
// main checkout, then checks each rule. A playbook-bound worker is added when
// `list_playbooks` offers an enterable stage; otherwise the stage-line step is
// skipped, never passed.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Cc } from '../harness/fixtures.ts';
import { api, createProject, mcpCall } from '../harness/api.ts';
import { REPO_ROOT } from '../harness/boot.ts';

test.use({ ccOptions: { server: 'sidebar-lenses', scenario: path.join(REPO_ROOT, 'tests', 'fixtures', 'scenario-basic.json') } });
test.describe.configure({ mode: 'serial' });

type Inst = {
  id: string; sessionId: string; status: string; cwd: string; temp?: boolean;
  ownerSessionId?: string | null; playbook?: string | null; stage?: string | null;
};
type Row = { bw: string; bc: string; owned: boolean };

/** Polls `fn` until it returns a truthy value and returns that value. */
async function until<T>(fn: () => Promise<T | false | null | undefined>, timeout = 20_000, what = 'condition'): Promise<T> {
  let v: T | false | null | undefined;
  await expect(async () => {
    v = await fn();
    expect(v, what).toBeTruthy();
  }).toPass({ timeout, intervals: [100] });
  return v as T;
}

const insts = async (cc: Cc): Promise<Inst[]> => (await api<Inst[]>(cc, 'GET', '/api/instances')).body;
const idle = (cc: Cc, pred: (i: Inst) => boolean, what: string) =>
  until(async () => (await insts(cc)).find(pred)?.status === 'idle', 20_000, what);

async function spawnWorker(cc: Cc, caller: string, args: Record<string, unknown>): Promise<Inst> {
  const r = await mcpCall(cc, 'spawn_instance', { mode: 'bypassPermissions', ...args }, caller);
  if (r.isError) throw new Error(`spawn_instance refused: ${r.content?.[0]?.text}`);
  const { sessionId } = JSON.parse(r.content[0].text);
  await idle(cc, (i) => i.sessionId === sessionId, `worker ${sessionId} idle (spawn returned ${r.content[0].text.slice(0, 300)})`);
  return (await insts(cc)).find((i) => i.sessionId === sessionId)!;
}

// Appends one user line to an instance's session jsonl, where cc reads its
// on-disk session list from (Claude Code's cwd encoding). fake-claude writes no
// transcript. The file is named by the BACKING session id — the segment the
// temp/archive flags sit on — which the API withholds; the store's
// sessions.json maps the public id to it (`.sessions[publicId].current`).
async function seedTranscript(cc: Cc, instanceId: string, text: string): Promise<void> {
  const inst = (await insts(cc)).find((i) => i.id === instanceId)!;
  const store = JSON.parse(await fs.readFile(path.join(cc.dirs.projects, '.code-conductor', 'sessions.json'), 'utf8'));
  const backing = store.sessions?.[inst.sessionId]?.current;
  if (!backing) throw new Error(`no backing id recorded for session ${inst.sessionId}`);
  const dir = path.join(cc.dirs.claudeProjects, inst.cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `${backing}.jsonl`), JSON.stringify({
    type: 'user', message: { role: 'user', content: text }, sessionId: backing, timestamp: new Date().toISOString(),
  }) + '\n');
}

const shot = async (page: Page, name: string) =>
  test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });

const hasBox = (page: Page, sel: string) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return false;
  const r = e.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}, sel);

/** A conductor's colour resolved the way the page does, as a computed rgb(). */
const colourOf = (page: Page, sid: string) => page.evaluate(async ([s, mod]) => {
  const { conductorColor } = await import(mod);
  const probe = document.createElement('i');
  probe.style.color = conductorColor(s);
  document.body.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}, [sid, '/conductorColor.js'] as const);

const conductorSel = (sid: string) => `#conductor-list [data-key="conductor:${sid}"]`;

const rowOf = (page: Page, sid: string) => page.evaluate((s): Row | null => {
  const r = [...document.querySelectorAll<HTMLElement>('#project-list .session-row')].find((x) => x.title.split('\n')[0] === s);
  if (!r) return null;
  const cs = getComputedStyle(r);
  return { bw: cs.borderLeftWidth, bc: cs.borderLeftColor, owned: r.classList.contains('owned') };
}, sid);

const headOf = (page: Page, wt: string) => page.evaluate((w) => {
  const h = [...document.querySelectorAll('#project-list .worktree-row')].find((x) => x.querySelector('.worktree-name')?.textContent === w);
  return h ? getComputedStyle(h).boxShadow : null;
}, wt);

const ctlGeom = (page: Page) => page.evaluate(() => {
  const s = document.getElementById('conductor-filter-select')!.getBoundingClientRect();
  const t = document.getElementById('sidebar-overflow-toggle')!.getBoundingClientRect();
  const body = document.getElementById('sidebar-body')!;
  return { sh: s.height, th: t.height, sc: s.top + s.height / 2, tc: t.top + t.height / 2, sw: body.scrollWidth, cw: body.clientWidth };
});

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  test('lenses, conductor rows and ownership colour on a seeded fleet', async ({ page, cc }) => {
    test.setTimeout(300_000);

    // ---- seed
    await createProject(cc, 'uipass');
    await createProject(cc, 'uiother');
    await api(cc, 'POST', '/api/projects/.conduct/ensure');
    // `warn` so the conductors may spawn the unbound workers this check needs;
    // under the default `enforce` every conductor spawn must name a playbook.
    const a = (await api(cc, 'POST', '/api/instances', { project: '.conduct', mode: 'bypassPermissions', temp: true, playbookEnforcement: 'warn' })).body;
    const b = (await api(cc, 'POST', '/api/instances', { project: '.conduct', mode: 'bypassPermissions', temp: false, playbookEnforcement: 'warn' })).body;
    // C takes the Conduct button's own path — a temp conductor, archived on
    // exit — to prove an exited temp conductor leaves Conductors.
    const c = (await api(cc, 'POST', '/api/instances', { project: '.conduct', mode: 'bypassPermissions', temp: true })).body;
    await idle(cc, (i) => i.id === a.id, 'conductor A idle');
    await idle(cc, (i) => i.id === b.id, 'conductor B idle');
    await idle(cc, (i) => i.id === c.id, 'conductor C idle');
    const cSid = (await insts(cc)).find((i) => i.id === c.id)!.sessionId;
    const aSid = (await insts(cc)).find((i) => i.id === a.id)!.sessionId;
    const bSid = (await insts(cc)).find((i) => i.id === b.id)!.sessionId;
    await api(cc, 'PUT', `/api/sessions/${aSid}/title`, { title: 'Alpha conductor' });
    // With a transcript, B stays listed (as a disk row) under Inactive once
    // killed, and its first prompt becomes its untitled label.
    await seedTranscript(cc, b.id, 'bravo: sweep the docs');
    await seedTranscript(cc, c.id, 'charlie: temp conductor');
    await until(async () => ((await api(cc, 'GET', '/api/projects/.conduct/sessions')).body ?? []).some?.((r: Inst) => r.sessionId === bSid),
      20_000, 'B listed under .conduct');

    const aSolo = await spawnWorker(cc, a.id, { project: 'uipass', createWorktree: true, name: 'solo-a' });
    const aMixed = await spawnWorker(cc, a.id, { project: 'uipass', createWorktree: true, name: 'mixed' });
    const aMain = await spawnWorker(cc, a.id, { project: 'uipass' });
    const bMixed = await spawnWorker(cc, b.id, { project: 'uipass', worktree: 'mixed' });
    // The kill-a-worker step's victim. A conducted worker is temp, so killing
    // it archives it and it leaves the Sessions list; the transcript makes that
    // archive observable in the listing. (The in-place bar clearing of a row
    // that stays is the happy-dom test "the bar clears in place when the worker
    // dies".)
    const bMain = await spawnWorker(cc, b.id, { project: 'uipass' });
    await seedTranscript(cc, bMain.id, 'bravo: main-checkout chore');
    // B's spawn record in uiother with no live worker there: its idle chip
    // (docs/features.md). uiother stays outside A's filter (step 11).
    const bGone = await spawnWorker(cc, b.id, { project: 'uiother' });
    await api(cc, 'DELETE', `/api/instances/${bGone.id}`);
    await until(async () => !(await insts(cc)).some((i) => i.id === bGone.id), 10_000, 'B\'s uiother worker gone');
    const handRes = (await api(cc, 'POST', '/api/instances', { project: 'uipass', worktree: 'mixed', mode: 'bypassPermissions' })).body;
    await idle(cc, (i) => i.id === handRes.id, 'hand-spawned session idle');
    const handSid = (await insts(cc)).find((i) => i.id === handRes.id)!.sessionId;

    // A playbook-bound worker, only if cc offers a playbook we can enter.
    let bound: Inst | null = null;
    let boundWhy: string | null = null;
    try {
      const listed = JSON.parse((await mcpCall(cc, 'list_playbooks', {}, a.id)).content[0].text);
      type Pb = { id: string; entryStages?: string[]; spawnableStages?: string[] };
      const pb = ((listed.playbooks ?? []) as Pb[]).find((p) => (p.entryStages ?? []).some((s) => (p.spawnableStages ?? []).includes(s)));
      if (!pb) boundWhy = 'list_playbooks offered no playbook with a spawnable entry stage';
      else {
        const stage = pb.entryStages!.find((s) => pb.spawnableStages!.includes(s));
        // No explicit mode: a stage may pin one, and a conflicting value is refused.
        bound = await spawnWorker(cc, a.id, { project: 'uipass', playbook: pb.id, stage, mode: undefined });
      }
    } catch (e) { boundWhy = (e as Error).message; }

    const owned = await until(async () => {
      const all = await insts(cc);
      const want = [aSolo, aMixed, aMain, bMixed, bMain, bound].filter((w): w is Inst => !!w).map((w) => w.sessionId);
      return want.every((sid) => all.find((i) => i.sessionId === sid)?.ownerSessionId) ? all : false;
    }, 20_000, 'every worker reports its owner');
    const expectedStage = bound
      ? (() => { const r = owned.find((i) => i.sessionId === bound!.sessionId)!; return [r.playbook, r.stage].filter(Boolean).join(' · '); })()
      : null;

    await page.goto('/legacy/', { waitUntil: 'networkidle' });
    await page.waitForSelector(conductorSel(aSid));
    const colA = await colourOf(page, aSid);
    const colB = await colourOf(page, bSid);

    await test.step('1 fresh profile opens on Conductors', async () => {
      const st = {
        conductors: await hasBox(page, '#conductor-list'), projects: await hasBox(page, '#project-list'),
        row: await hasBox(page, '.projects-lens-row'), menu: await hasBox(page, '#sidebar-overflow-menu'),
        pressed: await page.getAttribute('.sidebar-lens button[data-lens="conductors"]', 'aria-pressed'),
      };
      expect(st).toEqual({ conductors: true, projects: false, row: false, menu: false, pressed: 'true' });
    });

    await test.step('2 order Conduct → strip slot → toggle → lists; Conduct full width', async () => {
      const o = await page.evaluate(() => {
        const top = (s: string) => document.querySelector(s)!.getBoundingClientRect().top;
        return {
          order: [top('#conduct-btn'), top('#sidebar-strip-slot'), top('.sidebar-lens'), top('#conductor-list')],
          btnW: document.getElementById('conduct-btn')!.getBoundingClientRect().width,
          actW: document.querySelector('.sidebar-actions')!.getBoundingClientRect().width,
        };
      });
      for (let i = 1; i < o.order.length; i++) expect(o.order[i], `order ${JSON.stringify(o.order)}`).toBeGreaterThanOrEqual(o.order[i - 1]);
      expect(Math.abs(o.btnW - o.actW), JSON.stringify(o)).toBeLessThan(0.5);
    });

    // Chip styling is docs/features.md → Sidebar lenses: a live chip (a live
    // owned worker now) is "solid, brighter" — --text on a --muted border; an
    // idle chip is "dashed, dimmed"; every other chip keeps --muted on --border.
    await test.step('3 conductor rows: titled bold, untitled italic muted, chips live vs idle (docs/features.md)', async () => {
      await expect(page.locator(`${conductorSel(bSid)} .conductor-chip.idle`), 'B\'s idle uiother chip').toHaveCount(1);
      const r = await page.evaluate(([aS, bS]) => {
        const toRgb = (v: string) => { const i = document.createElement('i'); i.style.color = v; document.body.appendChild(i); const c = getComputedStyle(i).color; i.remove(); return c; };
        const root = getComputedStyle(document.documentElement);
        const at = document.querySelector(`#conductor-list [data-key="conductor:${aS}"] .conductor-title`)!;
        const bt = document.querySelector(`#conductor-list [data-key="conductor:${bS}"] .conductor-title`)!;
        const chips = [...document.querySelectorAll('#conductor-list .conductor-chip')].map((c) => {
          const s = getComputedStyle(c);
          const kind = c.classList.contains('live') ? 'live' : c.classList.contains('idle') ? 'idle' : 'other';
          return { kind, text: c.textContent, color: s.color, border: s.borderTopColor, style: s.borderTopStyle };
        });
        return {
          aText: at.textContent, aWeight: Number(getComputedStyle(at).fontWeight),
          bItalic: getComputedStyle(bt).fontStyle, bColor: getComputedStyle(bt).color,
          muted: toRgb(root.getPropertyValue('--muted').trim()), border: toRgb(root.getPropertyValue('--border').trim()),
          text: toRgb(root.getPropertyValue('--text').trim()), chips,
        };
      }, [aSid, bSid] as const);
      expect(r.aText).toBe('Alpha conductor');
      expect(r.aWeight).toBeGreaterThanOrEqual(600);
      expect(r.bItalic).toBe('italic');
      expect(r.bColor).toBe(r.muted);
      expect(r.chips.length).toBeGreaterThan(0);
      // A and B each have a live worker in uipass, so the live rule is never vacuous here.
      expect(r.chips.filter((c) => c.kind === 'live').length, JSON.stringify(r.chips)).toBeGreaterThan(0);
      expect(r.chips.filter((c) => c.kind === 'idle').length, JSON.stringify(r.chips)).toBeGreaterThan(0);
      for (const { kind, text, color, border, style } of r.chips) {
        const want = kind === 'live'
          ? { color: r.text, border: r.muted, style: 'solid' }
          : { color: r.muted, border: r.border, style: kind === 'idle' ? 'dashed' : 'solid' };
        expect({ color, border, style }, `${kind} chip "${text}" (docs/features.md: live solid, brighter; idle dashed, dimmed)`).toEqual(want);
      }
    });

    await test.step('4 each .conductor-block box-shadow carries conductorColor(sid)', async () => {
      const sa = await page.$eval(conductorSel(aSid), (e) => getComputedStyle(e).boxShadow);
      const sb = await page.$eval(conductorSel(bSid), (e) => getComputedStyle(e).boxShadow);
      expect(sa).toContain(colA);
      expect(sb).toContain(colB);
      await shot(page, 'lenses-conductors');
    });

    // The header row's highlight box starts past the block's bar, hovered and selected.
    const headerSel = `${conductorSel(aSid)} > .conductor-row`;
    const gap = () => page.evaluate(([bs, rs]) => {
      const block = document.querySelector(bs)!, row = document.querySelector(rs)!;
      return {
        gap: row.getBoundingClientRect().left - block.getBoundingClientRect().left,
        bar: parseFloat(/\)\s+(-?[\d.]+)px/.exec(getComputedStyle(block).boxShadow)?.[1] ?? 'NaN'),
        active: row.classList.contains('active'),
      };
    }, [conductorSel(aSid), headerSel] as const);

    await test.step('4b hovered conductor row starts past the block bar', async () => {
      await page.hover(headerSel);
      const hov = await gap();
      expect(hov.bar, JSON.stringify(hov)).toBeGreaterThan(0);
      expect(hov.gap, JSON.stringify(hov)).toBe(hov.bar);
      await shot(page, 'lenses-conductor-hover');
    });

    await test.step('4c selected conductor row starts past the block bar', async () => {
      await page.click(headerSel);
      await page.waitForSelector(`${headerSel}.active`);
      const sel = await gap();
      expect(sel.active).toBe(true);
      expect(sel.bar, JSON.stringify(sel)).toBeGreaterThan(0);
      expect(sel.gap, JSON.stringify(sel)).toBe(sel.bar);
      await shot(page, 'lenses-conductor-selected');
    });

    await test.step('5 expanded conductor tree', async () => {
      await page.click(`${conductorSel(aSid)} .conductor-caret`);
      await page.waitForSelector(`${conductorSel(aSid)} .conductor-tree`);
      const t = await page.evaluate(([sel, boundSid, mainSid]) => {
        const tree = document.querySelector(`${sel} .conductor-tree`)!;
        const forbidden = ['.add-instance', '.delete-project', '.wt-spawn', '.wt-remove', '.session-delete']
          .filter((s) => tree.querySelector(s));
        const rowIn = (sid: string) => [...tree.querySelectorAll<HTMLElement>('.session-row')].find((r) => r.title.split('\n')[0] === sid);
        const bRow = boundSid ? rowIn(boundSid) : null;
        const stage = bRow?.querySelector('.session-stage');
        const pv = bRow?.querySelector('.session-preview');
        return {
          forbidden,
          stageText: stage?.textContent ?? null,
          stageBelow: stage && pv ? stage.getBoundingClientRect().top >= pv.getBoundingClientRect().bottom - 0.5 : null,
          unboundHasStage: !!rowIn(mainSid)?.querySelector('.session-stage'),
          unboundFound: !!rowIn(mainSid),
        };
      }, [conductorSel(aSid), bound?.sessionId ?? null, aMain.sessionId] as const);

      await test.step('5a expanded tree is read-only', async () => {
        expect(t.forbidden, JSON.stringify(t)).toEqual([]);
        expect(t.unboundFound, JSON.stringify(t)).toBe(true);
      });
      // docs/features.md → Temp session: in the Conductors lens the ↑ Make
      // persistent button sits on live temp conductor rows and live temp worker
      // rows. Within the lens it is on exactly those rows, once each.
      await test.step('5a′ ↑ promote: exactly the live temp conductor and worker rows of the lens (docs/features.md)', async () => {
        const live = (await insts(cc)).filter((i) => i.status !== 'exited' && i.status !== 'crashed');
        const liveTemp = new Set(live.filter((i) => i.temp === true).map((i) => i.sessionId));
        const seen = await page.evaluate(() => {
          const lens = document.querySelector('#conductor-list')!;
          const promotes = [...lens.querySelectorAll('.session-promote')];
          const placed = promotes.map((b) => {
            const worker = b.closest<HTMLElement>('.conductor-tree .session-row');
            if (worker) return { kind: 'worker', sid: worker.title.split('\n')[0] };
            const block = b.closest<HTMLElement>('.conductor-block');
            const onRow = !!b.closest('.conductor-row');
            return { kind: onRow && block ? 'conductor' : 'elsewhere', sid: block?.dataset.key?.replace(/^conductor:/, '') ?? null };
          });
          const rows = [
            ...[...lens.querySelectorAll<HTMLElement>('.conductor-tree .session-row')]
              .map((r) => ({ kind: 'worker', sid: r.title.split('\n')[0], n: r.querySelectorAll('.session-promote').length })),
            ...[...lens.querySelectorAll<HTMLElement>('.conductor-block')]
              .map((b) => ({ kind: 'conductor', sid: b.dataset.key!.replace(/^conductor:/, ''), n: b.querySelector(':scope > .conductor-row')?.querySelectorAll('.session-promote').length ?? 0 })),
          ];
          return { placed, rows };
        });
        const ctx = JSON.stringify({ seen, liveTemp: [...liveTemp] });
        expect(seen.placed.filter((p) => p.kind === 'elsewhere'), `a ↑ outside any conductor or worker row: ${ctx}`).toEqual([]);
        expect(seen.rows.some((r) => r.kind === 'worker' && liveTemp.has(r.sid)), `no live temp worker row in the tree: ${ctx}`).toBe(true);
        expect(seen.rows.some((r) => r.kind === 'conductor' && !liveTemp.has(r.sid)), `no non-temp conductor row to check: ${ctx}`).toBe(true);
        for (const r of seen.rows) {
          expect(r.n, `${r.kind} row ${r.sid} (live temp: ${liveTemp.has(r.sid)}): ${ctx}`).toBe(liveTemp.has(r.sid) ? 1 : 0);
        }
        expect(seen.placed.length, ctx).toBe(seen.rows.reduce((n, r) => n + r.n, 0));
      });
      await test.step('5b an unbound worker has no stage line', async () => {
        expect(t.unboundHasStage, JSON.stringify(t)).toBe(false);
      });
      await test.step('5c stage line = /api/instances playbook · stage, under the preview', async (step) => {
        if (!bound) test.info().annotations.push({ type: 'skip', description: `5c stage line: ${boundWhy}` });
        step.skip(!bound, boundWhy ?? undefined);
        expect(t.stageText).toBe(expectedStage);
        expect(t.stageBelow).toBe(true);
      });
      await shot(page, 'lenses-conductors-expanded');
    });

    await test.step('7 lens persists across a reload', async () => {
      await page.click('.sidebar-lens button[data-lens="projects"]');
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('#project-list .project-row');
      const lens = await page.getAttribute('#sidebar', 'data-lens');
      expect(lens).toBe('projects');
      expect(await hasBox(page, '#project-list')).toBe(true);
      expect(await hasBox(page, '#conductor-list')).toBe(false);
    });

    await test.step('8 filter select and ≡ share height and centre; panel opens right-aligned', async () => {
      const g = await ctlGeom(page);
      await page.click('#sidebar-overflow-toggle');
      const p = await page.evaluate(() => {
        const panel = document.getElementById('sidebar-overflow-panel')!.getBoundingClientRect();
        const t = document.getElementById('sidebar-overflow-toggle')!.getBoundingClientRect();
        return { panelRight: panel.right, toggleRight: t.right, visible: panel.height > 0 };
      });
      await page.click('#sidebar-overflow-toggle');
      const detail = JSON.stringify({ ...g, ...p });
      expect(Math.abs(g.sh - g.th), detail).toBeLessThanOrEqual(0.5);
      expect(Math.abs(g.sc - g.tc), detail).toBeLessThanOrEqual(0.5);
      expect(p.visible, detail).toBe(true);
      expect(Math.abs(p.panelRight - p.toggleRight), detail).toBeLessThanOrEqual(0.5);
    });

    await test.step('9 no .conduct row in the Projects lens', async () => {
      const bad = await page.evaluate(() => ({
        conductLi: document.querySelectorAll('.project-conduct').length,
        conductName: [...document.querySelectorAll('.project-name')].some((n) => (n.textContent ?? '').includes('Conduct')),
      }));
      expect(bad).toEqual({ conductLi: 0, conductName: false });
    });

    // Open the uipass Worktrees group and let the lazy lists land.
    await page.evaluate(() => { for (const d of document.querySelectorAll<HTMLDetailsElement>('#project-list details.worktree-group')) d.open = true; });
    await until(async () => (await rowOf(page, handSid)) && (await rowOf(page, aSolo.sessionId))
      && (await rowOf(page, aMain.sessionId)) && (await rowOf(page, bMain.sessionId)), 20_000, 'Projects-lens session rows');

    await test.step('10a single-owner worktree: head in A\'s colour, its rows unbarred', async () => {
      const solo = await headOf(page, 'solo-a');
      const soloRow = await rowOf(page, aSolo.sessionId);
      expect(solo).toContain(colA);
      expect(soloRow?.bw).toBe('0px');
    });
    await test.step('10b mixed worktree: head plain, A and B rows in their own colours, hand-spawned unbarred', async () => {
      const mixed = await headOf(page, 'mixed');
      const ra = await rowOf(page, aMixed.sessionId), rb = await rowOf(page, bMixed.sessionId), rh = await rowOf(page, handSid);
      const detail = JSON.stringify({ mixed, ra, rb, rh });
      expect(mixed, detail).toBe('none');
      expect(ra, detail).toMatchObject({ bw: '3px', bc: colA });
      expect(rb, detail).toMatchObject({ bw: '3px', bc: colB });
      expect(rh?.bw, detail).toBe('0px');
    });
    // Session ids are random, so A and B share a hue slot one run in twelve;
    // then 10b cannot tell their bars apart, and says so.
    await test.step('10b distinct per-conductor colours', async (step) => {
      const why = `A and B hashed to the same slot (${colA}) this run — rerun to discriminate`;
      if (colA === colB) test.info().annotations.push({ type: 'skip', description: `10b distinct per-conductor colours: ${why}` });
      step.skip(colA === colB, why);
      expect(colA).not.toBe(colB);
    });
    await test.step('10c main-checkout A worker carries A\'s bar', async () => {
      const rm = await rowOf(page, aMain.sessionId);
      expect(rm).toMatchObject({ bw: '3px', bc: colA });
      await shot(page, 'lenses-projects');
    });

    await test.step('12 selected row: 1px muted outline, panel-2 fill, bold, owner bar kept', async () => {
      // Click a session row: the owned main-checkout A worker.
      await page.evaluate((s) => {
        [...document.querySelectorAll<HTMLElement>('#project-list .session-row')].find((x) => x.title.split('\n')[0] === s)!.click();
      }, aMain.sessionId);
      await until(() => page.evaluate((s) => [...document.querySelectorAll<HTMLElement>('#project-list .session-row')]
        .find((x) => x.title.split('\n')[0] === s)?.classList.contains('active'), aMain.sessionId), 20_000, 'row active');
      const sel = await page.evaluate((s) => {
        const toRgb = (v: string) => { const i = document.createElement('i'); i.style.color = v; document.body.appendChild(i); const c = getComputedStyle(i).color; i.remove(); return c; };
        const root = getComputedStyle(document.documentElement);
        const r = [...document.querySelectorAll<HTMLElement>('#project-list .session-row')].find((x) => x.title.split('\n')[0] === s)!;
        const cs = getComputedStyle(r);
        return {
          outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`, bg: cs.backgroundColor,
          weight: getComputedStyle(r.querySelector('.session-preview')!).fontWeight, bw: cs.borderLeftWidth,
          muted: toRgb(root.getPropertyValue('--muted').trim()), panel2: toRgb(root.getPropertyValue('--panel-2').trim()),
        };
      }, aMain.sessionId);
      expect(sel.outline).toBe(`1px solid ${sel.muted}`);
      expect(sel.bg).toBe(sel.panel2);
      expect(sel.weight).toBe('700');
      expect(sel.bw).toBe('3px');
    });

    await test.step('11 filter to A: other projects hidden, mixed kept uncoloured, Worktrees open, filter root in A\'s colour', async () => {
      await page.selectOption('#conductor-filter-select', aSid);
      await page.waitForTimeout(200);
      const f = await page.evaluate(() => ({
        projects: [...document.querySelectorAll('#project-list .project-name')].map((n) => n.textContent),
        wtOpen: document.querySelector<HTMLDetailsElement>('#project-list details.worktree-group')?.open ?? null,
        filter: getComputedStyle(document.getElementById('conductor-filter')!).boxShadow,
      }));
      const mixed = await headOf(page, 'mixed');
      const detail = JSON.stringify({ ...f, mixed });
      expect(f.projects, detail).not.toContain('uiother');
      expect(f.projects, detail).toContain('uipass');
      expect(mixed, detail).toBe('none');
      expect(f.wtOpen, detail).toBe(true);
      expect(f.filter, detail).toContain(colA);
      await shot(page, 'lenses-projects-filtered');
      await page.selectOption('#conductor-filter-select', '');
    });

    await test.step('10d a killed conducted (temp) worker leaves no bar: archived, its row leaves the Sessions list', async () => {
      const before = await rowOf(page, bMain.sessionId);
      await api(cc, 'DELETE', `/api/instances/${bMain.id}`);
      expect(bMain.temp).toBe(true);
      expect(before?.bw).toBe('3px');
      await until(async () => ((await api(cc, 'GET', '/api/projects/uipass/sessions?includeArchived=1')).body ?? [])
        .find((r: { sessionId: string; archived?: boolean }) => r.sessionId === bMain.sessionId && r.archived), 10_000, 'bMain archived');
      await until(async () => (await rowOf(page, bMain.sessionId)) === null, 10_000, 'bMain row gone');
    });

    // The worktree head's bar clears IN PLACE when its only owner's worker goes
    // (the head node persists; the worktree still exists).
    await test.step('10e solo-a head loses its bar in place when its worker is killed', async () => {
      const node = await page.evaluateHandle(() => [...document.querySelectorAll('#project-list .worktree-row')]
        .find((x) => x.querySelector('.worktree-name')?.textContent === 'solo-a') ?? null);
      const before = await node.evaluate((n) => (n ? getComputedStyle(n).boxShadow : null));
      await api(cc, 'DELETE', `/api/instances/${aSolo.id}`);
      expect(before).toContain(colA);
      await expect.poll(() => node.evaluate((n) => (n ? `${n.isConnected ? 'connected' : 'detached'} ${getComputedStyle(n).boxShadow}` : 'absent')),
        { timeout: 10_000, intervals: [100] }).toBe('connected none');
    });

    await test.step('6a killed B moves under a collapsed Inactive (1) with a faded bar', async () => {
      await api(cc, 'DELETE', `/api/instances/${b.id}`);
      await page.click('.sidebar-lens button[data-lens="conductors"]');
      const collapsed = await until(() => page.evaluate(() => {
        const det = document.querySelector<HTMLDetailsElement>('#conductor-list details.conductor-inactive');
        return det ? { summary: det.querySelector('summary')!.textContent, open: det.open } : null;
      }), 10_000, 'Inactive group');
      await page.click('#conductor-list details.conductor-inactive > summary');
      await until(() => page.evaluate((s) => !!document.querySelector(`#conductor-list .conductor-inactive-list [data-key="conductor:${s}"]`), bSid),
        10_000, 'B under Inactive');
      const r = await page.evaluate((s) => {
        const m = document.querySelector(`#conductor-list .conductor-inactive-list [data-key="conductor:${s}"]`);
        return { inactive: m?.classList.contains('inactive') ?? false, shadow: m ? getComputedStyle(m).boxShadow : null };
      }, bSid);
      expect(collapsed).toEqual({ summary: 'Inactive (1)', open: false });
      expect(r.inactive).toBe(true);
      expect(r.shadow).toBeTruthy();
      expect(r.shadow).not.toBe('none');
      expect(r.shadow).not.toContain(colB);
    });

    await test.step('6b B\'s worker bar follows the server-reported owner', async () => {
      await page.click('.sidebar-lens button[data-lens="projects"]');
      const rb = await rowOf(page, bMixed.sessionId);
      const liveOwner = (await insts(cc)).find((i) => i.sessionId === bMixed.sessionId)?.ownerSessionId ?? null;
      if (liveOwner === bSid) {
        // B's live worker keeps colour B in the Projects lens.
        expect(rb, `server ownerSessionId=${liveOwner}`).toMatchObject({ bw: '3px', bc: colB });
      } else if (liveOwner) {
        // The server clears ownership when the root dies: the bar must follow it.
        expect(rb, `server ownerSessionId=${liveOwner}`).toBeTruthy();
        expect(rb!.bc, `server ownerSessionId=${liveOwner}`).toBe(await colourOf(page, liveOwner));
      } else {
        expect(rb, 'server ownerSessionId=null').toBeTruthy();
        expect(rb!.bw, 'server ownerSessionId=null').toBe('0px');
      }
    });

    // The default path: an exited TEMP conductor is archived, and is then in no
    // Conductors group; it is found in Settings → Archived.
    await test.step('6c an exited temp conductor (archived on exit) is in no Conductors group', async () => {
      await api(cc, 'DELETE', `/api/instances/${c.id}`);
      await until(async () => ((await api(cc, 'GET', '/api/projects/.conduct/sessions?includeArchived=1')).body ?? [])
        .find((r: { sessionId: string; archived?: boolean }) => r.sessionId === cSid && r.archived), 10_000, 'C archived');
      const plain = ((await api(cc, 'GET', '/api/projects/.conduct/sessions')).body ?? []).some((x: { sessionId: string }) => x.sessionId === cSid);
      const inArchived = (((await api(cc, 'GET', '/api/archived')).body?.groups ?? []) as { sessions: { sessionId: string }[] }[])
        .some((g) => g.sessions.some((x) => x.sessionId === cSid));
      expect(plain, 'C in the plain .conduct listing').toBe(false);
      expect(inArchived, 'C in /api/archived').toBe(true);
      // Reload so the sidebar's .conduct fetch is known to follow the archive:
      // waiting for C's row to vanish could pass in the gap between the
      // instance dropping and the projects refresh.
      await page.reload({ waitUntil: 'networkidle' });
      await page.click('.sidebar-lens button[data-lens="conductors"]');
      await page.click('#conductor-list details.conductor-inactive > summary');
      // B is a disk row only: its inactive row proves the listing landed.
      const r = await until(() => page.evaluate(([bs, cs]) => {
        if (!document.querySelector(`#conductor-list .conductor-inactive-list [data-key="conductor:${bs}"]`)) return null;
        return {
          summary: document.querySelector('#conductor-list details.conductor-inactive > summary')!.textContent,
          cShown: !!document.querySelector(`#conductor-list [data-key="conductor:${cs}"]`),
        };
      }, [bSid, cSid] as const), 10_000, 'B under Inactive after reload');
      expect(r).toEqual({ summary: 'Inactive (1)', cShown: false });
    });

    await test.step('13 opening A sets #instance-title and shows #subagent-panel', async () => {
      await page.click('.sidebar-lens button[data-lens="conductors"]');
      await page.click(`${conductorSel(aSid)} .conductor-title`);
      await until(() => page.evaluate(() => {
        const t = document.getElementById('instance-title')?.textContent ?? '';
        const panel = document.getElementById('subagent-panel');
        const shown = !!panel && !panel.hidden && panel.getBoundingClientRect().height > 0;
        return t.includes('Alpha conductor') && shown;
      }), 10_000, 'A open with the subagent panel');
    });
  });
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });

  // A fresh profile with the drawer open, Projects lens, over the fleet the
  // desktop test seeded.
  test('filter and ≡ share height and centre; no sideways overflow', async ({ page }) => {
    await page.goto('/legacy/', { waitUntil: 'networkidle' });
    await page.click('#sidebar-toggle');
    await page.click('.sidebar-lens button[data-lens="projects"]');
    await page.waitForTimeout(300);
    const g = await ctlGeom(page);
    const detail = JSON.stringify(g);
    expect(Math.abs(g.sh - g.th), detail).toBeLessThanOrEqual(0.5);
    expect(Math.abs(g.sc - g.tc), detail).toBeLessThanOrEqual(0.5);
    expect(g.sw, detail).toBeLessThanOrEqual(g.cw);
    await shot(page, 'lenses-phone');
  });
});
