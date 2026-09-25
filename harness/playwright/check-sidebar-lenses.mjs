// The sidebar's Missions / Projects lenses and conductor ownership colour, in a
// real browser: what happy-dom cannot compute — rendered boxes, resolved
// colours, the lens switch surviving a reload, the phone drawer.
//
// Seeds two conductors (A titled + temp, B untitled + non-temp) with workers in
// a single-owner worktree, a mixed worktree and a main checkout, plus a
// hand-spawned session in the mixed worktree, then checks each rule. A
// playbook-bound worker is added when the orch offers a playbook; otherwise
// that check prints SKIP, never PASS.
//
//   node harness/playwright/check-sidebar-lenses.mjs [--out DIR]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootOrch } from './boot-orch.mjs';
import { importCodePlaywright } from './paths.mjs';

const { withPage } = await importCodePlaywright();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENARIO = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'scenario-basic.json');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? process.argv[outArg + 1] : path.join(__dirname, 'screenshots');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, { timeout = 20000, interval = 100 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timeout');
    await sleep(interval);
  }
}

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}: ${detail}`); };
const skip = (name, why) => console.log(`SKIP — ${name}: ${why}`);

const orch = await bootOrch({ sandbox: true, scenario: SCENARIO });
const base = orch.url;
const api = async (method, p, body) => {
  const res = await fetch(base + p, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
};
let rpcId = 1;
const callTool = async (name, args, caller) => {
  const url = base + '/mcp' + (caller ? `?caller=${encodeURIComponent(caller)}` : '');
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await res.json()).result;
};
const insts = async () => (await api('GET', '/api/instances')).body;
const idle = (pred) => waitFor(async () => (await insts()).find(pred)?.status === 'idle');

async function spawnWorker(caller, args) {
  const r = await callTool('spawn_instance', { mode: 'bypassPermissions', ...args }, caller);
  if (r.isError) throw new Error(`spawn_instance refused: ${r.content?.[0]?.text}`);
  const { sessionId } = JSON.parse(r.content[0].text);
  await idle(i => i.sessionId === sessionId).catch(async (e) => {
    const inst = (await insts()).find(i => i.sessionId === sessionId);
    throw new Error(`${e.message}: worker ${sessionId} status=${inst?.status ?? 'absent'} (spawn returned ${r.content[0].text.slice(0, 300)})`);
  });
  return (await insts()).find(i => i.sessionId === sessionId);
}

// Append one user line to an instance's session jsonl, where the orch reads
// its on-disk session list from (Claude Code's cwd encoding). The file is named
// by the BACKING session id — the one the temp/archive markers are keyed by —
// which the API withholds; the sandbox store's session-lineage.json maps the
// public id to it.
async function seedTranscript(instanceId, text) {
  const inst = (await insts()).find(i => i.id === instanceId);
  const lineage = JSON.parse(await fs.readFile(
    path.join(orch.sandbox.dirs.PROJECTS_ROOT, '.code-conductor', 'session-lineage.json'), 'utf8'));
  const backing = lineage.sessions?.[inst.sessionId]?.current;
  if (!backing) throw new Error(`no backing id recorded for session ${inst.sessionId}`);
  const dir = path.join(orch.sandbox.dirs.CLAUDE_PROJECTS_ROOT, inst.cwd.replace(/[^A-Za-z0-9-]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, `${backing}.jsonl`), JSON.stringify({
    type: 'user', message: { role: 'user', content: text }, sessionId: backing, timestamp: new Date().toISOString(),
  }) + '\n');
}

try {
  // ---- seed
  await api('POST', '/api/projects', { name: 'uipass' });
  await api('POST', '/api/projects', { name: 'uiother' });
  await api('POST', '/api/projects/.conduct/ensure');
  // `warn` so the conductors may spawn the unbound workers this check needs;
  // under the default `enforce` every conductor spawn must name a playbook.
  const a = (await api('POST', '/api/instances', { project: '.conduct', mode: 'bypassPermissions', temp: true, playbookEnforcement: 'warn' })).body;
  const b = (await api('POST', '/api/instances', { project: '.conduct', mode: 'bypassPermissions', temp: false, playbookEnforcement: 'warn' })).body;
  // C takes the 🎼 Conduct button's own path — a temp conductor, archived on
  // exit — to prove an exited temp conductor leaves Missions.
  const c = (await api('POST', '/api/instances', { project: '.conduct', mode: 'bypassPermissions', temp: true })).body;
  await idle(i => i.id === a.id);
  await idle(i => i.id === b.id);
  await idle(i => i.id === c.id);
  const cSid = (await insts()).find(i => i.id === c.id).sessionId;
  const aSid = (await insts()).find(i => i.id === a.id).sessionId;
  const bSid = (await insts()).find(i => i.id === b.id).sessionId;
  await api('PUT', `/api/sessions/${aSid}/title`, { title: 'Alpha mission' });
  // fake-claude writes no transcript, so give B one: once killed it then stays
  // listed (as a disk row) under Inactive, and its first prompt becomes its
  // untitled label.
  await seedTranscript(b.id, 'bravo: sweep the docs');
  await seedTranscript(c.id, 'charlie: temp conductor');
  await waitFor(async () => (await api('GET', '/api/projects/.conduct/sessions')).body?.some?.(r => r.sessionId === bSid));

  const aSolo = await spawnWorker(a.id, { project: 'uipass', createWorktree: true, name: 'solo-a' });
  const aMixed = await spawnWorker(a.id, { project: 'uipass', createWorktree: true, name: 'mixed' });
  const aMain = await spawnWorker(a.id, { project: 'uipass' });
  const bMixed = await spawnWorker(b.id, { project: 'uipass', worktree: 'mixed' });
  // Check 10d's victim. A conducted worker is temp, so killing it archives it
  // and it leaves the Sessions list; the transcript makes that archive
  // observable in the listing. (The in-place bar clearing of a row that stays
  // is the happy-dom test "the bar clears in place when the worker dies".)
  const bMain = await spawnWorker(b.id, { project: 'uipass' });
  await seedTranscript(bMain.id, 'bravo: main-checkout chore');
  const handRes = (await api('POST', '/api/instances', { project: 'uipass', worktree: 'mixed', mode: 'bypassPermissions' })).body;
  await idle(i => i.id === handRes.id);
  const handSid = (await insts()).find(i => i.id === handRes.id).sessionId;

  // A playbook-bound worker, only if the orch offers a playbook we can enter.
  let bound = null, boundWhy = null;
  try {
    const listed = JSON.parse((await callTool('list_playbooks', {}, a.id)).content[0].text);
    const pb = (listed.playbooks ?? []).find(p => (p.entryStages ?? []).some(s => (p.spawnableStages ?? []).includes(s)));
    if (!pb) boundWhy = 'list_playbooks offered no playbook with a spawnable entry stage';
    else {
      const stage = pb.entryStages.find(s => pb.spawnableStages.includes(s));
      // No explicit mode: a stage may pin one, and a conflicting value is refused.
      bound = await spawnWorker(a.id, { project: 'uipass', playbook: pb.id, stage, mode: undefined });
    }
  } catch (e) { boundWhy = e.message; }

  const owned = await waitFor(async () => {
    const all = await insts();
    const want = [aSolo, aMixed, aMain, bMixed, bMain, bound].filter(Boolean).map(w => w.sessionId);
    return want.every(sid => all.find(i => i.sessionId === sid)?.ownerSessionId) ? all : false;
  });
  const expectedStage = bound
    ? (() => { const r = owned.find(i => i.sessionId === bound.sessionId); return [r.playbook, r.stage].filter(Boolean).join(' · '); })()
    : null;

  await withPage(async (page) => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForSelector(`#mission-list [data-key="mission:${aSid}"]`);

    // Resolve a conductor's colour the way the page does, as a computed rgb().
    const colourOf = (sid) => page.evaluate(async (s) => {
      const { conductorColor } = await import('/conductorColor.js');
      const probe = document.createElement('i');
      probe.style.color = conductorColor(s);
      document.body.appendChild(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    }, sid);
    const colA = await colourOf(aSid);
    const colB = await colourOf(bSid);
    const hasBox = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }, sel);
    const mission = (sid) => `#mission-list [data-key="mission:${sid}"]`;

    // 1 — fresh profile opens on Missions
    {
      const st = {
        missions: await hasBox('#mission-list'), projects: await hasBox('#project-list'),
        row: await hasBox('.projects-lens-row'), menu: await hasBox('#sidebar-overflow-menu'),
        pressed: await page.getAttribute('.sidebar-lens button[data-lens="missions"]', 'aria-pressed'),
      };
      check('1 fresh profile opens on Missions', st.missions && !st.projects && !st.row && !st.menu && st.pressed === 'true', JSON.stringify(st));
    }
    // 2 — order + Conduct full width
    {
      const o = await page.evaluate(() => {
        const top = (s) => document.querySelector(s).getBoundingClientRect().top;
        return {
          order: [top('#conduct-btn'), top('#sidebar-strip-slot'), top('.sidebar-lens'), top('#mission-list')],
          btnW: document.getElementById('conduct-btn').getBoundingClientRect().width,
          actW: document.querySelector('.sidebar-actions').getBoundingClientRect().width,
        };
      });
      const sorted = o.order.every((v, i) => i === 0 || v >= o.order[i - 1]);
      check('2 order Conduct → strip slot → toggle → lists; Conduct full width', sorted && Math.abs(o.btnW - o.actW) < 0.5, JSON.stringify(o));
    }
    // 3 — mission rows: title weight, untitled italic muted, chip colours
    {
      const r = await page.evaluate(([aS, bS]) => {
        const root = getComputedStyle(document.documentElement);
        const toRgb = (v) => { const i = document.createElement('i'); i.style.color = v; document.body.appendChild(i); const c = getComputedStyle(i).color; i.remove(); return c; };
        const at = document.querySelector(`#mission-list [data-key="mission:${aS}"] .mission-title`);
        const bt = document.querySelector(`#mission-list [data-key="mission:${bS}"] .mission-title`);
        const chips = [...document.querySelectorAll('#mission-list .mission-chip')].map(c => {
          const s = getComputedStyle(c); return { color: s.color, border: s.borderTopColor };
        });
        return {
          aText: at.textContent, aWeight: Number(getComputedStyle(at).fontWeight),
          bItalic: getComputedStyle(bt).fontStyle, bColor: getComputedStyle(bt).color,
          muted: toRgb(root.getPropertyValue('--muted').trim()), border: toRgb(root.getPropertyValue('--border').trim()), chips,
        };
      }, [aSid, bSid]);
      const chipsOk = r.chips.length > 0 && r.chips.every(c => c.color === r.muted && c.border === r.border);
      check('3 mission rows: titled bold, untitled italic muted, grey chips',
        r.aText === 'Alpha mission' && r.aWeight >= 600 && r.bItalic === 'italic' && r.bColor === r.muted && chipsOk, JSON.stringify(r));
    }
    // 4 — mission bars in the conductor colour
    {
      const sa = await page.$eval(mission(aSid), e => getComputedStyle(e).boxShadow);
      const sb = await page.$eval(mission(bSid), e => getComputedStyle(e).boxShadow);
      check('4 each .mission box-shadow carries conductorColor(sid)', sa.includes(colA) && sb.includes(colB), `A=${sa} (want ${colA}) B=${sb} (want ${colB})`);
    }
    await page.screenshot({ path: path.join(OUT, 'lenses-missions.png') });
    // 5 — expanded read-only tree, stage line
    {
      await page.click(`${mission(aSid)} .mission-caret`);
      await page.waitForSelector(`${mission(aSid)} .mission-tree`);
      const t = await page.evaluate(([sel, boundSid, mainSid]) => {
        const tree = document.querySelector(`${sel} .mission-tree`);
        const forbidden = ['.add-instance', '.delete-project', '.wt-spawn', '.wt-remove', '.session-delete', '.session-promote']
          .filter(s => tree.querySelector(s));
        const rowOf = (sid) => [...tree.querySelectorAll('.session-row')].find(r => r.title.split('\n')[0] === sid);
        const b = boundSid ? rowOf(boundSid) : null;
        const stage = b?.querySelector('.session-stage');
        const pv = b?.querySelector('.session-preview');
        return {
          forbidden,
          stageText: stage?.textContent ?? null,
          stageBelow: stage && pv ? stage.getBoundingClientRect().top >= pv.getBoundingClientRect().bottom - 0.5 : null,
          unboundHasStage: !!rowOf(mainSid)?.querySelector('.session-stage'),
          unboundFound: !!rowOf(mainSid),
        };
      }, [mission(aSid), bound?.sessionId ?? null, aMain.sessionId]);
      check('5a expanded tree is read-only', t.forbidden.length === 0 && t.unboundFound, JSON.stringify(t));
      check('5b an unbound worker has no stage line', !t.unboundHasStage, JSON.stringify(t));
      if (bound) {
        check('5c stage line = /api/instances playbook · stage, under the preview',
          t.stageText === expectedStage && t.stageBelow === true, `got ${JSON.stringify(t.stageText)} want ${JSON.stringify(expectedStage)} below=${t.stageBelow}`);
      } else skip('5c stage line', boundWhy);
      await page.screenshot({ path: path.join(OUT, 'lenses-missions-expanded.png') });
    }

    // 7 — switch to Projects, reload, still Projects
    await page.click('.sidebar-lens button[data-lens="projects"]');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#project-list .project-row');
    {
      const lens = await page.getAttribute('#sidebar', 'data-lens');
      check('7 lens persists across a reload', lens === 'projects' && await hasBox('#project-list') && !(await hasBox('#mission-list')), `data-lens=${lens}`);
    }
    // 8 — filter + ≡ equal height and centre; panel right-aligned
    const ctlGeom = () => page.evaluate(() => {
      const s = document.getElementById('conductor-filter-select').getBoundingClientRect();
      const t = document.getElementById('sidebar-overflow-toggle').getBoundingClientRect();
      return { sh: s.height, th: t.height, sc: s.top + s.height / 2, tc: t.top + t.height / 2 };
    });
    {
      const g = await ctlGeom();
      await page.click('#sidebar-overflow-toggle');
      const p = await page.evaluate(() => {
        const panel = document.getElementById('sidebar-overflow-panel').getBoundingClientRect();
        const t = document.getElementById('sidebar-overflow-toggle').getBoundingClientRect();
        return { panelRight: panel.right, toggleRight: t.right, visible: panel.height > 0 };
      });
      await page.click('#sidebar-overflow-toggle');
      check('8 filter select and ≡ share height and centre; panel opens right-aligned',
        Math.abs(g.sh - g.th) <= 0.5 && Math.abs(g.sc - g.tc) <= 0.5 && p.visible && Math.abs(p.panelRight - p.toggleRight) <= 0.5,
        JSON.stringify({ ...g, ...p }));
    }
    // 9 — no .conduct row
    {
      const bad = await page.evaluate(() => ({
        conductLi: document.querySelectorAll('.project-conduct').length,
        conductName: [...document.querySelectorAll('.project-name')].some(n => n.textContent.includes('Conduct')),
      }));
      check('9 no .conduct row in the Projects lens', bad.conductLi === 0 && !bad.conductName, JSON.stringify(bad));
    }
    // Open the uipass Worktrees group and let the lazy lists land.
    await page.evaluate(() => { for (const d of document.querySelectorAll('#project-list details.worktree-group')) d.open = true; });
    const rowSel = (sid) => page.evaluate((s) => {
      const r = [...document.querySelectorAll('#project-list .session-row')].find(x => x.title.split('\n')[0] === s);
      if (!r) return null;
      const cs = getComputedStyle(r);
      return { bw: cs.borderLeftWidth, bc: cs.borderLeftColor, owned: r.classList.contains('owned') };
    }, sid);
    const headSel = (wt) => page.evaluate((w) => {
      const h = [...document.querySelectorAll('#project-list .worktree-row')].find(x => x.querySelector('.worktree-name')?.textContent === w);
      return h ? getComputedStyle(h).boxShadow : null;
    }, wt);
    await waitFor(async () => (await rowSel(handSid)) && (await rowSel(aSolo.sessionId)) && (await rowSel(aMain.sessionId)) && (await rowSel(bMain.sessionId)));
    // 10 — ownership colour
    {
      const solo = await headSel('solo-a');
      const soloRow = await rowSel(aSolo.sessionId);
      check('10a single-owner worktree: head in A\'s colour, its rows unbarred',
        solo.includes(colA) && soloRow.bw === '0px', `head=${solo} row=${JSON.stringify(soloRow)}`);
      const mixed = await headSel('mixed');
      const ra = await rowSel(aMixed.sessionId), rb = await rowSel(bMixed.sessionId), rh = await rowSel(handSid);
      check('10b mixed worktree: head plain, A and B rows in their own colours, hand-spawned unbarred',
        mixed === 'none' && ra.bw === '3px' && ra.bc === colA && rb.bw === '3px' && rb.bc === colB && rh.bw === '0px',
        JSON.stringify({ mixed, ra, rb, rh }));
      // Session ids are random, so A and B share a hue slot one run in twelve;
      // then 10b cannot tell their bars apart, and says so.
      if (colA === colB) skip('10b distinct per-conductor colours', `A and B hashed to the same slot (${colA}) this run — rerun to discriminate`);
      const rm = await rowSel(aMain.sessionId);
      check('10c main-checkout A worker carries A\'s bar', rm.bw === '3px' && rm.bc === colA, JSON.stringify(rm));
    }
    await page.screenshot({ path: path.join(OUT, 'lenses-projects.png') });
    // 12 — selected style (click a session row: owned main-checkout A worker)
    {
      await page.evaluate((s) => {
        [...document.querySelectorAll('#project-list .session-row')].find(x => x.title.split('\n')[0] === s).click();
      }, aMain.sessionId);
      await waitFor(() => page.evaluate((s) => [...document.querySelectorAll('#project-list .session-row')]
        .find(x => x.title.split('\n')[0] === s)?.classList.contains('active'), aMain.sessionId));
      const sel = await page.evaluate((s) => {
        const toRgb = (v) => { const i = document.createElement('i'); i.style.color = v; document.body.appendChild(i); const c = getComputedStyle(i).color; i.remove(); return c; };
        const root = getComputedStyle(document.documentElement);
        const r = [...document.querySelectorAll('#project-list .session-row')].find(x => x.title.split('\n')[0] === s);
        const cs = getComputedStyle(r);
        return {
          outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}`, bg: cs.backgroundColor,
          weight: getComputedStyle(r.querySelector('.session-preview')).fontWeight, bw: cs.borderLeftWidth,
          muted: toRgb(root.getPropertyValue('--muted').trim()), panel2: toRgb(root.getPropertyValue('--panel-2').trim()),
        };
      }, aMain.sessionId);
      check('12 selected row: 1px muted outline, panel-2 fill, bold, owner bar kept',
        sel.outline === `1px solid ${sel.muted}` && sel.bg === sel.panel2 && sel.weight === '700' && sel.bw === '3px', JSON.stringify(sel));
    }
    // 11 — filter to A
    {
      await page.selectOption('#conductor-filter-select', aSid);
      await sleep(200);
      const f = await page.evaluate(() => ({
        projects: [...document.querySelectorAll('#project-list .project-name')].map(n => n.textContent),
        wtOpen: document.querySelector('#project-list details.worktree-group')?.open ?? null,
        filter: getComputedStyle(document.getElementById('conductor-filter')).boxShadow,
      }));
      const mixed = await headSel('mixed');
      check('11 filter to A: other projects hidden, mixed kept uncoloured, Worktrees open, filter root in A\'s colour',
        !f.projects.includes('uiother') && f.projects.includes('uipass') && mixed === 'none' && f.wtOpen === true && f.filter.includes(colA),
        JSON.stringify({ ...f, mixed }));
      await page.screenshot({ path: path.join(OUT, 'lenses-projects-filtered.png') });
      await page.selectOption('#conductor-filter-select', '');
    }
    // 10d — a worker killed loses its bar
    {
      const before = await rowSel(bMain.sessionId);
      await api('DELETE', `/api/instances/${bMain.id}`);
      const archivedRow = await waitFor(async () => ((await api('GET', '/api/projects/uipass/sessions?includeArchived=1')).body ?? [])
        .find(r => r.sessionId === bMain.sessionId && r.archived) ?? false, { timeout: 10000 }).catch(() => null);
      const after = await waitFor(async () => ((await rowSel(bMain.sessionId)) === null ? 'gone' : false), { timeout: 10000 })
        .catch(async () => rowSel(bMain.sessionId));
      check('10d a killed conducted (temp) worker leaves no bar: archived, its row leaves the Sessions list',
        bMain.temp === true && before?.bw === '3px' && !!archivedRow && after === 'gone',
        `temp=${bMain.temp} before=${JSON.stringify(before)} archived=${!!archivedRow} after=${JSON.stringify(after)}`);
    }
    // 10e — the worktree head's bar clears IN PLACE when its only owner's
    // worker goes (the head node persists; the worktree still exists).
    {
      const node = await page.evaluateHandle(() => [...document.querySelectorAll('#project-list .worktree-row')]
        .find(x => x.querySelector('.worktree-name')?.textContent === 'solo-a'));
      const before = await node.evaluate(n => getComputedStyle(n).boxShadow);
      await api('DELETE', `/api/instances/${aSolo.id}`);
      const after = await waitFor(() => node.evaluate(n => (n.isConnected && getComputedStyle(n).boxShadow === 'none') ? 'none' : false), { timeout: 10000 })
        .catch(() => node.evaluate(n => `${n.isConnected ? 'connected' : 'detached'} ${getComputedStyle(n).boxShadow}`));
      check('10e solo-a head loses its bar in place when its worker is killed',
        before.includes(colA) && after === 'none', `before=${before} after=${after}`);
    }
    // 6 — kill B: Inactive (1), faded bar; B's live worker keeps colour B
    {
      await api('DELETE', `/api/instances/${b.id}`);
      await page.click('.sidebar-lens button[data-lens="missions"]');
      const collapsed = await waitFor(() => page.evaluate(() => {
        const det = document.querySelector('#mission-list details.mission-inactive');
        return det ? { summary: det.querySelector('summary').textContent, open: det.open } : false;
      }), { timeout: 10000 }).catch(() => null);
      await page.click('#mission-list details.mission-inactive > summary');
      await waitFor(() => page.evaluate((s) => !!document.querySelector(`#mission-list .mission-inactive-list [data-key="mission:${s}"]`), bSid), { timeout: 10000 }).catch(() => {});
      const r = await page.evaluate((s) => {
        const m = document.querySelector(`#mission-list .mission-inactive-list [data-key="mission:${s}"]`);
        return { inactive: m?.classList.contains('inactive') ?? false, shadow: m ? getComputedStyle(m).boxShadow : null };
      }, bSid);
      check('6a killed B moves under a collapsed Inactive (1) with a faded bar',
        collapsed?.summary === 'Inactive (1)' && collapsed.open === false
          && r.inactive && !!r.shadow && r.shadow !== 'none' && !r.shadow.includes(colB),
        JSON.stringify({ collapsed, ...r }));
      await page.click('.sidebar-lens button[data-lens="projects"]');
      const rb = await rowSel(bMixed.sessionId);
      const liveOwner = (await insts()).find(i => i.sessionId === bMixed.sessionId)?.ownerSessionId ?? null;
      if (liveOwner === bSid) {
        check('6b B\'s live worker keeps colour B in the Projects lens', rb && rb.bw === '3px' && rb.bc === colB, JSON.stringify(rb));
      } else {
        // The server clears ownership when the root dies: the bar must follow it.
        check('6b B\'s worker bar follows the server-reported owner', rb && (liveOwner ? rb.bc === (await colourOf(liveOwner)) : rb.bw === '0px'),
          `server ownerSessionId=${liveOwner} row=${JSON.stringify(rb)}`);
      }
    }
    // 6c — the default path: an exited TEMP conductor is archived, and is then
    // in no Missions group; it is found in Settings → Archived.
    {
      await api('DELETE', `/api/instances/${c.id}`);
      const archived = await waitFor(async () => {
        const rows = (await api('GET', '/api/projects/.conduct/sessions?includeArchived=1')).body ?? [];
        return rows.find(r => r.sessionId === cSid && r.archived) ?? false;
      }, { timeout: 10000 }).catch(() => null);
      const plain = ((await api('GET', '/api/projects/.conduct/sessions')).body ?? []).some(x => x.sessionId === cSid);
      const inArchived = ((await api('GET', '/api/archived')).body?.groups ?? []).some(g => g.sessions.some(x => x.sessionId === cSid));
      // Reload so the sidebar's .conduct fetch is known to follow the archive:
      // waiting for C's row to vanish could pass in the gap between the
      // instance dropping and the projects refresh.
      await page.reload({ waitUntil: 'networkidle' });
      await page.click('.sidebar-lens button[data-lens="missions"]');
      await page.click('#mission-list details.mission-inactive > summary');
      // B is a disk row only: its inactive row proves the listing landed.
      const r = await waitFor(() => page.evaluate(([b, cs]) => {
        if (!document.querySelector(`#mission-list .mission-inactive-list [data-key="mission:${b}"]`)) return false;
        return { summary: document.querySelector('#mission-list details.mission-inactive > summary').textContent,
          cShown: !!document.querySelector(`#mission-list [data-key="mission:${cs}"]`) };
      }, [bSid, cSid]), { timeout: 10000 }).catch(() => null);
      check('6c an exited temp conductor (archived on exit) is in no Missions group',
        !!archived && !plain && inArchived && !!r && !r.cShown && r.summary === 'Inactive (1)',
        `server row archived=${!!archived} in plain listing=${plain} in /api/archived=${inArchived} sidebar=${JSON.stringify(r)}`);
    }
    // 13 — session view unchanged
    {
      await page.click('.sidebar-lens button[data-lens="missions"]');
      await page.click(`${mission(aSid)} .mission-title`);
      const v = await waitFor(() => page.evaluate(() => {
        const t = document.getElementById('instance-title')?.textContent ?? '';
        const panel = document.getElementById('subagent-panel');
        const shown = panel && !panel.hidden && panel.getBoundingClientRect().height > 0;
        return t.includes('Alpha mission') && shown ? { t, text: panel.textContent.replace(/\s+/g, ' ').slice(0, 160) } : false;
      }), { timeout: 10000 }).catch(() => null);
      check('13 opening A sets #instance-title and shows #subagent-panel', !!v, JSON.stringify(v));
    }
  });

  // Phone pass: a fresh profile at 390×844 with the drawer open, Projects lens.
  await withPage(async (page) => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.click('#sidebar-toggle');
    await page.click('.sidebar-lens button[data-lens="projects"]');
    await sleep(300);
    const g = await page.evaluate(() => {
      const s = document.getElementById('conductor-filter-select').getBoundingClientRect();
      const t = document.getElementById('sidebar-overflow-toggle').getBoundingClientRect();
      const body = document.getElementById('sidebar-body');
      return { sh: s.height, th: t.height, sc: s.top + s.height / 2, tc: t.top + t.height / 2, sw: body.scrollWidth, cw: body.clientWidth };
    });
    check('phone: filter and ≡ share height and centre; no sideways overflow',
      Math.abs(g.sh - g.th) <= 0.5 && Math.abs(g.sc - g.tc) <= 0.5 && g.sw <= g.cw, JSON.stringify(g));
    await page.screenshot({ path: path.join(OUT, 'lenses-phone.png') });
  }, { viewport: { width: 390, height: 844 } });
} finally {
  await orch.close();
}

const failed = results.filter(r => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks green`);
process.exit(failed.length ? 1 : 0);
