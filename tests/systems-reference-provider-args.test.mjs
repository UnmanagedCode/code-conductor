// The reference provider's LAUNCH SURFACE, where it differs from what any
// provider owes the protocol: what it refuses before it ever answers a hello.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { REMOTE_ID_MAX } from '../src/systems/protocol.ts';
import { parseProviderArgs } from '../src/systems/referenceProvider.ts';
import { REFERENCE_PROVIDER } from './referenceProviderHarness.mjs';

// PINS: a `--remote` id that `remoteIdDefect` rejects is refused at launch, so
// the `remoteList` this provider answers with exactly its `--remote` ids
// (docs/systems-protocol.md §2.2) can never carry an id cc would refuse.
// One subtest per defect, so each reds on its own; `empty` is refused earlier
// by the `<id>=<root>` shape check and is not this guard's case.
test('the reference provider refuses at launch a --remote id cc would refuse', async (t) => {
  for (const [defect, id] of [
    ['invalid-char', 'a b'],
    ['invalid-char', 'tab\there'],
    ['too-long', 'x'.repeat(REMOTE_ID_MAX + 1)],
  ]) {
    await t.test(`${defect}: ${JSON.stringify(id).slice(0, 24)}`, () => {
      assert.throws(() => parseProviderArgs(['--remote', `${id}=/`]),
        (e) => e.message.includes(JSON.stringify(id)) && e.message.includes(`(${defect})`));
    });
  }
  await t.test('a valid id, at the length limit and carrying `.`, `_` and `-`, is served', () => {
    const id = `c.t_r-${'x'.repeat(REMOTE_ID_MAX - 6)}`;
    assert.deepEqual([...parseProviderArgs(['--remote', `${id}=/`]).remotes.keys()], [id]);
  });
  // The refusal is the PROCESS's, not only the parser's: it exits before
  // writing a single frame, so no handshake ever advertises the bad id.
  await t.test('the launched process exits non-zero with no frame on stdout', () => {
    const r = spawnSync(process.execPath, [REFERENCE_PROVIDER, '--remote', 'a b=/'], {
      input: '', encoding: 'utf8', timeout: 20_000,
    });
    assert.notEqual(r.status, 0, `exited ${r.status} (signal ${r.signal})`);
    assert.equal(r.stdout, '', 'nothing reached the wire');
    assert.match(r.stderr, /--remote id "a b" is not a valid remoteId \(invalid-char\)/);
  });
});

// PINS: `--no-pty` is parsed — the provider then never advertises `pty`, and
// never probes for one — and the default is to offer terminals.
test('the reference provider takes --no-pty, and offers terminals by default', () => {
  assert.equal(parseProviderArgs([]).pty, true);
  assert.equal(parseProviderArgs(['--no-pty']).pty, false);
  assert.equal(parseProviderArgs(['--no-process-group-signal', '--no-pty']).processGroupSignal, false);
  const r = spawnSync(process.execPath, [REFERENCE_PROVIDER, '--no-pty'], {
    input: '{"type":"hello","protocol":1,"client":"t"}\n', encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.split('\n')[0]).capabilities.pty, false, 'the hello advertises no pty');
});
