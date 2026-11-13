// The resume banner's REST surface (/api/resume-notices, docs/protocol.md).
import { apiFetch } from '@shared/http';

export type ResumeKind = 'restart' | 'unclean';
export type ResumeNotice = { sessionId: string; kind: ResumeKind; project: string | null; title: string | null };

export const fetchResumeNotices = () => apiFetch<{ notices: ResumeNotice[] }>('/api/resume-notices');
export const postContinue = () => apiFetch<{ sent: string[]; dropped: string[] }>('/api/resume-notices/continue', { method: 'POST' });
export const postDismiss = () => apiFetch<{ dismissed: number }>('/api/resume-notices/dismiss', { method: 'POST' });
