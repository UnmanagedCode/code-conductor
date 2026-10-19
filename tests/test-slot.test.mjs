// The box-wide test-slot semaphore (tests/testSlot.mjs). Every case runs on its own
// port pair under an env with CC_TEST_SLOT_HELD removed: this suite itself runs
// under a lease, and a nested acquire would otherwise be a no-op.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireTestSlot, resolveSlots, HELD_VAR } from './testSlot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const slotModule = pathToFileURL(path.join(here, 'testSlot.mjs')).href;

const listen = (port) => new Promise((resolve, reject) => {
  const server = net.createServer((s) => s.end('not a slot\n'));
  server.once('error', reject);
  server.listen({ port, host: '127.0.0.1' }, () => resolve(server));
});
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

// A base whose next port is free too.
async function freePair() {
  for (;;) {
    const probe = await listen(0);
    const port = probe.address().port;
    await close(probe);
    try {
      await close(await listen(port + 1));
      return port;
    } catch { /* taken in between: try again */ }
  }
}

function envFor(base, slots) {
  const env = { ...process.env, CC_TEST_SLOT_PORT: String(base), CC_TEST_SLOTS: String(slots) };
  delete env[HELD_VAR];
  return env;
}

// A log sink whose `until(re)` resolves when a line matching re has been written.
function logSink() {
  const lines = [];
  const waiters = [];
  return {
    lines,
    log(line) {
      lines.push(line);
      for (const w of [...waiters]) if (w.re.test(line)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(line); }
    },
    until(re) {
      const hit = lines.find((l) => re.test(l));
      return hit ? Promise.resolve(hit) : new Promise((resolve) => waiters.push({ re, resolve }));
    },
  };
}

test('never more than the configured number of holders; a release admits the next waiter', async () => {
  const base = await freePair();
  const env = envFor(base, 2);
  const a = await acquireTestSlot({ label: 'a', env, log() {} });
  const b = await acquireTestSlot({ label: 'b', env, log() {} });
  const sink = logSink();
  let admitted = false;
  const third = acquireTestSlot({ label: 'c', env, log: sink.log }).then((lease) => { admitted = true; return lease; });
  await sink.until(/waiting/);
  assert.equal(admitted, false);
  await a.release();
  const lease = await third;
  assert.equal(admitted, true);
  await sink.until(/acquired after/);
  await Promise.all([b.release(), lease.release()]);
});

