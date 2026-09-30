// Per-session pending attachments and dictation delivery: the real
// attachComposer wired to the real installComposerDrafts in happy-dom (shared
// harness: tests/composerDraftsHarness.mjs).
//
// Invariants pinned (one per test title below):
//   - pending attachments are per session: switching away hides them, switching
//     back restores them with previews and remove buttons
//   - a send ships only the showing session's attachments and clears only its list
//   - removing a chip in one session leaves the other's list and preview alone
//   - a switch never revokes a preview; send and prefill do
//   - a list dropped at a null-session switch has its previews revoked and does not reappear
//   - a multi-file add still encoding at a switch finishes into its own session
//   - a dictation is delivered to the session it was started in, never the one showing
//   - a dictation started with no session showing lands in the box, not nowhere
//   - a dictation into a non-empty box inserts exactly one separating space
//   - switching to the session already showing keeps its attachments
//   - restoring attachments neither writes the text draft nor takes focus

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fakeStorage, fakeTimers, setupPage, newStore, stored, keyOf, fakeFile, gate, settle, NOW,
} from './composerDraftsHarness.mjs';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const png = (name, bytes = [1, 2, 3]) => fakeFile({ name, type: 'image/png', bytes });
const TOO_BIG = 10 * 1024 * 1024 + 1;

test('pending attachments are per session: switching away hides them, switching back restores them with previews and remove buttons', async (t) => {
  const p = await setupPage({ store: newStore(fakeStorage()), t });
  p.drafts.switchTo('A');
  await p.paste([png('a1.png'), fakeFile({ name: 'huge.bin', type: 'application/octet-stream', size: TOO_BIG })]);
  assert.equal(p.chips().length, 2);

  p.drafts.switchTo('B');
  assert.equal(p.chips().length, 0, 'B must not show A\'s chips');
  assert.equal(p.chipsHidden, true);
  assert.ok(!p.sendBtn.classList.contains('mode-send'), 'B has no content, so it is not in send mode');

  p.drafts.switchTo('A');
  const chips = p.chips();
  assert.equal(chips.length, 2);
  assert.equal(chips[0].src, 'blob:fake/1');
  assert.equal(chips[1].error, true);
  assert.ok(p.sendBtn.classList.contains('mode-send') && !p.sendBtn.disabled, 'an attachment alone is sendable');

  p.removeChip(0);
  assert.equal(p.chips().length, 1, 'the restored remove button works');
  assert.deepEqual(p.errors, []);
});

test('send ships only the showing session\'s attachments and clears only its list', async (t) => {
  const p = await setupPage({ store: newStore(fakeStorage()), t });
  p.drafts.switchTo('A');
  await p.paste([png('a1.png', [1])]);
  p.drafts.switchTo('B');
  await p.paste([png('b1.png', [2])]);
  p.type('hi');
  p.submit();
  assert.deepEqual(p.submits[0].attachments.map((a) => a.name), ['b1.png'], 'B ships only its own attachment');
  assert.equal(p.chips().length, 0);

  p.drafts.switchTo('A');
  assert.deepEqual(p.chips().map((c) => c.meta.split(' ')[0]), ['a1.png'], 'A\'s chip survived B\'s send');
  p.submit();
  assert.deepEqual(p.submits[1].attachments, [{ name: 'a1.png', mediaType: 'image/png', dataBase64: b64([1]) }]);
  assert.deepEqual(p.errors, []);
});

test('removing a chip in one session leaves the other\'s list and preview alone', async (t) => {
  const p = await setupPage({ store: newStore(fakeStorage()), t });
  p.drafts.switchTo('A');
  await p.paste([png('a1.png')]);
  p.drafts.switchTo('B');
  await p.paste([png('b1.png')]);
  p.removeChip(0);
  assert.deepEqual(p.revoked, ['blob:fake/2'], 'only B\'s preview is revoked');
  assert.equal(p.chips().length, 0);

  p.drafts.switchTo('A');
  assert.deepEqual(p.chips().map((c) => c.src), ['blob:fake/1'], 'A keeps its chip and preview');
  p.drafts.switchTo('B');
  assert.equal(p.chips().length, 0, 'B restores empty');
  assert.deepEqual(p.errors, []);
});

