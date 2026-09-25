// Client calls on an archived session, made by Settings → Archived.

export function archivedSessionUrl(project, worktreeName, sessionId, suffix) {
  const enc = encodeURIComponent;
  const base = worktreeName
    ? `/api/projects/${enc(project)}/worktrees/${enc(worktreeName)}/sessions/${enc(sessionId)}`
    : `/api/projects/${enc(project)}/sessions/${enc(sessionId)}`;
  return base + suffix;
}

// Un-archive a session: it returns to the sidebar and leaves GET /api/archived.
// Throws with the server's error on refusal.
export async function restoreArchivedSession({ project, worktreeName, sessionId }) {
  const r = await fetch(archivedSessionUrl(project, worktreeName, sessionId, '/restore'), { method: 'POST' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
}
