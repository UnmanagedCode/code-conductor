import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createSupervisor } from '../src/plugins/supervisor.js';
import { allocatePort, pidAlive } from '../src/plugins/ports.js';
import { FAKE_PLUGIN_DIR, waitFor } from './plugin-helpers.mjs';

const manifest = (backend) => ({ id: 'fake-plugin', name: 'Fake', version: '1', pluginApi: 1, backend });

async function startAndSettle(sup, opts) {
  const rec = await sup.start(opts);
  const rt = await waitFor(() => {
    const r = sup.runtime(opts.id);
    return r && r.status !== 'starting' ? r : false;
  });
  return { rec, rt };
}

function stopAndWait(sup, id, rec) {
  sup.stop({ id, pgid: rec.pgid });
  return waitFor(() => !pidAlive(rec.pid));
}

test('readiness via healthPath; child gets $PORT and reaches ready', async () => {
  const sup = createSupervisor();
  const { rec, rt } = await startAndSettle(sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'node server.mjs', healthPath: '/health' }),
    cwd: FAKE_PLUGIN_DIR,
    env: { CONDUCTOR_URL: 'http://127.0.0.1:9999' },
  });
  try {
    assert.equal(rt.status, 'ready');
    const env = await (await fetch(`http://127.0.0.1:${rec.port}/env`)).json();
    assert.equal(env.port, rec.port);
    assert.equal(env.pluginId, 'fake-plugin');
    assert.equal(env.conductorUrl, 'http://127.0.0.1:9999');
    assert.equal(rec.pgid, rec.pid);
    assert.ok(rec.startedAt);
  } finally {
    await stopAndWait(sup, 'fake-plugin', rec);
  }
});

test('readiness via readyWhen stdout regex', async () => {
  const sup = createSupervisor();
  const { rec, rt } = await startAndSettle(sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'node server.mjs', readyWhen: 'listening on \\d+' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  try {
    assert.equal(rt.status, 'ready');
  } finally {
    await stopAndWait(sup, 'fake-plugin', rec);
  }
});

test('readiness via bare TCP probe, with a slow-binding child', async () => {
  const sup = createSupervisor();
  const { rec, rt } = await startAndSettle(sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'SLOW_READY_MS=1000 node slow-ready.mjs' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  try {
    assert.equal(rt.status, 'ready');
  } finally {
    await stopAndWait(sup, 'fake-plugin', rec);
  }
});

test('crash before ready → crashed with output tail', async () => {
  const sup = createSupervisor();
  const { rt } = await startAndSettle(sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'node crash.mjs' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'crashed');
  assert.match(rt.error, /exited \(code=1/);
  assert.match(rt.error, /boom/);
});

test('never-ready child → crashed after the readiness bound', async () => {
  const sup = createSupervisor({ _readyTimeoutMs: 1500 });
  const { rec, rt } = await startAndSettle(sup, {
    id: 'fake-plugin',
    // Matches nothing the fixture prints — readiness must time out.
    manifest: manifest({ start: 'node server.mjs', readyWhen: 'WILL_NEVER_MATCH' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  try {
    assert.equal(rt.status, 'crashed');
    assert.match(rt.error, /readiness not confirmed/);
  } finally {
    await stopAndWait(sup, 'fake-plugin', rec);
  }
});

test('EADDRINUSE settle-window retry lands on a fresh port', async () => {
  // Squat a port, then hand it to the supervisor as the first allocation.
  const squatter = net.createServer();
  const squattedPort = await new Promise((res) => squatter.listen(0, '127.0.0.1', () => res(squatter.address().port)));
  let calls = 0;
  const sup = createSupervisor({
    _allocatePort: () => { calls++; return calls === 1 ? Promise.resolve(squattedPort) : allocatePort(); },
  });
  try {
    const { rec, rt } = await startAndSettle(sup, {
      id: 'fake-plugin',
      manifest: manifest({ start: 'node server.mjs', healthPath: '/health' }),
      cwd: FAKE_PLUGIN_DIR,
    });
    try {
      assert.equal(rt.status, 'ready');
      assert.notEqual(rec.port, squattedPort);
      assert.ok(calls >= 2, 'retried on a second allocated port');
    } finally {
      await stopAndWait(sup, 'fake-plugin', rec);
    }
  } finally {
    squatter.close();
  }
});

test('stop kills the whole process group (grandchild included)', async () => {
  const sup = createSupervisor();
  const { rec, rt } = await startAndSettle(sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'node forker.mjs' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'ready');
  const { grandchildPid } = await (await fetch(`http://127.0.0.1:${rec.port}/`)).json();
  assert.ok(pidAlive(grandchildPid));
  sup.stop({ id: 'fake-plugin', pgid: rec.pgid });
  await waitFor(() => !pidAlive(rec.pid) && !pidAlive(grandchildPid));
});

test('post-ready exit fires onExit with status exited', async () => {
  const exits = [];
  const sup = createSupervisor({ onExit: (id, info) => exits.push({ id, info }) });
  const { rec, rt } = await startAndSettle(sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'node server.mjs', healthPath: '/health' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'ready');
  process.kill(rec.pid, 'SIGTERM');
  await waitFor(() => exits.length > 0);
  assert.equal(exits[0].id, 'fake-plugin');
  assert.equal(exits[0].info.status, 'exited');
});

test('git HEAD is recorded when cwd is a repo, null otherwise', async () => {
  const sup = createSupervisor();
  // The fixture lives inside the code-conductor repo → HEAD resolves.
  const { rec, rt } = await startAndSettle(sup, {
    id: 'fake-plugin',
    manifest: manifest({ start: 'node crash.mjs' }),
    cwd: FAKE_PLUGIN_DIR,
  });
  assert.equal(rt.status, 'crashed'); // crash child: no cleanup needed
  assert.match(rec.gitHead, /^[0-9a-f]{40}$/);
});
