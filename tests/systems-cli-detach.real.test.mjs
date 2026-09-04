// THE CLI-CONTRACT REGRESSION TEST, part 4: what happens to a redirected
// `Bash` at its tool timeout, and what actually closes the forwarder's socket.
// Skipped by default — opt in with `RUN_CLI_CONTRACT=1`.
//
//   RUN_CLI_CONTRACT=1 node tests/run.mjs tests/systems-cli-*.real.test.mjs
//
// cc's ONLY cancellation channel for a redirected command is the forwarder's
// HTTP request being aborted (`src/routes.ts`, `res.on('close')` guarded by
// `!res.writableEnded`). Nothing else can stop the far side. So what this file
// pins is each half of that channel, and each failure mode is silent:
//   * a tool timeout starts ABORTING     → cc kills a command the CLI has just
//     instead of detaching                 handed the worker a live background
//                                          task and a path to its output, so
//                                          the pointer is dead — the defect
//                                          card 2026-0305 removed, and the
//                                          reason cc's ceiling sits ABOVE the
//                                          documented tool max.
//   * an interrupt or a `TaskStop`       → the channel is gone and every
//     stops closing the socket             cancelled command runs on to
//                                          `DEFAULT_COMMAND_TIMEOUT_MS`
//                                          (src/systems/providerShell.ts) on
//                                          the far side, while cc reports it
//                                          cancelled.
//
// Harness, and the two rules every case follows: tests/cliContractCase.mjs.
// Measured for card 2026-0310 §1 at CLI 2.1.258.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allow, claudeSession, fixture, forwardServer, hookServer, settingsJSON, t,
} from './cliContractCase.mjs';

const FORWARDER = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'systems', 'bashForwarder.ts',
);

