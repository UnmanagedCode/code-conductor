// THE `remoteListing` FALLBACK: cc never sends `listRemotes` to a provider that
// does not advertise it (docs/systems-protocol.md §2, §2.2).
//
// While cc has no sender at all, that holds by construction, and a recording
// provider would see no `listRemotes` frame whether or not it advertised the
// capability — a wire test could not tell the gate from the absence of any
// caller. So the pin is STRUCTURAL: no cc source outside the frame's own
// definition and the reference provider's handler names the frame's type. It
// reds on ANY sender, gated or not, which is what hands the first one its
// obligation: a capability-gated recording test in the shape of
// tests/systems-mirror-fallback.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['src', 'public'];
// The frame's definition and the reference provider's handler: the two places
// the type legitimately appears without anything in cc sending it.
const OWNERS = ['src/systems/protocol.ts', 'src/systems/referenceProvider.ts'];
// The type as a string literal in any quoting, which is how a frame is built.
const LITERAL = /(['"`])listRemotes\1/;

async function filesUnder(rel) {
  const out = [];
  for (const e of await fs.readdir(path.join(REPO, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...await filesUnder(r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

async function filesNamingTheFrame() {
  const files = (await Promise.all(ROOTS.map(filesUnder))).flat();
  const hits = [];
  for (const f of files) {
    if (LITERAL.test(await fs.readFile(path.join(REPO, f), 'utf8'))) hits.push(f);
  }
  return { scanned: files, hits: hits.sort() };
}

// PINS the absent-behaviour of `remoteListing`: no cc caller sends the frame.
//
// The positive control comes first: the scan must find the literal in exactly
// the two owners, so a scanner that read nothing, or a literal that drifted,
// reds here rather than reading clean.
test('no cc source sends listRemotes — the remoteListing fallback until a sender exists', async () => {
  const { scanned, hits } = await filesNamingTheFrame();
  assert.ok(scanned.some(f => f.startsWith('public/')) && scanned.some(f => f.startsWith('src/')),
    'the scan walked both roots');
  assert.deepEqual(hits.filter(f => OWNERS.includes(f)), [...OWNERS].sort(),
    'positive control: the scan finds the frame type where it is defined and handled');
  const senders = hits.filter(f => !OWNERS.includes(f));
  assert.deepEqual(senders, [],
    `cc now names the 'listRemotes' frame in ${senders.join(', ')}. A cc sender must be gated on `
    + '`remoteListing`: add a capability-gated recording test in the shape of '
    + 'tests/systems-mirror-fallback.test.mjs — a provider that does not advertise remoteListing, '
    + 'driven through the new caller, receives no listRemotes frame on the wire — and name it in '
    + "the remoteListing row's Fallback test cell in docs/systems-protocol.md §2, in place of this test.");
});