test('a holder that is SIGKILLed frees its slot with no cleanup', async () => {
  const base = await freePair();
  const env = envFor(base, 1);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireTestSlot } from ${JSON.stringify(slotModule)};
     await acquireTestSlot({ label: 'doomed' }); console.log('held'); setInterval(() => {}, 1000);`,
  ], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('holder exited before holding')));
      child.stdout.on('data', (d) => { if (String(d).includes('held')) resolve(); });
    });
    const sink = logSink();
    const waiter = acquireTestSlot({ label: 'waiter', env, log: sink.log });
    await sink.until(/waiting/);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    await (await waiter).release();
  } finally {
    child.kill('SIGKILL');
  }
});

test('a run that already holds a lease never waits and binds nothing', async () => {
  const base = await freePair();
  const env = envFor(base, 1);
  const holder = await acquireTestSlot({ label: 'parent', env, log() {} });
  const nested = await acquireTestSlot({ label: 'child', env: { ...env, ...holder.env }, log() {} });
  assert.deepEqual(nested.env, {});
  await holder.release();
  await close(await listen(base));
});

test('a foreign listener is skipped, and every slot foreign is a loud refusal', async () => {
  const base = await freePair();
  const env = envFor(base, 2);
  const first = await listen(base);
  const sink = logSink();
  const lease = await acquireTestSlot({ label: 'x', env, log: sink.log });
  assert.ok(sink.lines.some((l) => l.includes(String(base))), 'the foreign port is logged');
  const second = await listen(base + 1).catch(() => null);
  assert.equal(second, null, 'the lease took the free slot');
  await lease.release();
  const other = await listen(base + 1);
  await assert.rejects(
    acquireTestSlot({ label: 'y', env, log() {} }),
    (err) => err.message.includes(String(base)) && err.message.includes(String(base + 1)) && err.message.includes('CC_TEST_SLOT_PORT'),
  );
  await Promise.all([close(first), close(other)]);
});

test('a bad knob is refused, an unset one defaults', () => {
  for (const [name, value] of [['CC_TEST_SLOTS', '0'], ['CC_TEST_SLOTS', 'abc'], ['CC_TEST_SLOTS', '1.5'],
    ['CC_TEST_SLOT_PORT', '0'], ['CC_TEST_SLOT_PORT', 'x']]) {
    assert.throws(() => resolveSlots({ [name]: value }), new RegExp(name), `${name}=${value}`);
  }
  assert.equal(resolveSlots({}).slots, 2);
});

test('a waiter names the holder it waits for', async () => {
  const base = await freePair();
  const env = envFor(base, 1);
  const holder = await acquireTestSlot({ label: 'the-holder', env, log() {} });
  const sink = logSink();
  const waiter = acquireTestSlot({ label: 'w', env, log: sink.log });
  const line = await sink.until(/waiting/);
  assert.match(line, /the-holder/);
  assert.ok(line.includes(`pid ${process.pid}`));
  await holder.release();
  await (await waiter).release();
});

test('a stopped holder makes the caller wait and is named as unresponsive, not refused as foreign', async () => {
  const base = await freePair();
  const env = envFor(base, 1);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireTestSlot } from ${JSON.stringify(slotModule)};
     await acquireTestSlot({ label: 'frozen' }); console.log('held'); setInterval(() => {}, 1000);`,
  ], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      child.once('exit', () => reject(new Error('holder exited before holding')));
      child.stdout.on('data', (d) => { if (String(d).includes('held')) resolve(); });
    });
    child.kill('SIGSTOP');
    const sink = logSink();
    const waiter = acquireTestSlot({ label: 'waiter', env, log: sink.log });
    const outcome = waiter.then(() => 'acquired', (err) => `rejected: ${err.message}`);
    const line = await Promise.race([sink.until(/waiting/), outcome]);
    assert.match(line, /waiting/);
    assert.match(line, new RegExp(`port ${base} unresponsive`));
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    await (await waiter).release();
  } finally {
    child.kill('SIGKILL');
  }
});

test('a holder reports how long it has held the slot, not how long it queued', async () => {
  const base = await freePair();
  const env = envFor(base, 1);
  const first = await acquireTestSlot({ label: 'first', env, log() {} });
  const sink = logSink();
  const second = acquireTestSlot({ label: 'queued-first', env, log: sink.log });
  await sink.until(/waiting/);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await first.release();
  const queued = await second;
  const behind = logSink();
  const third = acquireTestSlot({ label: 'third', env, log: behind.log });
  const line = await behind.until(/waiting/);
  assert.match(line, /queued-first .* for [01]s/);
  await queued.release();
  await (await third).release();
});

test('a holder that dies while it is being probed frees the slot instead of being refused as foreign', async () => {
  const base = await freePair();
  const env = envFor(base, 1);
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { acquireTestSlot } from ${JSON.stringify(slotModule)};
     await acquireTestSlot({ label: 'doomed' }); console.log('held'); setInterval(() => {}, 1000);`,
  ], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      child.once('exit', () => reject(new Error('holder exited before holding')));
      child.stdout.on('data', (d) => { if (String(d).includes('held')) resolve(); });
    });
    // Stopped, the holder leaves each probe's connection in its backlog; killing it
    // while one is in flight resets that connection.
    child.kill('SIGSTOP');
    const waiter = acquireTestSlot({ label: 'waiter', env, log() {} });
    const outcome = waiter.then((lease) => lease, (err) => err);
    await new Promise((resolve) => setTimeout(resolve, 2050));
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    const result = await outcome;
    assert.ok(!(result instanceof Error), `refused: ${result?.message}`);
    await result.release();
  } finally {
    child.kill('SIGKILL');
  }
});
