// The single home for the shared placement logic (usePlacement + PlacementFields):
// the System list and its registry note, the Target dropdown with its placeholder
// and Other…, the target notes and refusals, late listing answers, this machine
// asking nothing, and the capability gate. The New-project and Add-project dialog
// tests only guard each dialog's wiring to it; a change to the placement adds its
// tests here, never a copy in a dialog's file.
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@shared/capabilities', () => ({
  loadCapabilities: vi.fn(async () => ({ remoteSystems: true, voice: true, fuseUnion: true })),
  capabilities: vi.fn(() => null),
}));

import { capabilities, loadCapabilities } from '@shared/capabilities';
import { PlacementFields, usePlacement } from './placement';
import { held, routeFetch, type RouteAnswer } from '@/test/routeFetch';
import { chooseOption, selectOptions } from '@/test/radixSelect';
import { SYSTEMS, chooseSystem, chooseTarget, findTargetSelect, findTargetText, listedAnswer, system } from '@/test/placementDriver';

const LAB = { id: 'lab', label: 'Lab', managed: false, launch: ['ssh', 'lab'] };

function Harness() {
  const p = usePlacement();
  React.useEffect(() => { void p.loadSystems(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <PlacementFields p={p} idPrefix="t" />
      <output data-placement>{JSON.stringify({ system: p.chosenSystem, remote: p.chosenRemote, error: p.remoteError() })}</output>
    </>
  );
}

const placement = () => JSON.parse(document.querySelector('[data-placement]')!.textContent!);
/** Lets pending fetches and their state updates land. */
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
/** The note under the System row, or under the Target row. */
const systemNote = async () => (await system()).closest('.grid')!.querySelector('p')?.textContent ?? null;
const targetNote = () => screen.getByText('Target', { selector: 'label' }).closest('.grid')!.querySelector('p')?.textContent ?? null;
const remotesAsks = (calls: { url: string }[]) => calls.filter((c) => c.url.endsWith('/remotes')).map((c) => decodeURIComponent(c.url.split('/')[3]));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.mocked(capabilities).mockImplementation(() => null);
});

