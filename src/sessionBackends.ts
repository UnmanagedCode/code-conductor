// Sidecar JSON store mapping each session spawned through a SUBSTITUTION
// backend (a registry row with a launch `template` — see modelVersions.ts
// MANAGED_BACKENDS) to the backend id plus the full, EXACT model id it was
// launched with (`deepseek-v4-flash:cloud`, `gpt-5.6-sol[1m]`). The fields the
// jsonl can't carry (backend, model, persisted here): which backend ran the
// session, and the model id in full — the inner CLI records `message.model`
// lossily (`:tag` and any terminal `[…]` build tag dropped), so the jsonl value
// can't rebuild `<template> --model <key>` on resume. This store is the
// authority for both.
//
// `contextWindowTokens` is the session's last known capacity, recorded so a
// resume can still size the ctx bar after the model's custom-model row is
// DELETED. It is a fallback only — live registry resolution wins whenever it
// succeeds, so a corrected window takes effect on the next resume.
//
// A `null` model means backend-known but model-unknown (a legacy entry, or a
// mark with no model); resume falls back to the jsonl for those. Sessions on the
// identity `claude` backend store nothing (absence = 'claude'). Single global
// file `<store>/session-backends.json`, map-shaped
// (`{sessions:{sid:{backend,model,contextWindowTokens?}}}`); atomic writes +
// cross-process lock, mirroring `conductedSessions.ts`.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { orchStoreRoot } from './projects.ts';
import { withLock } from './storeLock.ts';

export interface SessionBackendRecord {
  backend: string;
  model: string | null;
  contextWindowTokens: number | null;
}

// The `code` on a thrown Node error (e.g. 'ENOENT'), or undefined — the
// narrowing point for error-code checks (catch variables are `unknown` under
// strict). Duplicated from storeLock.ts: it's four lines, and importing it
// across modules would couple two stores for one helper.
function errCode(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function backendsFile(): string {
  return path.join(orchStoreRoot(), 'session-backends.json');
}

// Parse the persisted `{sessions:{sid:record}}` map, keeping only well-formed
// records. The raw JSON is an untyped on-disk boundary, so this is where the
// shape is validated rather than trusted.
function parseMap(obj: unknown): Map<string, SessionBackendRecord> {
  const out = new Map<string, SessionBackendRecord>();
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return out;
  const sessions = (obj as { sessions?: unknown }).sessions;
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) return out;
  for (const [sid, rec] of Object.entries(sessions as Record<string, unknown>)) {
    if (typeof sid !== 'string' || !sid) continue;
    if (typeof rec !== 'object' || rec === null) continue;
    const r = rec as { backend?: unknown; model?: unknown; contextWindowTokens?: unknown };
    if (typeof r.backend !== 'string' || !r.backend) continue;
    out.set(sid, {
      backend: r.backend,
      model: typeof r.model === 'string' && r.model ? r.model : null,
      contextWindowTokens: typeof r.contextWindowTokens === 'number' && Number.isFinite(r.contextWindowTokens)
        ? r.contextWindowTokens
        : null,
    });
  }
  return out;
}

export async function loadAll(): Promise<Map<string, SessionBackendRecord>> {
  try {
    const raw = await fs.readFile(backendsFile(), 'utf8');
    return parseMap(JSON.parse(raw));
  } catch (e) {
    if (errCode(e) === 'ENOENT') return new Map();
    console.warn(`sessionBackends: failed to read ${backendsFile()}: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  }
}

export async function hasSessionBackend(sessionId: string | undefined): Promise<boolean> {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const map = await loadAll();
  return map.has(sessionId);
}

// One read serving both the backend id and the model, so the resume path
// doesn't load the store twice. Returns null for a session with no record
// (i.e. a plain `claude` session). `model` is the tagged launch model, or null
// when unknown — resume then falls back to the jsonl.
export async function getSessionBackend(sessionId: string | undefined): Promise<SessionBackendRecord | null> {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const map = await loadAll();
  return map.get(sessionId) ?? null;
}

// Strict re-read inside a mutation (under the lock): throws on I/O / corrupt
// JSON rather than returning empty, so a failed read never overwrites the store.
async function loadStrict(): Promise<Map<string, SessionBackendRecord>> {
  try {
    const raw = await fs.readFile(backendsFile(), 'utf8');
    return parseMap(JSON.parse(raw));
  } catch (e) {
    if (errCode(e) === 'ENOENT') return new Map();
    throw e;
  }
}

let writeChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => {});
  return next;
}

async function writeMap(map: Map<string, SessionBackendRecord>): Promise<void> {
  const file = backendsFile();
  if (map.size === 0) {
    try { await fs.unlink(file); } catch (e) { if (errCode(e) !== 'ENOENT') throw e; }
    return;
  }
  await fs.mkdir(orchStoreRoot(), { recursive: true });
  const sessions: Record<string, SessionBackendRecord> = {};
  for (const [sid, rec] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) sessions[sid] = rec;
  const obj = { sessions };
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await fs.rename(tmp, file);
}

// Upsert the session's backend id + exact launch model + last known capacity.
// Called on every spawn/resume, so a legacy null-model entry self-heals the
// first time the session relaunches with a real model. Idempotent: skips the
// write when the record already matches.
export function markSessionBackend(
  sessionId: string | undefined,
  backend: string | undefined,
  model: string | null = null,
  contextWindowTokens: number | null = null,
): Promise<boolean> {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    if (typeof backend !== 'string' || !backend) return false;
    const value: SessionBackendRecord = {
      backend,
      model: typeof model === 'string' && model ? model : null,
      contextWindowTokens: typeof contextWindowTokens === 'number' && Number.isFinite(contextWindowTokens)
        ? contextWindowTokens
        : null,
    };
    return withLock(backendsFile(), async () => {
      const map = await loadStrict();
      const cur = map.get(sessionId);
      if (cur && cur.backend === value.backend && cur.model === value.model
          && cur.contextWindowTokens === value.contextWindowTokens) return true;
      map.set(sessionId, value);
      await writeMap(map);
      return true;
    });
  });
}

export function unmarkSessionBackend(sessionId: string | undefined): Promise<boolean> {
  return serialize(async () => {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    return withLock(backendsFile(), async () => {
      const map = await loadStrict();
      if (!map.has(sessionId)) return false;
      map.delete(sessionId);
      await writeMap(map);
      return true;
    });
  });
}