test('a switch never revokes a preview; send and prefill do', async (t) => {
  await t.test('switching away and back leaves every preview live, whichever session the other holds', async (st) => {
    const p = await setupPage({ store: newStore(fakeStorage()), t: st });
    p.drafts.switchTo('A');
    await p.paste([png('a1.png')]);
    p.drafts.switchTo('B');
    await p.paste([png('b1.png')]);
    p.drafts.switchTo('A');
    assert.deepEqual(p.revoked, []);
    assert.deepEqual(p.chips().map((c) => c.src), ['blob:fake/1']);
    assert.deepEqual(p.errors, []);
  });
  await t.test('send revokes the sent list', async (st) => {
    const p = await setupPage({ store: newStore(fakeStorage()), t: st });
    p.drafts.switchTo('A');
    await p.paste([png('a1.png')]);
    p.submit();
    assert.deepEqual(p.revoked, ['blob:fake/1']);
    assert.deepEqual(p.errors, []);
  });
  await t.test('prefill revokes the showing list', async (st) => {
    const p = await setupPage({ store: newStore(fakeStorage()), t: st });
    p.drafts.switchTo('A');
    await p.paste([png('a1.png')]);
    p.composer.prefill('rewound');
    assert.deepEqual(p.revoked, ['blob:fake/1']);
    assert.equal(p.chips().length, 0);
    assert.deepEqual(p.errors, []);
  });
});

test('a list dropped at a null-session switch has its previews revoked and does not reappear', async (t) => {
  const p = await setupPage({ store: newStore(fakeStorage()), t });
  // No session has been shown yet (an instance is still spawning), so the
  // composer is enabled with nothing to keep the list under.
  await p.paste([png('early.png')]);
  assert.equal(p.chips().length, 1);
  p.drafts.switchTo('A');
  assert.equal(p.chips().length, 0, 'the dropped list is not handed to the next session');
  assert.deepEqual(p.revoked, ['blob:fake/1']);
  p.drafts.switchTo('B');
  p.drafts.switchTo('A');
  p.drafts.switchTo(null);
  assert.equal(p.chips().length, 0, 'and it does not come back');
  assert.deepEqual(p.revoked, ['blob:fake/1'], 'revoked once');
  assert.deepEqual(p.errors, []);
});

test('a multi-file add still encoding when the user switches finishes into its own session', async (t) => {
  const p = await setupPage({ store: newStore(fakeStorage()), t });
  p.drafts.switchTo('A');
  const g = gate();
  await p.paste([
    fakeFile({ name: 'one.png', bytes: [1], gate: g.promise }),
    fakeFile({ name: 'two.png', bytes: [2], gate: g.promise }),
  ]);
  p.drafts.switchTo('B');
  g.open();
  await settle();
  assert.equal(p.chips().length, 0, 'the second file must not land in B');
  p.type('for B');
  p.submit();
  assert.deepEqual(p.submits[0].attachments, []);

  p.drafts.switchTo('A');
  assert.equal(p.chips().length, 2);
  p.submit();
  assert.deepEqual(p.submits[1].attachments.map((a) => [a.name, a.dataBase64]),
    [['one.png', b64([1])], ['two.png', b64([2])]]);
  assert.deepEqual(p.errors, []);
});

test('a dictation is delivered to the session it was started in, never to the one showing', async (t) => {
  await t.test('switched while transcribing', async (st) => {
    const storage = fakeStorage();
    const p = await setupPage({ store: newStore(storage), dictation: 'deferred', t: st });
    p.drafts.switchTo('A');
    p.composer.setMicAvailable(true);
    await p.tap(); // start recording
    await p.tap(); // stop -> transcribing
    p.type('earlier');
    p.drafts.switchTo('B');
    p.type('B text');
    await p.releaseTranscript('spoken');

    assert.equal(p.textarea.value, 'B text');
    p.submit();
    assert.equal(p.submits[0].text, 'B text', 'B must not inherit the <transcribed> flag');
    assert.deepEqual(stored(storage, 'A'), { text: 'earlier spoken', transcribed: true, savedAt: NOW });

    p.drafts.switchTo('A');
    assert.equal(p.textarea.value, 'earlier spoken');
    p.submit();
    assert.equal(p.submits[1].text, '<transcribed>\nearlier spoken');
    assert.deepEqual(p.errors, []);
  });
  await t.test('switched while still recording, stopped from the other session', async (st) => {
    const storage = fakeStorage();
    const p = await setupPage({ store: newStore(storage), dictation: 'deferred', t: st });
    p.drafts.switchTo('A');
    p.composer.setMicAvailable(true);
    await p.tap(); // start recording in A
    p.drafts.switchTo('B');
    await p.tap(); // stop from B
    await p.releaseTranscript('spoken');
    assert.equal(p.textarea.value, '');
    assert.deepEqual(stored(storage, 'A'), { text: 'spoken', transcribed: true, savedAt: NOW });
    assert.deepEqual(p.errors, []);
  });
  await t.test('back in the starting session before it lands: inserted once, into the box', async (st) => {
    const storage = fakeStorage();
    const p = await setupPage({ store: newStore(storage), dictation: 'deferred', t: st });
    p.drafts.switchTo('A');
    p.composer.setMicAvailable(true);
    await p.tap();
    await p.tap();
    p.drafts.switchTo('B');
    p.drafts.switchTo('A');
    await p.releaseTranscript('spoken');
    assert.equal(p.textarea.value, 'spoken', 'not also appended to the stored draft');
    p.submit();
    assert.equal(p.submits[0].text, '<transcribed>\nspoken');
    assert.deepEqual(p.errors, []);
  });
});