// The argv `src/systems/toolRedirect.ts` `#redirectBash` builds, in the shape it
// builds it: `node <forwarder> --url <url> -- <original command>`, every element
// POSIX single-quoted because the CLI runs the rewritten string through a shell.
// Mirrored rather than imported — the subject here is the CLI's treatment of the
// process, and cc's own quoting is pinned by tests/systems-tool-redirect.test.mjs.
const q = (s) => `'${s.split("'").join(`'\\''`)}'`;
const forwarderArgv = (url, command) => [
  q(process.execPath), q(FORWARDER), '--url', q(url), '--', q(command),
].join(' ');

// The rewriting hook, shaped as cc's: it replaces the Bash command with the
// forwarder argv and pins the tool timeout, so the case does not depend on what
// timeout the model happened to emit. Everything else is allowed untouched.
// `onPre` is called with the envelope BEFORE the tool runs, which is the only
// exact timestamp for "the worker issued this call" — polling for it from the
// test body races the effect it is timing.
const rewriteHook = (url, timeout, onPre = () => {}) => hookServer((e) => {
  if (e.hook_event_name !== 'PreToolUse') return {};
  onPre(e);
  if (e.tool_name !== 'Bash') return allow();
  return allow({ ...e.tool_input, command: forwarderArgv(url, 'probe: the command cc would run'), timeout });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PINS: at a plain tool timeout the CLI DETACHES the forwarder — it does not
// kill it — so no abort reaches cc and the socket stays open and WRITABLE while
// the command runs on; and the worker's own `TaskStop` on the background task
// the CLI handed it does close that socket, which is how a detached command is
// reclaimed before cc's ceiling. The negative and its positive control in one
// run, because a negative on its own cannot tell "nothing closed it" from
// "nothing was listening".
t('a tool timeout detaches without aborting the forwarder, and TaskStop aborts it', async () => {
  const { dir, clean } = await fixture();
  const fwd = await forwardServer();
  let stopAt = 0;
  const hooks = await rewriteHook(fwd.url, 5000, (e) => {
    if (e.tool_name === 'TaskStop' && !stopAt) stopAt = Date.now();
  });
  const cli = claudeSession({ cwd: dir, settings: settingsJSON(hooks.url, { pre: ['Bash', 'TaskStop'] }) });
  try {
    cli.prompt('Run the Bash command `probe` with a timeout of 5000 milliseconds, '
      + 'then tell me exactly what the tool told you about it.');

    // The CLI's own report of the call, not the model's account of it.
    const result = await cli.waitFor(
      (f) => f.type === 'user' && f.message?.content?.some?.(
        (b) => b.type === 'tool_result' && /background/i.test(JSON.stringify(b.content ?? '')),
      ), 40_000);
    const text = JSON.stringify(result.message.content);
    const taskId = /\(ID:\s*([A-Za-z0-9_-]+)\)/.exec(text)?.[1];
    assert.equal(typeof taskId, 'string', `the tool result names a background task id: ${text.slice(0, 400)}`);

    assert.equal(hooks.of('PreToolUse', 'Bash').length, 1, 'exactly one Bash call to reason about');
    assert.equal(fwd.state.command, 'probe: the command cc would run',
      'the REWRITTEN forwarder ran and posted the original command');
    // The forced tool timeout is what got us here: at the CLI's 120s default
    // this result could not have arrived yet. Mechanical, and it needs no
    // agreement from the model about what timeout it asked for.
    assert.ok(Date.now() - fwd.state.postAt < 30_000, 'the detach came from the short tool timeout');

    // THE NEGATIVE, AND WHAT MAKES IT NON-VACUOUS: frames must still be
    // ACCEPTED across the window, not merely un-refused. A socket that had been
    // torn down without emitting `close` would fail here rather than pass.
    //
    // TEETH. To watch this assertion go red, send SIGTERM to the forwarder's
    // process GROUP at this point (`process.kill(-pgid)`) — what the CLI's own
    // kill does, measured landing the abort in ~20ms. Do NOT instead signal the
    // pids `pgrep -f bashForwarder` returns: the CLI runs the forwarder from a
    // wrapper shell that carries the forwarder's path in its OWN argv, so the
    // pattern matches wrappers as well as the node process, and stale wrappers
    // from earlier runs alongside them. SIGTERM to a wrapper alone ORPHANS the
    // node process, which holds this socket open — a stimulus that leaves the
    // case passing while proving nothing.
    const writesAtDetach = fwd.state.writes;
    await sleep(8_000);
    assert.equal(fwd.state.closeWasAbort, null, 'no abort reached cc across the window past the tool timeout');
    assert.ok(fwd.state.writes > writesAtDetach + 8, 'and the socket kept ACCEPTING frames throughout');

    // THE POSITIVE CONTROL, over cc's other documented kill trigger.
    cli.prompt(`Use the TaskStop tool to stop the background task with id ${taskId}. Do nothing else.`);
    for (let i = 0; i < 250 && fwd.state.closeWasAbort === null; i++) await sleep(100);
    assert.equal(hooks.of('PreToolUse', 'TaskStop').length >= 1, true, 'the worker did stop the task');
    assert.equal(fwd.state.closeWasAbort, true, 'stopping the background task ABORTED the forwarder request');
    // The model chooses WHEN to stop, so the bounded interval is the CLI's, not
    // the model's: the stop reached the CLI at `stopAt`, and the abort followed.
    assert.ok(fwd.state.closeAt - stopAt < 5_000, 'and the abort followed the stop, not the ceiling');
  } finally {
    cli.kill(); fwd.finish(0); await hooks.close(); await fwd.close(); await clean();
  }
});

// PINS: cc's own interrupt channel — the `control_request {subtype:'interrupt'}`
// src/instances.ts sends — still kills the forwarder, closing the socket as a
// CLIENT DISCONNECT (`writableEnded === false`) rather than as a normal end.
// The tool timeout is pinned high so the interrupt is the only stimulus in play.
t('an interrupt kills the forwarder and aborts its in-flight request', async () => {
  const { dir, clean } = await fixture();
  const fwd = await forwardServer();
  const hooks = await rewriteHook(fwd.url, 120_000);
  const cli = claudeSession({ cwd: dir, settings: settingsJSON(hooks.url, { pre: ['Bash'] }) });
  try {
    cli.prompt('Run the Bash command `probe` and report its output.');
    for (let i = 0; i < 600 && !fwd.state.postAt; i++) await sleep(100);
    assert.ok(fwd.state.postAt, 'the forwarder reached cc');
    // Long enough that the request is unambiguously in flight and streaming.
    await sleep(2_000);
    assert.equal(fwd.state.closeWasAbort, null, 'and is still open when the interrupt is sent');

    cli.interrupt();
    for (let i = 0; i < 200 && fwd.state.closeWasAbort === null; i++) await sleep(100);
    assert.equal(fwd.state.closeWasAbort, true,
      'the interrupt closed the socket as a disconnect — cc\'s cancellation signal');
  } finally {
    cli.kill(); fwd.finish(0); await hooks.close(); await fwd.close(); await clean();
  }
});