describe('placement', () => {
  // The offered systems are this machine plus each row with a provider command, a non-managed row reads "<label> (<id>)", and the start is local.
  it('offers this machine plus every system with a provider command, labelled by name and id, and starts on this machine', async () => {
    routeFetch({ 'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }) });
    render(<Harness />);
    await system();
    await flush();
    expect(selectOptions(await system())).toEqual(['This machine', 'Prod box (prod-box)']);
    expect(placement().system).toBeNull();
  });

  // A registry that cannot be read names its status and leaves only this machine.
  it('an unreadable registry says so and offers only this machine', async () => {
    routeFetch({ 'GET /api/settings/systems': () => ({ status: 500, json: {} }) });
    render(<Harness />);
    await system();
    await flush();
    expect(await systemNote()).toMatch(/^Could not read the systems registry \(HTTP 500\)/);
    expect(selectOptions(await system())).toEqual(['This machine']);
  });

  // A readable registry puts no note under the System row.
  it('a registry holding only this machine shows no note', async () => {
    const calls = routeFetch({ 'GET /api/settings/systems': () => ({ json: { systems: [SYSTEMS[0]] } }) });
    render(<Harness />);
    await system();
    await flush();
    expect(calls.some((c) => c.url === '/api/settings/systems')).toBe(true);
    expect(await systemNote()).toBeNull();
  });

  // A not-enumerable system gets a free-text Target, no dropdown, and no note once its answer lands.
  it('a system that does not list its targets keeps the free-text Target field, with no note', async () => {
    routeFetch({
      'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }),
      'GET /api/systems/prod-box/remotes': () => ({ json: { state: 'not-enumerable' } }),
    });
    render(<Harness />);
    await flush();
    await chooseSystem('Prod box (prod-box)');
    await findTargetText();
    await waitFor(() => expect(targetNote()).toBeNull());
    expect(screen.queryByRole('combobox', { name: 'Target' })).toBeNull();
    expect(placement().system).toBe('prod-box');
  });

  // A listed system's dropdown is the placeholder, its ids in order, then Other…, with no free text and no note; a picked id is the target.
  it('a system that lists its targets offers them between the placeholder and Other…, and a picked one is the target', async () => {
    routeFetch({
      'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }),
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a', 'ctr-b']),
    });
    render(<Harness />);
    await flush();
    await chooseSystem('Prod box (prod-box)');
    await findTargetSelect();
    expect(targetNote()).toBeNull();
    expect(chooseOption(await findTargetSelect(), 'ctr-b')).toEqual(['Choose a target…', 'ctr-a', 'ctr-b', 'Other…']);
    expect(screen.queryByRole('textbox', { name: 'Target' })).toBeNull();
    expect(placement().remote).toBe('ctr-b');
  });

  // A failed listing keeps free text, offers no dropdown, and quotes the provider's reason in the note.
  it('a failed listing keeps free text and names the reason', async () => {
    routeFetch({
      'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }),
      'GET /api/systems/prod-box/remotes': () => ({ json: { state: 'failed', reason: 'the provider is down' } }),
    });
    render(<Harness />);
    await flush();
    await chooseSystem('Prod box (prod-box)');
    await findTargetText();
    await waitFor(() => expect(targetNote()).toBe("Could not list the targets of system 'prod-box' (the provider is down). Type one."));
    expect(screen.queryByRole('combobox', { name: 'Target' })).toBeNull();
  });

  // A non-OK listing response is a failure named by its HTTP status, with free text kept and no dropdown.
  it('a non-OK listing response keeps free text and names its status', async () => {
    routeFetch({
      'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }),
      'GET /api/systems/prod-box/remotes': () => ({ status: 503, json: {} }),
    });
    render(<Harness />);
    await flush();
    await chooseSystem('Prod box (prod-box)');
    await findTargetText();
    await waitFor(() => expect(targetNote()).toContain('(HTTP 503)'));
    expect(screen.queryByRole('combobox', { name: 'Target' })).toBeNull();
  });

  // An empty listing still offers the dropdown (placeholder and Other… only) and says the system lists nothing.
  it('an empty listing offers only the placeholder and Other…, and says so', async () => {
    routeFetch({
      'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }),
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', []),
    });
    render(<Harness />);
    await flush();
    await chooseSystem('Prod box (prod-box)');
    await findTargetSelect();
    expect(targetNote()).toMatch(/lists no configured targets right now/);
    expect(selectOptions(await findTargetSelect())).toEqual(['Choose a target…', 'Other…']);
  });

  // Other… adds the free-text field beside the dropdown, and the trimmed text is the target.
  it('Other… reveals the free-text field, and the trimmed text is the target', async () => {
    routeFetch({
      'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }),
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a']),
    });
    render(<Harness />);
    await flush();
    await chooseSystem('Prod box (prod-box)');
    await findTargetSelect();
    expect(screen.queryByRole('textbox', { name: 'Target' })).toBeNull();
    await chooseTarget('Other…');
    fireEvent.change(await findTargetText(), { target: { value: ' ctr-z ' } });
    expect(placement().remote).toBe('ctr-z');
  });

  // With targets listed, the untouched placeholder and a blank Other… are each a refusal naming the system.
  it('with the targets listed, the placeholder and a blank Other… are each refused, naming the system', async () => {
    routeFetch({
      'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }),
      'GET /api/systems/prod-box/remotes': () => listedAnswer('prod-box', ['ctr-a']),
    });
    render(<Harness />);
    await flush();
    await chooseSystem('Prod box (prod-box)');
    await findTargetSelect();
    expect(placement().error).toBe("Choose a target on 'prod-box'. It lists the targets it is configured for.");
    await chooseTarget('Other…');
    expect(placement().error).toBe("Type a target for 'prod-box', or pick a listed one.");
  });

  // Free text that trims to nothing names no target.
  it('a blank free-text target is no target', async () => {
    routeFetch({
      'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }),
      'GET /api/systems/prod-box/remotes': () => ({ json: { state: 'not-enumerable' } }),
    });
    render(<Harness />);
    await flush();
    await chooseSystem('Prod box (prod-box)');
    fireEvent.change(await findTargetText(), { target: { value: '   ' } });
    expect(placement()).toEqual({ system: 'prod-box', remote: null, error: null });
  });

  // A listing answer is dropped once a later ask has been made, even for the same system.
  it('an older answer for a system chosen again is dropped', async () => {
    const first = held<RouteAnswer>();
    let n = 0;
    routeFetch({
      'GET /api/settings/systems': () => ({ json: { systems: [...SYSTEMS, LAB] } }),
      'GET /api/systems/prod-box/remotes': () => (++n === 1 ? first.answer : listedAnswer('prod-box', ['fresh-1'])),
      'GET /api/systems/lab/remotes': () => ({ json: { state: 'not-enumerable' } }),
    });
    render(<Harness />);
    await flush();
    await chooseSystem('Prod box (prod-box)');
    await chooseSystem('Lab (lab)');
    await chooseSystem('Prod box (prod-box)');
    await findTargetSelect();
    await act(async () => { first.release(listedAnswer('prod-box', ['stale-1'])); });
    await flush();
    expect(selectOptions(await findTargetSelect())).toEqual(['Choose a target…', 'fresh-1', 'Other…']);
  });

  // A listing answer for a system that is no longer chosen changes nothing.
  it('an answer for a system no longer chosen is dropped', async () => {
    const first = held<RouteAnswer>();
    routeFetch({
      'GET /api/settings/systems': () => ({ json: { systems: [...SYSTEMS, LAB] } }),
      'GET /api/systems/prod-box/remotes': () => first.answer,
      'GET /api/systems/lab/remotes': () => ({ json: { state: 'not-enumerable' } }),
    });
    render(<Harness />);
    await flush();
    await chooseSystem('Prod box (prod-box)');
    await chooseSystem('Lab (lab)');
    await findTargetText();
    await act(async () => { first.release(listedAnswer('prod-box', ['x'])); });
    await flush();
    expect(screen.queryByRole('combobox', { name: 'Target' })).toBeNull();
    expect(placement()).toEqual({ system: 'lab', remote: null, error: null });
  });

  // Only a chosen system is asked for its targets; this machine never is, and it shows no Target field.
  it('this machine asks for no targets, on open or when chosen back', async () => {
    const calls = routeFetch({
      'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }),
      'GET /api/systems/prod-box/remotes': () => ({ json: { state: 'not-enumerable' } }),
    });
    render(<Harness />);
    await flush();
    expect(remotesAsks(calls)).toEqual([]);
    await chooseSystem('Prod box (prod-box)');
    await findTargetText();
    await chooseSystem('This machine');
    await flush();
    expect(remotesAsks(calls)).toEqual(['prod-box']);
    expect(screen.queryByText('Target', { selector: 'label' })).toBeNull();
    expect(placement().system).toBeNull();
  });

  // No System row is offered before the capabilities say remote systems exist.
  it('renders no System row until the capabilities answer, and none at all without remote systems, never reading the registry', async () => {
    const caps = held<{ remoteSystems: boolean; voice: boolean; fuseUnion: boolean }>();
    vi.mocked(loadCapabilities).mockReturnValueOnce(caps.answer as any);
    const calls = routeFetch({ 'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }) });
    render(<Harness />);
    await flush();
    expect(screen.queryByRole('combobox', { name: 'System' })).toBeNull();
    await act(async () => { caps.release({ remoteSystems: false, voice: true, fuseUnion: true }); });
    await flush();
    expect(screen.queryByRole('combobox', { name: 'System' })).toBeNull();
    expect(calls.some((c) => c.url === '/api/settings/systems')).toBe(false);
  });

  // Capabilities already known to lack remote systems decide the first paint: no System row, before any reload answers.
  it('with the capabilities already known to lack remote systems, the first paint has no System row and the registry is not read', () => {
    vi.mocked(capabilities).mockImplementation(() => ({ remoteSystems: false, voice: true, fuseUnion: true }));
    vi.mocked(loadCapabilities).mockReturnValueOnce(held().answer as any);
    const calls = routeFetch({ 'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }) });
    render(<Harness />);
    expect(capabilities).toHaveBeenCalled();
    expect(screen.queryByRole('combobox', { name: 'System' })).toBeNull();
    expect(calls.some((c) => c.url === '/api/settings/systems')).toBe(false);
  });

  // Capabilities already known to offer remote systems put the System row on the first paint, without waiting for a reload.
  it('with the capabilities already known to offer remote systems, the System row is there on first paint, before they are reloaded', () => {
    vi.mocked(capabilities).mockImplementation(() => ({ remoteSystems: true, voice: true, fuseUnion: true }));
    vi.mocked(loadCapabilities).mockReturnValueOnce(held().answer as any);
    routeFetch({ 'GET /api/settings/systems': () => ({ json: { systems: SYSTEMS } }) });
    render(<Harness />);
    expect(loadCapabilities).toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'System' })).toBeTruthy();
  });
});