test('a dictation started with no session showing lands in the box, not nowhere', async (t) => {
  const p = await setupPage({ store: newStore(fakeStorage()), dictation: 'deferred', t });
  p.composer.setMicAvailable(true);
  await p.tap();
  await p.tap();
  p.drafts.switchTo('A');
  await p.releaseTranscript('spoken');
  assert.equal(p.textarea.value, 'spoken');
  p.submit();
  assert.equal(p.submits[0].text, '<transcribed>\nspoken');
  assert.deepEqual(p.errors, []);
});

test('a dictation into a non-empty box inserts exactly one separating space', async (t) => {
  const dictateAfter = async (typed, st) => {
    const p = await setupPage({ store: newStore(fakeStorage()), dictation: 'deferred', t: st });
    p.drafts.switchTo('A');
    p.composer.setMicAvailable(true);
    await p.tap();
    await p.tap();
    p.type(typed);
    await p.releaseTranscript('spoken');
    assert.deepEqual(p.errors, []);
    return p.textarea.value;
  };
  await t.test('after a word', async (st) => assert.equal(await dictateAfter('hello', st), 'hello spoken'));
  await t.test('after existing whitespace', async (st) => assert.equal(await dictateAfter('hello ', st), 'hello spoken'));
});

test('switching to the session already showing keeps its attachments', async (t) => {
  const p = await setupPage({ store: newStore(fakeStorage()), t });
  p.drafts.switchTo('A');
  await p.paste([png('a1.png')]);
  p.drafts.switchTo('A');
  assert.deepEqual(p.chips().map((c) => c.src), ['blob:fake/1']);
  assert.deepEqual(p.revoked, []);
  assert.deepEqual(p.errors, []);
});

test('restoring attachments neither writes the text draft nor takes focus', async (t) => {
  const storage = fakeStorage();
  const ops = [];
  const spied = {
    ...storage,
    setItem: (k, v) => { ops.push(['setItem', k]); storage.setItem(k, v); },
    removeItem: (k) => { ops.push(['removeItem', k]); storage.removeItem(k); },
  };
  const clock = { t: NOW };
  const timers = fakeTimers();
  const p = await setupPage({ store: newStore(spied, () => clock.t), timers, t });
  p.drafts.switchTo('A');
  p.type('kept text');
  await p.paste([png('a1.png')]);
  p.drafts.switchTo('B');
  assert.equal(p.chips().length, 0);
  const savedRaw = storage.map.get(keyOf('A'));
  assert.equal(JSON.parse(savedRaw).text, 'kept text', 'leaving A stored its text');

  clock.t += 60_000;
  ops.length = 0;
  p.drafts.switchTo('A');
  assert.equal(p.chips().length, 1);
  assert.equal(p.textarea.value, 'kept text');
  assert.deepEqual(ops.filter(([, k]) => k === keyOf('A')), [], 'no write or removal touches A\'s draft');
  assert.equal(storage.map.get(keyOf('A')), savedRaw, 'savedAt is unchanged');
  assert.equal(timers.count, 0, 'no save is scheduled');
  assert.ok(p.window.document.activeElement !== p.textarea);
  assert.deepEqual(p.errors, []);
});
