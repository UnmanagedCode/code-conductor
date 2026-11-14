import express from 'express';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import type { Server } from 'node:http';
import type { WebSocketServer } from 'ws';
import { attachmentsDir } from '../worktrees.ts';
import { resolveBacking } from '../sessionLineage.ts';
import { httpError } from '../httpError.ts';
import { isSessionId } from '../identifiers.ts';
import { errCode } from '../../shared/basics.ts';

// Session ids are user-supplied path params on many routes; this is the single
// allow-list + rejection (400 "invalid sessionId") they all share.
export function assertValidSid(sid: string): void {
  if (!isSessionId(sid)) {
    throw httpError(400, 'invalid sessionId');
  }
}

// An optional integer query parameter of the paging routes; 400 when present
// and not an integer.
export function intQueryParam(v: unknown, name: string): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n)) throw httpError(400, `${name} must be an integer`);
  return n;
}

// THE shared read for every session-scoped route's `:sessionId` path param.
//
// A client only ever holds the PUBLIC id, while the transcript jsonl and its
// segment's archived flag are keyed to a BACKING id. Session-level facts
// (title, summaries) resolve any id form inside the session store, so only the
// transcript reads and the segment flags need `backing`.
//
// `sid` stays the caller's id (that is what the response echoes and what the
// client keeps using); `backing` is for the filesystem and the segment flags.
// Naming a SEGMENT directly resolves to that segment, so an archived row stays
// individually addressable, and an unknown id passes through unchanged (the
// lineage base case).
export async function sidParam(raw: unknown): Promise<{ sid: string; backing: string }> {
  const sid = String(raw || '');
  assertValidSid(sid);
  return { sid, backing: await resolveBacking(sid) };
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8', md: 'text/markdown; charset=utf-8',
};

// Stream attachment `filename` of a project / worktree (attachmentsDir). 400 for
// anything but a plain basename (the path-traversal guard), 404 when absent.
export async function sendAttachment(res: express.Response, project: string, worktreeName: string | null, filename: unknown): Promise<void> {
  const raw = String(filename || '');
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..') || raw !== path.basename(raw)) {
    throw httpError(400, 'invalid attachment filename');
  }
  const abs = path.join(attachmentsDir(project, worktreeName), raw);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try { stat = await fs.stat(abs); }
  catch (e) {
    if (errCode(e) === 'ENOENT') throw httpError(404, 'attachment not found');
    throw e;
  }
  if (!stat.isFile()) throw httpError(404, 'attachment not found');
  const ext = (raw.split('.').pop() || '').toLowerCase();
  res.setHeader('Content-Type', CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  // Cache aggressively — the filename includes a timestamp so it's effectively
  // immutable. Saves a re-fetch on every conversation re-render.
  res.setHeader('Cache-Control', 'private, max-age=3600');
  createReadStream(abs).pipe(res);
}

// express types req.body as `any`; every JSON body read routes through here so
// fields arrive as `unknown` and each handler narrows them with its existing
// runtime guards (or a callee-side validation). A non-object body yields {} —
// destructuring it gives the same undefined fields the original
// `req.body ?? {}` produced for the absent-body case.
export function jsonBody(req: express.Request): Record<string, unknown> {
  const b: unknown = req.body;
  if (b == null || typeof b !== 'object' || Array.isArray(b)) return {};
  return b as Record<string, unknown>;
}

// The shared mutable handle server.ts populates with the http server + wss once
// they exist (routes read them at request time, after build).
export interface ServerCtx {
  server?: Server | null;
  wss?: WebSocketServer | null;
}
